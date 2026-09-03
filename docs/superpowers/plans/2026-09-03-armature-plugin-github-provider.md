# Armature Plugin and GitHub Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable Claude Code plugin whose MCP server drives work items on a GitHub Projects board across many repositories, replacing a slash command that exists today as four diverging copies.

**Architecture:** A stdio MCP server written in TypeScript, bundled by esbuild into a single committed `dist/server.js` that `node` runs with no install step. Pure logic — reference parsing, config resolution, board derivation, ordering policy — lives in small modules tested against recorded API fixtures, with network access confined to one transport module. A `BoardProvider` interface separates that logic from GitHub specifics so later trackers implement a contract rather than fork the code.

**Tech Stack:** TypeScript 5, `@modelcontextprotocol/sdk`, vitest, esbuild, Node 20+ (global `fetch`, no HTTP dependency).

**Spec:** `docs/superpowers/specs/2026-09-03-armature-plugin-design.md`

## Global Constraints

- **Node 20 or later.** The server uses global `fetch`; no HTTP client dependency is added.
- **Runtime dependencies are limited to `@modelcontextprotocol/sdk`.** Everything else is a devDependency.
- **Tool names are tracker-neutral:** `board_*` and `item_*`, never `gh_*`.
- **Every work item reference is fully qualified** — `owner/repo#number`. The server refuses a bare number as input and never emits one as output.
- **No tool takes a pagination parameter.** The server pages to exhaustion internally.
- **Item resolution is rooted at the issue:** `repository(owner,name){issue(number){projectItems}}`. Never a board-wide scan.
- **Writes are verified by read-back.** A mutation that reports success without landing is an error.
- **Fail loud, never partial.** Any condition that could produce a partially-correct answer raises rather than returns.
- **Credentials are never logged**, and never appear in an error message or a mutation log line.
- **Nothing organisation-specific.** No repository name, board number, alias, or convention from the `pixelsonly` organisation may appear in shipped code. Fixtures use `acme/*` and board number `1`.
- **`dist/server.js` is committed** on every change that alters `server/`.
- **Commit style:** Conventional Commits, `type(scope): summary`. Types available: `feat`, `fix`, `perf`, `docs`, `deps`, `refactor`, `chore`, `ci`, `test`.
- **License is MIT**, already present at `LICENSE`.

## File Structure

| File | Responsibility |
|---|---|
| `server/ref.ts` | The `WorkItemRef` type; parsing, formatting, refusing bare numbers |
| `server/config.ts` | Declared config, origin parsing, precedence, zero-config derivation |
| `server/auth.ts` | Credential resolution and its failure messages |
| `server/providers/types.ts` | `BoardProvider` interface and shared item types — the tracker seam |
| `server/providers/github/client.ts` | Authenticated transport, exhaustive pagination, error mapping |
| `server/providers/github/board.ts` | Board survey: repositories, fields, collisions, status inference |
| `server/providers/github/items.ts` | Item read, claim, status transition, creation |
| `server/providers/github/next.ts` | Ordering policy; which item is actionable and why |
| `server/providers/github/aliases.ts` | Shorthand cross-repository references, read from sibling configs |
| `server/providers/github/provider.ts` | `GitHubBoardProvider` — the concrete side of the tracker seam |
| `server/log.ts` | The mutation log |
| `server/index.ts` | MCP server wiring, tool schemas, dry-run switch |
| `tests/contract/provider.contract.ts` | Backend-agnostic guarantees every provider must satisfy |
| `tests/integration/board.integration.test.ts` | Read-only pass over a real board; skipped unless enabled |
| `.claude-plugin/plugin.json` | Plugin manifest, including `mcpServers` |
| `.claude-plugin/marketplace.json` | Self-hosted marketplace entry |
| `commands/armature-next.md` | `/armature-next` |
| `commands/armature-doctor.md` | `/armature-doctor` |
| `skills/working-the-board/SKILL.md` | Workflow and policy — the judgment the server does not hold |

---

### Task 1: Toolchain and skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/ci.yml`, `server/version.ts`, `tests/version.test.ts`

**Interfaces:**
- Consumes: nothing — first task.
- Produces: `npm test`, `npm run build`, `npm run typecheck`; `export const VERSION: string` in `server/version.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { VERSION } from '../server/version.js'

describe('VERSION', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — no `package.json`, no test runner.

- [ ] **Step 3: Create the toolchain**

`package.json`:

```json
{
  "name": "armature",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "node esbuild.config.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["server/**/*.ts", "tests/**/*.ts", "*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
```

`esbuild.config.mjs`:

```js
import { build } from 'esbuild'

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
})
console.log('built dist/server.js')
```

`server/version.ts`:

```ts
export const VERSION = '0.1.0'
```

`release-please-config.json`:

```json
{
  "packages": {
    ".": {
      "release-type": "node",
      "changelog-sections": [
        { "type": "feat", "section": "Features" },
        { "type": "fix", "section": "Bug Fixes" },
        { "type": "perf", "section": "Performance" },
        { "type": "docs", "section": "Documentation" },
        { "type": "deps", "section": "Dependencies" },
        { "type": "refactor", "section": "Refactoring", "hidden": true },
        { "type": "chore", "section": "Chores", "hidden": true },
        { "type": "ci", "section": "CI", "hidden": true },
        { "type": "test", "section": "Tests", "hidden": true }
      ]
    }
  },
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json"
}
```

`.release-please-manifest.json`:

```json
{ ".": "0.1.0" }
```

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 4: Install and run the tests**

Run: `npm install && npm test`
Expected: PASS — one test.

- [ ] **Step 5: Verify the build**

Run: `npm run build && node -e "import('./dist/server.js').then(()=>console.log('loads'))"`
Expected: prints `built dist/server.js` then `loads`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts esbuild.config.mjs \
        release-please-config.json .release-please-manifest.json .github/workflows/ci.yml \
        server/version.ts tests/version.test.ts
git commit -m "chore: scaffold typescript toolchain, vitest, esbuild and ci"
```

---

### Task 2: Work item references

**Files:**
- Create: `server/ref.ts`, `tests/ref.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type WorkItemRef = { owner: string; repo: string; number: number }`; `parseRef(input: string): WorkItemRef`; `formatRef(ref: WorkItemRef): string`; `class BareRefError extends Error`.

This task implements the spec's central guarantee: the `#278` incident becomes inexpressible.

- [ ] **Step 1: Write the failing tests**

Create `tests/ref.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BareRefError, formatRef, parseRef } from '../server/ref.js'

describe('parseRef', () => {
  it('accepts a fully qualified reference', () => {
    expect(parseRef('acme/web#278')).toEqual({ owner: 'acme', repo: 'web', number: 278 })
  })

  it('accepts a repository name containing dots', () => {
    expect(parseRef('acme/site.example#12')).toEqual({
      owner: 'acme', repo: 'site.example', number: 12,
    })
  })

  it('accepts an issue URL', () => {
    expect(parseRef('https://github.com/acme/web/issues/278')).toEqual({
      owner: 'acme', repo: 'web', number: 278,
    })
  })

  // The incident: one number names a different issue in every repository on a board.
  it('refuses a bare number', () => {
    expect(() => parseRef('278')).toThrow(BareRefError)
  })

  it('refuses a hash-prefixed bare number', () => {
    expect(() => parseRef('#278')).toThrow(BareRefError)
  })

  it('explains why a bare number is refused', () => {
    expect(() => parseRef('278')).toThrow(/not unique across repositories/)
  })

  it('refuses a repository with no number', () => {
    expect(() => parseRef('acme/web')).toThrow(BareRefError)
  })
})

describe('formatRef', () => {
  it('round-trips', () => {
    const ref = parseRef('acme/web#278')
    expect(formatRef(ref)).toBe('acme/web#278')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ref.test.ts`
Expected: FAIL — cannot resolve `../server/ref.js`.

- [ ] **Step 3: Implement**

Create `server/ref.ts`:

```ts
export type WorkItemRef = {
  owner: string
  repo: string
  number: number
}

const SEGMENT = '[A-Za-z0-9._-]+'
const SHORTHAND = new RegExp(`^(${SEGMENT})\\/(${SEGMENT})#(\\d+)$`)
const URL_FORM = new RegExp(`^https?:\\/\\/[^/]+\\/(${SEGMENT})\\/(${SEGMENT})\\/issues\\/(\\d+)`)

export class BareRefError extends Error {
  constructor(input: string) {
    super(
      `"${input}" is not a work item reference. Issue numbers are not unique across ` +
        `repositories on a board, so a bare number names a different issue in each. ` +
        `Use owner/repo#number, for example acme/web#278.`,
    )
    this.name = 'BareRefError'
  }
}

export function parseRef(input: string): WorkItemRef {
  const trimmed = input.trim()
  const match = SHORTHAND.exec(trimmed) ?? URL_FORM.exec(trimmed)
  if (!match) throw new BareRefError(trimmed)
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) }
}

export function formatRef(ref: WorkItemRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ref.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/ref.ts tests/ref.test.ts
git commit -m "feat(ref): fully qualified work item references only"
```

---

### Task 3: Configuration resolution

**Files:**
- Create: `server/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type BoardRef = { provider: 'github'; owner: string; number: number }`; `type RepoConfig = { board?: BoardRef; alias?: string; verify?: string[]; commit?: { convention: string; types?: string } }`; `type ResolvedConfig = { repo: { owner: string; name: string }; board: BoardRef; alias?: string; verify: string[]; boardSource: 'env' | 'repo' | 'user' | 'derived' }`; `parseOriginUrl(url: string): { owner: string; name: string }`; `resolveConfig(input: ResolveInput): ResolvedConfig`; `class ConfigError extends Error`.

`resolveConfig` is pure — every input is injected, so no test touches the filesystem.

- [ ] **Step 1: Write the failing tests**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ConfigError, parseOriginUrl, resolveConfig } from '../server/config.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

describe('parseOriginUrl', () => {
  it('parses an ssh remote', () => {
    expect(parseOriginUrl('git@github.com:acme/web.git')).toEqual({ owner: 'acme', name: 'web' })
  })

  it('parses an https remote', () => {
    expect(parseOriginUrl('https://github.com/acme/web.git')).toEqual({ owner: 'acme', name: 'web' })
  })

  it('parses a remote with no .git suffix', () => {
    expect(parseOriginUrl('https://github.com/acme/site.example')).toEqual({
      owner: 'acme', name: 'site.example',
    })
  })

  it('rejects an unparseable remote', () => {
    expect(() => parseOriginUrl('not-a-remote')).toThrow(ConfigError)
  })
})

describe('resolveConfig', () => {
  it('derives the repository from origin', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: {},
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.repo).toEqual({ owner: 'acme', name: 'web' })
  })

  it('prefers the repo config board over the user config board', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: { board: { provider: 'github', owner: 'other', number: 9 } },
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(1)
    expect(c.boardSource).toBe('repo')
  })

  it('prefers the environment over every file', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: {},
      env: { ARMATURE_BOARD: 'github:acme/7' },
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(7)
    expect(c.boardSource).toBe('env')
  })

  it('derives the board when exactly one contains the repository', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: {},
      userConfig: {},
      env: {},
      boardsContainingRepo: [board],
    })
    expect(c.board.number).toBe(1)
    expect(c.boardSource).toBe('derived')
  })

  it('names the candidates when several boards contain the repository', () => {
    expect(() =>
      resolveConfig({
        originUrl: 'git@github.com:acme/web.git',
        repoConfig: {},
        userConfig: {},
        env: {},
        boardsContainingRepo: [board, { provider: 'github', owner: 'acme', number: 4 }],
      }),
    ).toThrow(/acme\/1.*acme\/4/s)
  })

  it('defaults verify to an empty list', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: {},
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.verify).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../server/config.js`.

- [ ] **Step 3: Implement**

Create `server/config.ts`:

```ts
export type BoardRef = { provider: 'github'; owner: string; number: number }

export type RepoConfig = {
  board?: BoardRef
  alias?: string
  verify?: string[]
  commit?: { convention: string; types?: string }
}

export type ResolvedConfig = {
  repo: { owner: string; name: string }
  board: BoardRef
  alias?: string
  verify: string[]
  boardSource: 'env' | 'repo' | 'user' | 'derived'
}

export type ResolveInput = {
  originUrl: string
  repoConfig: RepoConfig
  userConfig: RepoConfig
  env: Record<string, string | undefined>
  boardsContainingRepo: BoardRef[]
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const ORIGIN = /^(?:git@[^:]+:|https?:\/\/[^/]+\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/

export function parseOriginUrl(url: string): { owner: string; name: string } {
  const match = ORIGIN.exec(url.trim())
  if (!match) throw new ConfigError(`Cannot read an owner and repository from origin "${url}".`)
  return { owner: match[1]!, name: match[2]! }
}

function parseEnvBoard(value: string): BoardRef {
  const match = /^github:([A-Za-z0-9._-]+)\/(\d+)$/.exec(value.trim())
  if (!match) {
    throw new ConfigError(`ARMATURE_BOARD must look like "github:owner/number", got "${value}".`)
  }
  return { provider: 'github', owner: match[1]!, number: Number(match[2]!) }
}

export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const repo = parseOriginUrl(input.originUrl)

  let board: BoardRef
  let boardSource: ResolvedConfig['boardSource']

  const envBoard = input.env.ARMATURE_BOARD
  if (envBoard) {
    board = parseEnvBoard(envBoard)
    boardSource = 'env'
  } else if (input.repoConfig.board) {
    board = input.repoConfig.board
    boardSource = 'repo'
  } else if (input.userConfig.board) {
    board = input.userConfig.board
    boardSource = 'user'
  } else if (input.boardsContainingRepo.length === 1) {
    board = input.boardsContainingRepo[0]!
    boardSource = 'derived'
  } else if (input.boardsContainingRepo.length === 0) {
    throw new ConfigError(
      `No board found for ${repo.owner}/${repo.name}. Add .armature.json with a "board" key, ` +
        `or set ARMATURE_BOARD to "github:owner/number".`,
    )
  } else {
    const names = input.boardsContainingRepo.map((b) => `${b.owner}/${b.number}`).join(', ')
    throw new ConfigError(
      `${repo.owner}/${repo.name} appears on several boards (${names}). ` +
        `Name one in .armature.json under "board".`,
    )
  }

  return {
    repo,
    board,
    alias: input.repoConfig.alias,
    verify: input.repoConfig.verify ?? [],
    boardSource,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts tests/config.test.ts
git commit -m "feat(config): derived board discovery with a thin declared overlay"
```

---

### Task 4: Credential resolution

**Files:**
- Create: `server/auth.ts`, `tests/auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type CredentialSource = 'gh-cli' | 'GITHUB_TOKEN' | 'GH_TOKEN'`; `type Credential = { token: string; source: CredentialSource }`; `resolveCredential(deps: CredentialDeps): Promise<Credential>`; `class MissingCredentialError extends Error`.

- [ ] **Step 1: Write the failing tests**

Create `tests/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MissingCredentialError, resolveCredential } from '../server/auth.js'

const noCli = async () => null

describe('resolveCredential', () => {
  it('prefers the GitHub CLI', async () => {
    const c = await resolveCredential({
      readCliToken: async () => 'from-cli',
      env: { GITHUB_TOKEN: 'from-env' },
    })
    expect(c).toEqual({ token: 'from-cli', source: 'gh-cli' })
  })

  it('falls back to GITHUB_TOKEN', async () => {
    const c = await resolveCredential({ readCliToken: noCli, env: { GITHUB_TOKEN: 'a' } })
    expect(c).toEqual({ token: 'a', source: 'GITHUB_TOKEN' })
  })

  it('falls back to GH_TOKEN last', async () => {
    const c = await resolveCredential({ readCliToken: noCli, env: { GH_TOKEN: 'b' } })
    expect(c).toEqual({ token: 'b', source: 'GH_TOKEN' })
  })

  it('ignores an empty environment value', async () => {
    const c = await resolveCredential({ readCliToken: noCli, env: { GITHUB_TOKEN: '  ', GH_TOKEN: 'b' } })
    expect(c.source).toBe('GH_TOKEN')
  })

  it('fails naming the fix when nothing supplies a credential', async () => {
    await expect(resolveCredential({ readCliToken: noCli, env: {} })).rejects.toThrow(
      MissingCredentialError,
    )
  })

  it('names all three sources in the failure', async () => {
    await expect(resolveCredential({ readCliToken: noCli, env: {} })).rejects.toThrow(
      /gh auth login/,
    )
  })

  it('never puts the credential in the error', async () => {
    const err = await resolveCredential({ readCliToken: noCli, env: {} }).catch((e: Error) => e)
    expect((err as Error).message).not.toMatch(/from-cli|from-env/)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — cannot resolve `../server/auth.js`.

- [ ] **Step 3: Implement**

Create `server/auth.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type CredentialSource = 'gh-cli' | 'GITHUB_TOKEN' | 'GH_TOKEN'
export type Credential = { token: string; source: CredentialSource }

export type CredentialDeps = {
  readCliToken: () => Promise<string | null>
  env: Record<string, string | undefined>
}

export class MissingCredentialError extends Error {
  constructor() {
    super(
      'No GitHub credential available. Armature reads one from the GitHub CLI first, then ' +
        'GITHUB_TOKEN, then GH_TOKEN. Run `gh auth login`, or export one of those variables. ' +
        'The credential needs the `repo` and `project` scopes.',
    )
    this.name = 'MissingCredentialError'
  }
}

export async function readCliTokenFromGh(): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['auth', 'token'])
    const value = stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export async function resolveCredential(deps: CredentialDeps): Promise<Credential> {
  const fromCli = await deps.readCliToken()
  if (fromCli && fromCli.trim().length > 0) return { token: fromCli.trim(), source: 'gh-cli' }

  for (const source of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = deps.env[source]
    if (value && value.trim().length > 0) return { token: value.trim(), source }
  }

  throw new MissingCredentialError()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts tests/auth.test.ts
git commit -m "feat(auth): borrow a credential from the github cli, fail naming the fix"
```

---

### Task 5: GitHub transport with exhaustive pagination

**Files:**
- Create: `server/providers/github/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: `Credential` from `server/auth.ts`.
- Produces: `type Fetcher = (url: string, init: RequestInit) => Promise<Response>`; `class GitHubClient { constructor(credential: Credential, fetcher?: Fetcher); graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>; collectAll<T>(query: string, variables: Record<string, unknown>, extract: (data: any) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }): Promise<T[]> }`; `class RateLimitError extends Error`; `class MissingScopeError extends Error`; `class GraphQLError extends Error`.

`collectAll` is the constraint made real: there is no page-size parameter, and it does not stop early.

- [ ] **Step 1: Write the failing tests**

Create `tests/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { GitHubClient, MissingScopeError, RateLimitError } from '../server/providers/github/client.js'

const credential = { token: 'secret-value', source: 'gh-cli' as const }

function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('GitHubClient.collectAll', () => {
  it('follows every page without being asked to', async () => {
    const pages = [
      { data: { items: { nodes: ['a', 'b'], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
      { data: { items: { nodes: ['c'], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ]
    let call = 0
    const client = new GitHubClient(credential, async () => respond(pages[call++]!))

    const all = await client.collectAll<string>('query', {}, (d) => d.items)

    expect(all).toEqual(['a', 'b', 'c'])
    expect(call).toBe(2)
  })

  it('passes the cursor of the previous page', async () => {
    const seen: unknown[] = []
    const pages = [
      { data: { items: { nodes: ['a'], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
      { data: { items: { nodes: ['b'], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ]
    let call = 0
    const client = new GitHubClient(credential, async (_url, init) => {
      seen.push(JSON.parse(String(init.body)).variables.cursor)
      return respond(pages[call++]!)
    })

    await client.collectAll<string>('query', {}, (d) => d.items)

    expect(seen).toEqual([null, 'c1'])
  })
})

describe('GitHubClient error mapping', () => {
  it('raises on a rate limit', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ message: 'API rate limit exceeded' }, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1780000000' },
      }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(RateLimitError)
  })

  it('raises a scope error naming the remedy', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs project scope' }] }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(/gh auth refresh -s project/)
  })

  it('raises rather than returning partial data on a graphql error', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ data: { partial: true }, errors: [{ message: 'boom' }] }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(/boom/)
  })

  it('never puts the credential in an error message', async () => {
    const client = new GitHubClient(credential, async () => respond({ errors: [{ message: 'boom' }] }))
    const err = await client.graphql('query', {}).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('secret-value')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL — cannot resolve the client module.

- [ ] **Step 3: Implement**

Create `server/providers/github/client.ts`:

```ts
import type { Credential } from '../../auth.js'

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export type PageOf<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

export class GraphQLError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphQLError'
  }
}

export class RateLimitError extends Error {
  constructor(public readonly resetAt: Date | null) {
    super(
      `GitHub rate limit reached${resetAt ? `; resets at ${resetAt.toISOString()}` : ''}. ` +
        `Armature stopped rather than returning part of the board.`,
    )
    this.name = 'RateLimitError'
  }
}

export class MissingScopeError extends Error {
  constructor() {
    super(
      'The GitHub credential lacks the `project` scope, which reading a board requires. ' +
        'Run `gh auth refresh -s project`, or reissue the token with `repo` and `project`.',
    )
    this.name = 'MissingScopeError'
  }
}

const ENDPOINT = 'https://api.github.com/graphql'

export class GitHubClient {
  constructor(
    private readonly credential: Credential,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.credential.token}`,
        'content-type': 'application/json',
        'user-agent': 'armature',
      },
      body: JSON.stringify({ query, variables }),
    })

    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = response.headers.get('x-ratelimit-reset')
      throw new RateLimitError(reset ? new Date(Number(reset) * 1000) : null)
    }

    const payload = (await response.json()) as { data?: T; errors?: { type?: string; message: string }[] }

    if (payload.errors?.length) {
      if (payload.errors.some((e) => e.type === 'INSUFFICIENT_SCOPES')) throw new MissingScopeError()
      // Partial data alongside errors is the failure mode that hides corruption. Refuse it.
      throw new GraphQLError(payload.errors.map((e) => e.message).join('; '))
    }

    if (!payload.data) throw new GraphQLError('GitHub returned no data and no error.')
    return payload.data
  }

  async collectAll<T>(
    query: string,
    variables: Record<string, unknown>,
    extract: (data: any) => PageOf<T>,
  ): Promise<T[]> {
    const all: T[] = []
    let cursor: string | null = null

    // No page-size parameter is exposed anywhere. Under-fetching is not requestable.
    for (;;) {
      const data = await this.graphql<any>(query, { ...variables, cursor })
      const page = extract(data)
      all.push(...page.nodes)
      if (!page.pageInfo.hasNextPage) return all
      cursor = page.pageInfo.endCursor
      if (cursor === null) {
        throw new GraphQLError('GitHub reported another page but returned no cursor.')
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/client.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/client.ts tests/client.test.ts
git commit -m "feat(github): exhaustive pagination and loud error mapping"
```

---

### Task 6: Board survey, collisions and status inference

**Files:**
- Create: `server/providers/types.ts`, `server/providers/github/board.ts`, `tests/board.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `WorkItemRef`, `formatRef`.
- Produces: `type BoardItem = { ref: WorkItemRef; id: string; title: string; status: string | null; state: 'OPEN' | 'CLOSED'; parent: WorkItemRef | null }`; `type StatusSemantics = { todo: string; claimed: string; review: string | null; done: string }`; `type BoardSnapshot = { id: string; statusFieldId: string; statusOptions: { id: string; name: string }[]; semantics: StatusSemantics; items: BoardItem[]; repositories: string[]; collisions: Record<number, string[]> }`; `computeCollisions(items: BoardItem[]): Record<number, string[]>`; `inferStatusSemantics(optionNames: string[]): StatusSemantics`; `surveyBoard(client: GitHubClient, board: BoardRef): Promise<BoardSnapshot>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/board.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeCollisions, inferStatusSemantics } from '../server/providers/github/board.js'
import type { BoardItem } from '../server/providers/types.js'

function item(owner: string, repo: string, number: number): BoardItem {
  return {
    ref: { owner, repo, number },
    id: `${owner}/${repo}#${number}`,
    title: 't',
    status: 'Todo',
    state: 'OPEN',
    parent: null,
  }
}

describe('computeCollisions', () => {
  it('finds a number claimed by two repositories', () => {
    const c = computeCollisions([item('acme', 'web', 278), item('acme', 'api', 278)])
    expect(c[278]).toEqual(['acme/api', 'acme/web'])
  })

  it('ignores a number used once', () => {
    const c = computeCollisions([item('acme', 'web', 1), item('acme', 'api', 2)])
    expect(c).toEqual({})
  })
})

describe('inferStatusSemantics', () => {
  it('reads a conventional board', () => {
    const s = inferStatusSemantics(['Todo', 'In progress', 'Validation', 'Done', 'On hold'])
    expect(s).toEqual({ todo: 'Todo', claimed: 'In progress', review: 'Validation', done: 'Done' })
  })

  it('accepts alternative wording', () => {
    const s = inferStatusSemantics(['Backlog', 'Doing', 'In Review', 'Shipped'])
    expect(s).toEqual({ todo: 'Backlog', claimed: 'Doing', review: 'In Review', done: 'Shipped' })
  })

  it('leaves review null when the board has no review column', () => {
    const s = inferStatusSemantics(['Todo', 'WIP', 'Done'])
    expect(s.review).toBeNull()
    expect(s.claimed).toBe('WIP')
  })

  it('raises when no option resembles a claimed status', () => {
    expect(() => inferStatusSemantics(['Alpha', 'Beta'])).toThrow(/could not tell/i)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/board.test.ts`
Expected: FAIL — cannot resolve the board module.

- [ ] **Step 3: Implement the shared types**

Create `server/providers/types.ts`:

```ts
import type { WorkItemRef } from '../ref.js'

export type BoardItem = {
  ref: WorkItemRef
  id: string
  title: string
  status: string | null
  state: 'OPEN' | 'CLOSED'
  parent: WorkItemRef | null
}

export type StatusSemantics = {
  todo: string
  claimed: string
  review: string | null
  done: string
}

export type BoardSnapshot = {
  id: string
  statusFieldId: string
  statusOptions: { id: string; name: string }[]
  semantics: StatusSemantics
  items: BoardItem[]
  repositories: string[]
  collisions: Record<number, string[]>
}

export type CreateInput = {
  owner: string
  repo: string
  title: string
  body: string
  parent?: WorkItemRef
}

export interface BoardProvider {
  survey(): Promise<BoardSnapshot>
  getItem(ref: WorkItemRef): Promise<BoardItem>
  claim(ref: WorkItemRef): Promise<BoardItem>
  setStatus(ref: WorkItemRef, status: string): Promise<BoardItem>
  create(input: CreateInput): Promise<BoardItem>
}
```

- [ ] **Step 4: Implement derivation**

Create `server/providers/github/board.ts`:

```ts
import type { BoardRef } from '../../config.js'
import type { BoardItem, BoardSnapshot, StatusSemantics } from '../types.js'
import { GitHubClient } from './client.js'

export function computeCollisions(items: BoardItem[]): Record<number, string[]> {
  const byNumber = new Map<number, Set<string>>()
  for (const it of items) {
    const set = byNumber.get(it.ref.number) ?? new Set<string>()
    set.add(`${it.ref.owner}/${it.ref.repo}`)
    byNumber.set(it.ref.number, set)
  }
  const collisions: Record<number, string[]> = {}
  for (const [number, repos] of byNumber) {
    if (repos.size > 1) collisions[number] = [...repos].sort()
  }
  return collisions
}

const SYNONYMS = {
  todo: ['todo', 'to do', 'backlog', 'ready', 'open'],
  claimed: ['in progress', 'in-progress', 'doing', 'wip', 'started', 'active'],
  review: ['validation', 'review', 'in review', 'qa', 'verifying'],
  done: ['done', 'shipped', 'closed', 'complete', 'completed'],
} as const

function match(options: string[], candidates: readonly string[]): string | null {
  for (const option of options) {
    if (candidates.includes(option.trim().toLowerCase())) return option
  }
  return null
}

export function inferStatusSemantics(optionNames: string[]): StatusSemantics {
  const todo = match(optionNames, SYNONYMS.todo)
  const claimed = match(optionNames, SYNONYMS.claimed)
  const done = match(optionNames, SYNONYMS.done)
  const review = match(optionNames, SYNONYMS.review)

  if (!todo || !claimed || !done) {
    throw new Error(
      `Armature could not tell which of [${optionNames.join(', ')}] mean "todo", "claimed" and ` +
        `"done". Set them in ~/.config/armature/config.json under "statuses" for this board.`,
    )
  }
  return { todo, claimed, review, done }
}

const BOARD_QUERY = `
query($owner:String!,$number:Int!,$cursor:String){
  organization(login:$owner){
    projectV2(number:$number){
      id
      field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content{
            ... on Issue {
              number title state
              repository{ owner{ login } name }
              parent{ number repository{ owner{ login } name } }
            }
          }
        }
      }
    }
  }
}`

export async function surveyBoard(client: GitHubClient, board: BoardRef): Promise<BoardSnapshot> {
  const head = await client.graphql<any>(BOARD_QUERY, { owner: board.owner, number: board.number, cursor: null })
  const project = head.organization?.projectV2
  if (!project) throw new Error(`No project ${board.owner}/${board.number} is visible to this credential.`)

  const raw = await client.collectAll<any>(
    BOARD_QUERY,
    { owner: board.owner, number: board.number },
    (d) => d.organization.projectV2.items,
  )

  const items: BoardItem[] = raw
    .filter((n) => n.content?.number != null)
    .map((n) => ({
      id: n.id,
      title: n.content.title,
      state: n.content.state,
      status: n.fieldValueByName?.name ?? null,
      ref: {
        owner: n.content.repository.owner.login,
        repo: n.content.repository.name,
        number: n.content.number,
      },
      parent: n.content.parent
        ? {
            owner: n.content.parent.repository.owner.login,
            repo: n.content.parent.repository.name,
            number: n.content.parent.number,
          }
        : null,
    }))

  const statusOptions = project.field?.options ?? []

  return {
    id: project.id,
    statusFieldId: project.field?.id ?? '',
    statusOptions,
    semantics: inferStatusSemantics(statusOptions.map((o: { name: string }) => o.name)),
    items,
    repositories: [...new Set(items.map((i) => `${i.ref.owner}/${i.ref.repo}`))].sort(),
    collisions: computeCollisions(items),
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/board.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add server/providers/types.ts server/providers/github/board.ts tests/board.test.ts
git commit -m "feat(board): derive repositories, collisions and status meanings from the board"
```

---

### Task 7: Item read and epic location

**Files:**
- Create: `server/providers/github/items.ts`, `tests/items-read.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `WorkItemRef`, `formatRef`, `BoardItem`.
- Produces: `type ItemDetail = BoardItem & { body: string; projectItemId: string | null; epic: WorkItemRef | null }`; `getItem(client: GitHubClient, board: BoardRef, ref: WorkItemRef): Promise<ItemDetail>`; `parseEpicFromBody(body: string): WorkItemRef | null`; `class NotOnBoardError extends Error`.

The query is rooted at `repository(owner,name)` so it cannot return another repository's item. Epic location comes from the parent link, never from configuration.

- [ ] **Step 1: Write the failing tests**

Create `tests/items-read.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseEpicFromBody } from '../server/providers/github/items.js'

describe('parseEpicFromBody', () => {
  it('reads a cross-repository epic reference', () => {
    const body = 'Part of the telemetry epic in acme/platform (Epic 4, issue #339).'
    expect(parseEpicFromBody(body)).toEqual({ owner: 'acme', repo: 'platform', number: 339 })
  })

  it('reads a shorthand reference', () => {
    expect(parseEpicFromBody('Part of acme/platform#339.')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  // A bare number in a body names an issue in some other repository. Refuse to guess.
  it('returns null for a bare number', () => {
    expect(parseEpicFromBody('Part of the epic, issue #339.')).toBeNull()
  })

  it('returns null when there is no reference', () => {
    expect(parseEpicFromBody('No epic here.')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/items-read.test.ts`
Expected: FAIL — cannot resolve the items module.

- [ ] **Step 3: Implement**

Create `server/providers/github/items.ts`:

```ts
import type { BoardRef } from '../../config.js'
import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardItem } from '../types.js'
import { GitHubClient } from './client.js'

export type ItemDetail = BoardItem & {
  body: string
  projectItemId: string | null
  epic: WorkItemRef | null
}

export class NotOnBoardError extends Error {
  constructor(ref: WorkItemRef, board: BoardRef) {
    super(
      `${formatRef(ref)} is not on board ${board.owner}/${board.number}. Creating an issue does ` +
        `not add it to a board. Add it deliberately before working it.`,
    )
    this.name = 'NotOnBoardError'
  }
}

const QUALIFIED = /\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)\b/
const PROSE = /\bin\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\s*\([^)]*?#(\d+)\)/

export function parseEpicFromBody(body: string): WorkItemRef | null {
  const match = PROSE.exec(body) ?? QUALIFIED.exec(body)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) }
}

// Rooted at repository(owner,name): structurally unable to return another repository's item.
const ITEM_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      id number title body state
      parent{ number repository{ owner{ login } name } }
      projectItems(first:20){
        nodes{
          id
          project{ number }
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`

export async function getItem(
  client: GitHubClient,
  board: BoardRef,
  ref: WorkItemRef,
): Promise<ItemDetail> {
  const data = await client.graphql<any>(ITEM_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  })

  const issue = data.repository?.issue
  if (!issue) throw new Error(`${formatRef(ref)} does not exist, or is not visible to this credential.`)

  const projectItem = issue.projectItems.nodes.find(
    (n: { project: { number: number } }) => n.project.number === board.number,
  )

  const epicFromLink: WorkItemRef | null = issue.parent
    ? {
        owner: issue.parent.repository.owner.login,
        repo: issue.parent.repository.name,
        number: issue.parent.number,
      }
    : null

  return {
    ref,
    id: issue.id,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    status: projectItem?.fieldValueByName?.name ?? null,
    projectItemId: projectItem?.id ?? null,
    parent: epicFromLink,
    epic: epicFromLink ?? parseEpicFromBody(issue.body ?? ''),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/items-read.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/items.ts tests/items-read.test.ts
git commit -m "feat(items): resolve an item from its issue and derive its epic's repository"
```

---

### Task 8: Verified status transitions

**Files:**
- Modify: `server/providers/github/items.ts`
- Create: `tests/items-write.test.ts`

**Interfaces:**
- Consumes: `getItem`, `ItemDetail`, `NotOnBoardError`, `BoardSnapshot`.
- Produces: `type ItemReader = (ref: WorkItemRef) => Promise<ItemDetail>`; `setStatus(client: GitHubClient, board: BoardRef, snapshot: BoardSnapshot, ref: WorkItemRef, status: string, options?: { expectStatus?: string; dryRun?: boolean; read?: ItemReader }): Promise<ItemDetail>`; `claim(client, board, snapshot, ref, options?: { dryRun?: boolean; read?: ItemReader }): Promise<ItemDetail>`; `class StaleItemError extends Error`; `class UnverifiedWriteError extends Error`.

**Why the reader is injected:** `setStatus` calls `getItem` from its own module, and an ES module's internal calls are not intercepted by `vi.spyOn`. Passing the reader in keeps the tests honest instead of silently exercising the real network path.

This is the `#278` fix's second half: the write is checked before and read back after.

- [ ] **Step 1: Write the failing tests**

Create `tests/items-write.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { setStatus, StaleItemError, UnverifiedWriteError } from '../server/providers/github/items.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const ref = { owner: 'acme', repo: 'web', number: 278 }

const snapshot = {
  id: 'PVT_1',
  statusFieldId: 'F_1',
  statusOptions: [
    { id: 'o-todo', name: 'Todo' },
    { id: 'o-doing', name: 'In progress' },
  ],
  semantics: { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' },
  items: [],
  repositories: [],
  collisions: {},
}

function detail(status: string) {
  return {
    ref, id: 'I_1', title: 't', body: '', state: 'OPEN' as const,
    status, projectItemId: 'PVTI_1', parent: null, epic: null,
  }
}

describe('setStatus', () => {
  it('refuses when the pre-state is not what the caller expected', async () => {
    const read = async () => detail('In progress')
    const client = { graphql: vi.fn() } as any

    await expect(
      setStatus(client, board, snapshot, ref, 'In progress', { expectStatus: 'Todo', read }),
    ).rejects.toThrow(StaleItemError)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('raises when the read-back does not show the new status', async () => {
    const reads = [detail('Todo'), detail('Todo')]
    let call = 0
    const read = async () => reads[call++]!
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    await expect(setStatus(client, board, snapshot, ref, 'In progress', { read })).rejects.toThrow(
      UnverifiedWriteError,
    )
  })

  it('returns the observed state when the write lands', async () => {
    const reads = [detail('Todo'), detail('In progress')]
    let call = 0
    const read = async () => reads[call++]!
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const result = await setStatus(client, board, snapshot, ref, 'In progress', { read })
    expect(result.status).toBe('In progress')
  })

  it('mutates nothing in dry run and reports the intended effect', async () => {
    const read = async () => detail('Todo')
    const client = { graphql: vi.fn() } as any

    const result = await setStatus(client, board, snapshot, ref, 'In progress', { dryRun: true, read })
    expect(client.graphql).not.toHaveBeenCalled()
    expect(result.status).toBe('In progress')
  })

  it('rejects a status the board does not offer', async () => {
    const read = async () => detail('Todo')
    const client = { graphql: vi.fn() } as any

    await expect(setStatus(client, board, snapshot, ref, 'Nonsense', { read })).rejects.toThrow(
      /Todo, In progress/,
    )
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/items-write.test.ts`
Expected: FAIL — `setStatus` is not exported.

- [ ] **Step 3: Implement**

Append to `server/providers/github/items.ts`:

```ts
import type { BoardSnapshot } from '../types.js'

export type ItemReader = (ref: WorkItemRef) => Promise<ItemDetail>

export class StaleItemError extends Error {
  constructor(ref: WorkItemRef, expected: string, found: string | null) {
    super(
      `${formatRef(ref)} was expected to be "${expected}" but is "${found ?? 'unset'}". ` +
        `Someone or something else moved it. Armature made no change.`,
    )
    this.name = 'StaleItemError'
  }
}

export class UnverifiedWriteError extends Error {
  constructor(ref: WorkItemRef, intended: string, observed: string | null) {
    super(
      `Set ${formatRef(ref)} to "${intended}" but reading it back shows "${observed ?? 'unset'}". ` +
        `Treat the board as unchanged and investigate before retrying.`,
    )
    this.name = 'UnverifiedWriteError'
  }
}

const SET_STATUS = `
mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}
  }){ projectV2Item { id } }
}`

export async function setStatus(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  ref: WorkItemRef,
  status: string,
  options: { expectStatus?: string; dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  const read: ItemReader = options.read ?? ((r) => getItem(client, board, r))

  const option = snapshot.statusOptions.find((o) => o.name === status)
  if (!option) {
    const names = snapshot.statusOptions.map((o) => o.name).join(', ')
    throw new Error(`This board has no status "${status}". It offers: ${names}.`)
  }

  const before = await read(ref)
  if (before.projectItemId === null) throw new NotOnBoardError(ref, board)

  if (options.expectStatus !== undefined && before.status !== options.expectStatus) {
    throw new StaleItemError(ref, options.expectStatus, before.status)
  }

  if (options.dryRun) return { ...before, status }

  await client.graphql(SET_STATUS, {
    project: snapshot.id,
    item: before.projectItemId,
    field: snapshot.statusFieldId,
    option: option.id,
  })

  const after = await read(ref)
  if (after.status !== status) throw new UnverifiedWriteError(ref, status, after.status)
  return after
}

export async function claim(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  ref: WorkItemRef,
  options: { dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  return setStatus(client, board, snapshot, ref, snapshot.semantics.claimed, {
    expectStatus: snapshot.semantics.todo,
    dryRun: options.dryRun,
    read: options.read,
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/items-write.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/items.ts tests/items-write.test.ts
git commit -m "feat(items): verify status writes before and after they land"
```

---

### Task 9: Item creation that cannot orphan

**Files:**
- Modify: `server/providers/github/items.ts`
- Create: `tests/items-create.test.ts`

**Interfaces:**
- Consumes: `CreateInput`, `BoardSnapshot`, `getItem`.
- Produces: `createItem(client: GitHubClient, board: BoardRef, snapshot: BoardSnapshot, input: CreateInput, options?: { dryRun?: boolean }): Promise<ItemDetail>`; `class OrphanedIssueError extends Error`.

- [ ] **Step 1: Write the failing tests**

Create `tests/items-create.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createItem, OrphanedIssueError } from '../server/providers/github/items.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const snapshot = {
  id: 'PVT_1', statusFieldId: 'F_1',
  statusOptions: [{ id: 'o-todo', name: 'Todo' }],
  semantics: { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' },
  items: [], repositories: [], collisions: {},
}
const input = { owner: 'acme', repo: 'web', title: 'A ticket', body: 'Body' }

describe('createItem', () => {
  it('reports the orphan when the board add fails after the issue exists', async () => {
    const client = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce({ createIssue: { issue: { id: 'I_1', number: 42 } } })
        .mockRejectedValueOnce(new Error('board add failed')),
    } as any

    const err = await createItem(client, board, snapshot, input).catch((e: Error) => e)
    expect(err).toBeInstanceOf(OrphanedIssueError)
    expect((err as Error).message).toContain('acme/web#42')
  })

  it('creates nothing in dry run', async () => {
    const client = { graphql: vi.fn() } as any
    const result = await createItem(client, board, snapshot, input, { dryRun: true })
    expect(client.graphql).not.toHaveBeenCalled()
    expect(result.title).toBe('A ticket')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/items-create.test.ts`
Expected: FAIL — `createItem` is not exported.

- [ ] **Step 3: Implement**

Append to `server/providers/github/items.ts`:

```ts
import type { CreateInput } from '../types.js'

export class OrphanedIssueError extends Error {
  constructor(ref: WorkItemRef, cause: string) {
    super(
      `Created ${formatRef(ref)} but could not add it to the board: ${cause}. ` +
        `The issue exists and is not tracked. Add it to the board or close it.`,
    )
    this.name = 'OrphanedIssueError'
  }
}

const REPO_ID = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id } }`

const CREATE_ISSUE = `
mutation($repo:ID!,$title:String!,$body:String!){
  createIssue(input:{repositoryId:$repo,title:$title,body:$body}){ issue{ id number } }
}`

const ADD_TO_BOARD = `
mutation($project:ID!,$content:ID!){
  addProjectV2ItemById(input:{projectId:$project,contentId:$content}){ item{ id } }
}`

export async function createItem(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  input: CreateInput,
  options: { dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  const read: ItemReader = options.read ?? ((r) => getItem(client, board, r))
  const ref = { owner: input.owner, repo: input.repo, number: 0 }

  if (options.dryRun) {
    return {
      ref, id: '(dry-run)', title: input.title, body: input.body, state: 'OPEN',
      status: snapshot.semantics.todo, projectItemId: '(dry-run)', parent: input.parent ?? null,
      epic: input.parent ?? null,
    }
  }

  const repo = await client.graphql<any>(REPO_ID, { owner: input.owner, name: input.repo })
  const created = await client.graphql<any>(CREATE_ISSUE, {
    repo: repo.repository.id,
    title: input.title,
    body: input.body,
  })

  const number = created.createIssue.issue.number as number
  const contentId = created.createIssue.issue.id as string
  const madeRef = { owner: input.owner, repo: input.repo, number }

  try {
    await client.graphql(ADD_TO_BOARD, { project: snapshot.id, content: contentId })
  } catch (error) {
    throw new OrphanedIssueError(madeRef, error instanceof Error ? error.message : String(error))
  }

  return read(madeRef)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/items-create.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/items.ts tests/items-create.test.ts
git commit -m "feat(items): create an issue and its board membership together"
```

---

### Task 10: Ordering policy

**Files:**
- Create: `server/providers/github/next.ts`, `tests/next.test.ts`

**Interfaces:**
- Consumes: `BoardItem`, `BoardSnapshot`, `WorkItemRef`, `formatRef`.
- Produces: `type NextResult = { kind: 'item'; item: BoardItem; because: string } | { kind: 'blocked'; because: string }`; `epicOrder(title: string, number: number): number`; `selectNext(snapshot: BoardSnapshot, options: { repo?: string; epic?: WorkItemRef }): NextResult`.

Policy, restated from the command being replaced: an epic carries no code of its own, so drop to its lowest-numbered actionable child; take epics in order; an epic whose prerequisites are unfinished blocks rather than skips.

- [ ] **Step 1: Write the failing tests**

Create `tests/next.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { epicOrder, selectNext } from '../server/providers/github/next.js'
import type { BoardItem, BoardSnapshot } from '../server/providers/types.js'

const semantics = { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' }

function make(
  repo: string, number: number, status: string, title = 't',
  parent: BoardItem['parent'] = null,
): BoardItem {
  return {
    ref: { owner: 'acme', repo, number },
    id: `${repo}#${number}`, title, status, state: 'OPEN', parent,
  }
}

function snap(items: BoardItem[]): BoardSnapshot {
  return {
    id: 'P', statusFieldId: 'F', statusOptions: [], semantics,
    items, repositories: [], collisions: {},
  }
}

describe('epicOrder', () => {
  it('reads the epic number out of the title', () => {
    expect(epicOrder('Epic 4 · Telemetry', 900)).toBe(4)
  })

  it('falls back to the issue number', () => {
    expect(epicOrder('Untitled work', 900)).toBe(900)
  })
})

describe('selectNext', () => {
  const epic1 = make('platform', 10, 'Todo', 'Epic 1 · Foundations')
  const epic2 = make('platform', 20, 'Todo', 'Epic 2 · Telemetry')

  it('drops from an epic to its lowest-numbered actionable child', () => {
    const s = snap([
      epic1,
      make('web', 7, 'Todo', 'child b', epic1.ref),
      make('web', 5, 'Todo', 'child a', epic1.ref),
    ])
    const result = selectNext(s, {})
    expect(result.kind).toBe('item')
    if (result.kind === 'item') expect(result.item.ref.number).toBe(5)
  })

  it('takes the lower-numbered epic first', () => {
    const s = snap([
      epic1, epic2,
      make('web', 9, 'Todo', 'later', epic2.ref),
      make('web', 8, 'Todo', 'earlier', epic1.ref),
    ])
    const result = selectNext(s, {})
    if (result.kind === 'item') expect(result.item.ref.number).toBe(8)
  })

  it('restricts to one repository when asked', () => {
    const s = snap([
      epic1,
      make('api', 3, 'Todo', 'api work', epic1.ref),
      make('web', 4, 'Todo', 'web work', epic1.ref),
    ])
    const result = selectNext(s, { repo: 'acme/web' })
    if (result.kind === 'item') expect(result.item.ref.repo).toBe('web')
  })

  it('never returns an epic itself', () => {
    const s = snap([epic1, make('web', 5, 'Todo', 'child', epic1.ref)])
    const result = selectNext(s, {})
    if (result.kind === 'item') expect(result.item.ref.number).toBe(5)
  })

  it('reports why nothing is actionable rather than returning empty', () => {
    const s = snap([epic1, make('web', 5, 'Done', 'child', epic1.ref)])
    const result = selectNext(s, {})
    expect(result.kind).toBe('blocked')
    if (result.kind === 'blocked') expect(result.because).toMatch(/nothing/i)
  })

  it('explains why it chose what it chose', () => {
    const s = snap([epic1, make('web', 5, 'Todo', 'child', epic1.ref)])
    const result = selectNext(s, {})
    if (result.kind === 'item') expect(result.because).toContain('acme/platform#10')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/next.test.ts`
Expected: FAIL — cannot resolve the next module.

- [ ] **Step 3: Implement**

Create `server/providers/github/next.ts`:

```ts
import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardItem, BoardSnapshot } from '../types.js'

export type NextResult =
  | { kind: 'item'; item: BoardItem; because: string }
  | { kind: 'blocked'; because: string }

const EPIC_TITLE = /\bEpic\s+(\d+)\b/i

export function epicOrder(title: string, number: number): number {
  const match = EPIC_TITLE.exec(title)
  return match ? Number(match[1]!) : number
}

function key(ref: WorkItemRef): string {
  return formatRef(ref)
}

export function selectNext(
  snapshot: BoardSnapshot,
  options: { repo?: string; epic?: WorkItemRef },
): NextResult {
  const { todo } = snapshot.semantics

  const parents = new Set(snapshot.items.filter((i) => i.parent).map((i) => key(i.parent!)))
  const isEpic = (i: BoardItem) => parents.has(key(i.ref))

  const children = snapshot.items.filter((i) => !isEpic(i))
  const inRepo = options.repo
    ? children.filter((i) => `${i.ref.owner}/${i.ref.repo}` === options.repo)
    : children
  const underEpic = options.epic
    ? inRepo.filter((i) => i.parent && key(i.parent) === key(options.epic!))
    : inRepo

  const actionable = underEpic.filter((i) => i.status === todo && i.state === 'OPEN')

  if (actionable.length === 0) {
    const scope = options.repo ? ` in ${options.repo}` : ''
    return {
      kind: 'blocked',
      because:
        `Nothing is actionable${scope}: no open item sits in "${todo}". ` +
        `${underEpic.length} item(s) were considered.`,
    }
  }

  const epicRank = new Map<string, number>()
  for (const item of snapshot.items) {
    if (isEpic(item)) epicRank.set(key(item.ref), epicOrder(item.title, item.ref.number))
  }

  const ranked = [...actionable].sort((a, b) => {
    const ra = a.parent ? (epicRank.get(key(a.parent)) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
    const rb = b.parent ? (epicRank.get(key(b.parent)) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return a.ref.number - b.ref.number
  })

  const chosen = ranked[0]!
  const parentNote = chosen.parent
    ? `the lowest-numbered open "${todo}" child of ${formatRef(chosen.parent)}`
    : `the lowest-numbered open "${todo}" item with no epic`
  return {
    kind: 'item',
    item: chosen,
    because: `${formatRef(chosen.ref)} is ${parentNote}. ${ranked.length - 1} other item(s) queued behind it.`,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/next.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/next.ts tests/next.test.ts
git commit -m "feat(next): epic-ordered selection that explains its choice"
```

---

### Task 11: The provider seam and its contract suite

**Files:**
- Create: `server/providers/github/provider.ts`, `tests/contract/provider.contract.ts`, `tests/contract/github.contract.test.ts`

**Interfaces:**
- Consumes: `BoardProvider`, `BoardSnapshot`, `WorkItemRef`, `parseRef`, `surveyBoard`, `getItem`, `claim`, `setStatus`, `createItem`.
- Produces: `class GitHubBoardProvider implements BoardProvider`; `describeBoardProvider(name: string, makeProvider: () => Promise<BoardProvider>): void`.

This is the artifact that makes a second tracker tractable: a Jira adapter's definition of done becomes "pass these". The contract must bind to the **real** provider over a stub transport — a suite that tests a hand-written fixture object proves nothing about the code that ships.

- [ ] **Step 1: Write the contract**

Create `tests/contract/provider.contract.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BareRefError, parseRef } from '../../server/ref.js'
import type { BoardProvider } from '../../server/providers/types.js'

export function describeBoardProvider(
  name: string,
  makeProvider: () => Promise<BoardProvider>,
): void {
  describe(`${name} satisfies the board provider contract`, () => {
    it('returns items whose refs are all fully qualified', async () => {
      const snapshot = await (await makeProvider()).survey()
      for (const item of snapshot.items) {
        expect(item.ref.owner).toBeTruthy()
        expect(item.ref.repo).toBeTruthy()
        expect(item.ref.number).toBeGreaterThan(0)
      }
    })

    it('never emits a reference that would parse as bare', async () => {
      const snapshot = await (await makeProvider()).survey()
      for (const item of snapshot.items) {
        const rendered = `${item.ref.owner}/${item.ref.repo}#${item.ref.number}`
        expect(() => parseRef(rendered)).not.toThrow(BareRefError)
      }
    })

    it('reports collisions for numbers claimed by more than one repository', async () => {
      const snapshot = await (await makeProvider()).survey()
      for (const [, repos] of Object.entries(snapshot.collisions)) {
        expect(repos.length).toBeGreaterThan(1)
      }
    })

    it('names a status for claimed, todo and done', async () => {
      const snapshot = await (await makeProvider()).survey()
      expect(snapshot.semantics.todo).toBeTruthy()
      expect(snapshot.semantics.claimed).toBeTruthy()
      expect(snapshot.semantics.done).toBeTruthy()
    })

    it('rejects a bare number passed as a reference', async () => {
      const provider = await makeProvider()
      await expect(async () => provider.getItem(parseRef('278'))).rejects.toThrow(BareRefError)
    })
  })
}
```

- [ ] **Step 2: Implement the provider class**

Create `server/providers/github/provider.ts`:

```ts
import type { BoardRef } from '../../config.js'
import type { WorkItemRef } from '../../ref.js'
import type { BoardItem, BoardProvider, BoardSnapshot, CreateInput } from '../types.js'
import { surveyBoard } from './board.js'
import type { GitHubClient } from './client.js'
import { claim, createItem, getItem, setStatus } from './items.js'

export class GitHubBoardProvider implements BoardProvider {
  private cached: BoardSnapshot | null = null

  constructor(
    private readonly client: GitHubClient,
    private readonly board: BoardRef,
    private readonly dryRun = false,
  ) {}

  // Derived facts are cached for the life of the process, never written to disk.
  async survey(): Promise<BoardSnapshot> {
    this.cached ??= await surveyBoard(this.client, this.board)
    return this.cached
  }

  async getItem(ref: WorkItemRef): Promise<BoardItem> {
    return getItem(this.client, this.board, ref)
  }

  async claim(ref: WorkItemRef): Promise<BoardItem> {
    return claim(this.client, this.board, await this.survey(), ref, { dryRun: this.dryRun })
  }

  async setStatus(ref: WorkItemRef, status: string): Promise<BoardItem> {
    return setStatus(this.client, this.board, await this.survey(), ref, status, { dryRun: this.dryRun })
  }

  async create(input: CreateInput): Promise<BoardItem> {
    return createItem(this.client, this.board, await this.survey(), input, { dryRun: this.dryRun })
  }
}
```

- [ ] **Step 3: Bind the contract to the real provider**

Create `tests/contract/github.contract.test.ts`. The stub replaces only the network, so `surveyBoard`, `computeCollisions` and `inferStatusSemantics` all run for real:

```ts
import type { GitHubClient } from '../../server/providers/github/client.js'
import { GitHubBoardProvider } from '../../server/providers/github/provider.js'
import { describeBoardProvider } from './provider.contract.js'

function issue(repo: string, number: number) {
  return {
    id: `node-${repo}-${number}`,
    fieldValueByName: { name: 'Todo' },
    content: {
      number,
      title: `Item ${number}`,
      state: 'OPEN',
      repository: { owner: { login: 'acme' }, name: repo },
      parent: null,
    },
  }
}

// Two repositories both numbering an issue 278 — the collision the incident was made of.
const nodes = [issue('web', 278), issue('api', 278), issue('web', 12)]

const boardResponse = {
  organization: {
    projectV2: {
      id: 'PVT_1',
      field: {
        id: 'F_1',
        options: [
          { id: 'o1', name: 'Todo' },
          { id: 'o2', name: 'In progress' },
          { id: 'o3', name: 'Done' },
        ],
      },
      items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
    },
  },
}

const client = {
  graphql: async () => boardResponse,
  collectAll: async () => nodes,
} as unknown as GitHubClient

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

describeBoardProvider('GitHubBoardProvider', async () => new GitHubBoardProvider(client, board))
```

- [ ] **Step 4: Run the contract suite**

Run: `npx vitest run tests/contract`
Expected: PASS — 5 tests. The collision assertion sees `{ 278: ['acme/api', 'acme/web'] }` derived by real code.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/provider.ts tests/contract
git commit -m "feat(providers): implement the board provider seam and bind its contract suite"
```

---

### Task 12: MCP server wiring

**Files:**
- Create: `server/index.ts`, `server/log.ts`, `tests/log.test.ts`

**Interfaces:**
- Consumes: every module above.
- Produces: `logMutation(entry: MutationEntry, write?: (line: string) => void): void`; a stdio MCP server exposing `board_next`, `board_survey`, `item_get`, `item_claim`, `item_status`, `item_create`.

- [ ] **Step 1: Write the failing test**

Create `tests/log.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { logMutation } from '../server/log.js'

describe('logMutation', () => {
  it('writes ref, field, before and after', () => {
    const lines: string[] = []
    logMutation(
      { ref: 'acme/web#278', field: 'Status', before: 'Todo', after: 'In progress' },
      (l) => lines.push(l),
    )
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({
      ref: 'acme/web#278', field: 'Status', before: 'Todo', after: 'In progress',
    })
    expect(entry.at).toBeTruthy()
  })

  it('never writes a credential', () => {
    const lines: string[] = []
    logMutation(
      { ref: 'acme/web#1', field: 'Status', before: null, after: 'Done', token: 'secret-value' } as never,
      (l) => lines.push(l),
    )
    expect(lines[0]).not.toContain('secret-value')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/log.test.ts`
Expected: FAIL — cannot resolve `../server/log.js`.

- [ ] **Step 3: Implement the log**

Create `server/log.ts`:

```ts
export type MutationEntry = {
  ref: string
  field: string
  before: string | null
  after: string | null
}

export function logMutation(
  entry: MutationEntry,
  write: (line: string) => void = (l) => process.stderr.write(l + '\n'),
): void {
  // Constructed field by field so no caller can widen this into a credential leak.
  write(
    JSON.stringify({
      at: new Date().toISOString(),
      ref: entry.ref,
      field: entry.field,
      before: entry.before,
      after: entry.after,
    }),
  )
}
```

- [ ] **Step 4: Implement the server**

Create `server/index.ts`:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readCliTokenFromGh, resolveCredential } from './auth.js'
import { parseOriginUrl, type BoardRef } from './config.js'
import { logMutation } from './log.js'
import { formatRef, parseRef } from './ref.js'
import { GitHubClient } from './providers/github/client.js'
import { surveyBoard } from './providers/github/board.js'
import { claim, createItem, getItem, setStatus } from './providers/github/items.js'
import { selectNext } from './providers/github/next.js'
import { VERSION } from './version.js'

const DRY_RUN = process.env.ARMATURE_DRY_RUN === '1'

const TOOLS = [
  {
    name: 'board_next',
    description:
      'The next actionable work item, with the reason it was chosen and what is queued behind it. ' +
      'Returns a blocked explanation rather than an empty result when nothing is actionable.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Restrict to one repository, as owner/name.' },
        epic: { type: 'string', description: 'Restrict to one epic, as owner/repo#number.' },
      },
    },
  },
  {
    name: 'board_survey',
    description: 'A normalized snapshot of the whole board: items, repositories, statuses, collisions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'item_get',
    description: 'One work item: body, status, and its epic with the repository the epic lives in.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'owner/repo#number' } },
      required: ['ref'],
    },
  },
  {
    name: 'item_claim',
    description: 'Move an item to the board\'s claimed status. Verified before and after the write.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'owner/repo#number' } },
      required: ['ref'],
    },
  },
  {
    name: 'item_status',
    description: 'Move an item to any status the board offers. Verified before and after the write.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'owner/repo#number' },
        status: { type: 'string' },
      },
      required: ['ref', 'status'],
    },
  },
  {
    name: 'item_create',
    description: 'Create an issue and add it to the board together. Reports an orphan loudly.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        title: { type: 'string' },
        body: { type: 'string' },
        parent: { type: 'string', description: 'Epic, as owner/repo#number' },
      },
      required: ['repo', 'title', 'body'],
    },
  },
]

function boardFromEnv(): BoardRef {
  const value = process.env.ARMATURE_BOARD
  if (!value) throw new Error('ARMATURE_BOARD is not set. Expected "github:owner/number".')
  const match = /^github:([A-Za-z0-9._-]+)\/(\d+)$/.exec(value)
  if (!match) throw new Error(`ARMATURE_BOARD must look like "github:owner/number", got "${value}".`)
  return { provider: 'github', owner: match[1]!, number: Number(match[2]!) }
}

async function main(): Promise<void> {
  const credential = await resolveCredential({ readCliToken: readCliTokenFromGh, env: process.env })
  const client = new GitHubClient(credential)
  const board = boardFromEnv()

  const server = new Server(
    { name: 'armature', version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, string>
    const snapshot = await surveyBoard(client, board)
    const ok = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    })

    switch (request.params.name) {
      case 'board_survey':
        return ok(snapshot)

      case 'board_next':
        return ok(
          selectNext(snapshot, {
            repo: args.repo,
            epic: args.epic ? parseRef(args.epic) : undefined,
          }),
        )

      case 'item_get':
        return ok(await getItem(client, board, parseRef(args.ref!)))

      case 'item_claim': {
        const ref = parseRef(args.ref!)
        const before = await getItem(client, board, ref)
        const after = await claim(client, board, snapshot, ref, { dryRun: DRY_RUN })
        logMutation({ ref: formatRef(ref), field: 'Status', before: before.status, after: after.status })
        return ok(after)
      }

      case 'item_status': {
        const ref = parseRef(args.ref!)
        const before = await getItem(client, board, ref)
        const after = await setStatus(client, board, snapshot, ref, args.status!, { dryRun: DRY_RUN })
        logMutation({ ref: formatRef(ref), field: 'Status', before: before.status, after: after.status })
        return ok(after)
      }

      case 'item_create': {
        const [owner, name] = args.repo!.split('/')
        if (!owner || !name) throw new Error(`"repo" must be owner/name, got "${args.repo}".`)
        const created = await createItem(
          client, board, snapshot,
          {
            owner, repo: name, title: args.title!, body: args.body!,
            parent: args.parent ? parseRef(args.parent) : undefined,
          },
          { dryRun: DRY_RUN },
        )
        logMutation({ ref: formatRef(created.ref), field: 'created', before: null, after: created.title })
        return ok(created)
      }

      default:
        throw new Error(`Unknown tool "${request.params.name}".`)
    }
  })

  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
```

- [ ] **Step 5: Run the whole suite and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS throughout; `dist/server.js` written.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts server/log.ts tests/log.test.ts dist/server.js
git commit -m "feat(server): expose the six board tools over stdio mcp"
```

---

### Task 13: Cross-repository alias resolution

**Files:**
- Create: `server/providers/github/aliases.ts`, `tests/aliases.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `RepoConfig`, `WorkItemRef`.
- Produces: `type AliasMap = Map<string, { owner: string; repo: string }>`; `type SiblingConfigReader = (owner: string, repo: string) => Promise<RepoConfig | null>`; `readSiblingConfigFrom(client: GitHubClient): SiblingConfigReader`; `buildAliasMap(read: SiblingConfigReader, repositories: string[]): Promise<AliasMap>`; `resolveAlias(map: AliasMap, token: string): WorkItemRef | null`; `class AliasConflictError extends Error`.

This implements the spec's Aliases section. Each repository declares its own alias; the server reads its siblings' `.armature.json` over the API, so no file ever holds a fact about another repository.

- [ ] **Step 1: Write the failing tests**

Create `tests/aliases.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AliasConflictError, buildAliasMap, resolveAlias } from '../server/providers/github/aliases.js'
import type { RepoConfig } from '../server/config.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

function reader(configs: Record<string, RepoConfig | null>) {
  return async (owner: string, repo: string) => configs[`${owner}/${repo}`] ?? null
}

describe('buildAliasMap', () => {
  it('collects an alias declared by each repository about itself', async () => {
    const map = await buildAliasMap(
      reader({ 'acme/site.example': { board, alias: 'apex' }, 'acme/api': { board, alias: 'engine' } }),
      ['acme/site.example', 'acme/api'],
    )
    expect(map.get('apex')).toEqual({ owner: 'acme', repo: 'site.example' })
    expect(map.get('engine')).toEqual({ owner: 'acme', repo: 'api' })
  })

  it('skips a repository with no config', async () => {
    const map = await buildAliasMap(reader({ 'acme/web': null }), ['acme/web'])
    expect(map.size).toBe(0)
  })

  it('refuses two repositories claiming one alias', async () => {
    await expect(
      buildAliasMap(
        reader({ 'acme/web': { board, alias: 'apex' }, 'acme/api': { board, alias: 'apex' } }),
        ['acme/web', 'acme/api'],
      ),
    ).rejects.toThrow(AliasConflictError)
  })
})

describe('resolveAlias', () => {
  const map = new Map([['apex', { owner: 'acme', repo: 'site.example' }]])

  it('expands an alias reference', () => {
    expect(resolveAlias(map, 'apex#272')).toEqual({ owner: 'acme', repo: 'site.example', number: 272 })
  })

  it('returns null for an unknown alias', () => {
    expect(resolveAlias(map, 'racing#293')).toBeNull()
  })

  it('returns null for a bare number', () => {
    expect(resolveAlias(map, '272')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/aliases.test.ts`
Expected: FAIL — cannot resolve the aliases module.

- [ ] **Step 3: Implement**

Create `server/providers/github/aliases.ts`:

```ts
import type { RepoConfig } from '../../config.js'
import type { WorkItemRef } from '../../ref.js'
import type { GitHubClient } from './client.js'

export type AliasMap = Map<string, { owner: string; repo: string }>
export type SiblingConfigReader = (owner: string, repo: string) => Promise<RepoConfig | null>

export class AliasConflictError extends Error {
  constructor(alias: string, first: string, second: string) {
    super(
      `Both ${first} and ${second} declare the alias "${alias}". An alias is a fact a repository ` +
        `states about itself, so exactly one may claim it. Change one .armature.json.`,
    )
    this.name = 'AliasConflictError'
  }
}

const CONFIG_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    object(expression:"HEAD:.armature.json"){ ... on Blob { text } }
  }
}`

export function readSiblingConfigFrom(client: GitHubClient): SiblingConfigReader {
  return async (owner, repo) => {
    const data = await client.graphql<any>(CONFIG_QUERY, { owner, name: repo })
    const text = data.repository?.object?.text
    if (!text) return null
    try {
      return JSON.parse(text) as RepoConfig
    } catch {
      return null
    }
  }
}

export async function buildAliasMap(
  read: SiblingConfigReader,
  repositories: string[],
): Promise<AliasMap> {
  const map: AliasMap = new Map()
  const claimedBy = new Map<string, string>()

  for (const full of repositories) {
    const [owner, repo] = full.split('/')
    if (!owner || !repo) continue

    const config = await read(owner, repo)
    const alias = config?.alias
    if (!alias) continue

    const existing = claimedBy.get(alias)
    if (existing && existing !== full) throw new AliasConflictError(alias, existing, full)

    claimedBy.set(alias, full)
    map.set(alias, { owner, repo })
  }
  return map
}

const ALIAS_REF = /^([A-Za-z0-9._-]+)#(\d+)$/

export function resolveAlias(map: AliasMap, token: string): WorkItemRef | null {
  const match = ALIAS_REF.exec(token.trim())
  if (!match) return null
  const target = map.get(match[1]!)
  if (!target) return null
  return { owner: target.owner, repo: target.repo, number: Number(match[2]!) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aliases.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/providers/github/aliases.ts tests/aliases.test.ts
git commit -m "feat(aliases): resolve shorthand cross-repository references from sibling configs"
```

---

### Task 14: Integration and dogfood harness

**Files:**
- Create: `tests/integration/board.integration.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `GitHubClient`, `GitHubBoardProvider`, `resolveCredential`, `readCliTokenFromGh`.
- Produces: an integration suite that is skipped unless explicitly enabled, and a CI job that runs it.

Implements the spec's third and fourth testing layers: a disposable board, and a read-only pass over a real one. Neither ever writes to a production board.

- [ ] **Step 1: Write the suite**

Create `tests/integration/board.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readCliTokenFromGh, resolveCredential } from '../../server/auth.js'
import { GitHubClient } from '../../server/providers/github/client.js'
import { GitHubBoardProvider } from '../../server/providers/github/provider.js'

const enabled = process.env.ARMATURE_INTEGRATION === '1'
const owner = process.env.ARMATURE_IT_OWNER
const number = Number(process.env.ARMATURE_IT_BOARD ?? '0')

describe.skipIf(!enabled || !owner || !number)('a real board, read only', () => {
  async function provider() {
    const credential = await resolveCredential({ readCliToken: readCliTokenFromGh, env: process.env })
    // dryRun stays true for the whole suite: this never mutates a board.
    return new GitHubBoardProvider(new GitHubClient(credential), {
      provider: 'github', owner: owner!, number,
    }, true)
  }

  it('surveys every page of the board', async () => {
    const snapshot = await (await provider()).survey()
    expect(snapshot.id).toMatch(/^PVT_/)
    expect(snapshot.items.length).toBeGreaterThan(0)
  })

  it('derives a repository list from the items rather than being told one', async () => {
    const snapshot = await (await provider()).survey()
    const fromItems = [...new Set(snapshot.items.map((i) => `${i.ref.owner}/${i.ref.repo}`))].sort()
    expect(snapshot.repositories).toEqual(fromItems)
  })

  it('infers a claimed and a done status', async () => {
    const snapshot = await (await provider()).survey()
    const names = snapshot.statusOptions.map((o) => o.name)
    expect(names).toContain(snapshot.semantics.claimed)
    expect(names).toContain(snapshot.semantics.done)
  })

  it('reports a collision only when two repositories share a number', async () => {
    const snapshot = await (await provider()).survey()
    for (const [number, repos] of Object.entries(snapshot.collisions)) {
      const holders = snapshot.items.filter((i) => i.ref.number === Number(number))
      expect(new Set(holders.map((i) => `${i.ref.owner}/${i.ref.repo}`)).size).toBe(repos.length)
    }
  })

  it('claims nothing in dry run', async () => {
    const p = await provider()
    const snapshot = await p.survey()
    const candidate = snapshot.items.find((i) => i.status === snapshot.semantics.todo)
    if (!candidate) return

    const before = candidate.status
    await p.claim(candidate.ref)
    const after = (await p.survey()).items.find((i) => i.id === candidate.id)
    expect(after?.status).toBe(before)
  })
})
```

- [ ] **Step 2: Verify it skips by default**

Run: `npm test`
Expected: PASS — the integration block reports as skipped, no network calls.

- [ ] **Step 3: Verify it runs when enabled**

Run: `ARMATURE_INTEGRATION=1 ARMATURE_IT_OWNER=<a scratch account> ARMATURE_IT_BOARD=<its board number> npx vitest run tests/integration`
Expected: PASS — 5 tests against a real board, with the board unchanged afterwards.

- [ ] **Step 4: Add the gated CI job**

Append to `.github/workflows/ci.yml`:

```yaml
  integration:
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx vitest run tests/integration
        env:
          ARMATURE_INTEGRATION: '1'
          ARMATURE_IT_OWNER: ${{ vars.ARMATURE_IT_OWNER }}
          ARMATURE_IT_BOARD: ${{ vars.ARMATURE_IT_BOARD }}
          GITHUB_TOKEN: ${{ secrets.ARMATURE_IT_TOKEN }}
```

- [ ] **Step 5: Commit**

```bash
git add tests/integration .github/workflows/ci.yml
git commit -m "test(integration): read-only dogfood pass against a real board"
```

---

### Task 15: Plugin packaging

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `commands/armature-next.md`, `commands/armature-doctor.md`, `skills/working-the-board/SKILL.md`, `tests/packaging.test.ts`
- Modify: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: `VERSION` from `server/version.ts`.
- Produces: an installable plugin; CI asserting version parity across `package.json`, `plugin.json`, `marketplace.json` and `server/version.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/packaging.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../server/version.js'

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))

describe('packaging', () => {
  it('keeps every declared version in step', () => {
    const pkg = read('package.json')
    const plugin = read('.claude-plugin/plugin.json')
    const market = read('.claude-plugin/marketplace.json')
    const entry = market.plugins.find((p: { name: string }) => p.name === 'armature')

    expect(plugin.version).toBe(pkg.version)
    expect(entry.version).toBe(pkg.version)
    expect(VERSION).toBe(pkg.version)
  })

  it('launches the committed bundle', () => {
    const plugin = read('.claude-plugin/plugin.json')
    expect(plugin.mcpServers.armature.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/dist/server.js')
  })

  it('is MIT licensed', () => {
    expect(read('.claude-plugin/plugin.json').license).toBe('MIT')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/packaging.test.ts`
Expected: FAIL — `.claude-plugin/plugin.json` does not exist.

- [ ] **Step 3: Create the manifests**

`.claude-plugin/plugin.json`:

```json
{
  "name": "armature",
  "version": "0.1.0",
  "description": "Drive epics and tickets across many repositories from one project board, over a typed MCP tool surface.",
  "author": { "name": "Ryan Lindsey" },
  "repository": "https://github.com/ryanlindsey/armature",
  "license": "MIT",
  "keywords": ["project-management", "issues", "epics", "multi-repo", "github-projects", "mcp"],
  "commands": "./commands/",
  "skills": "./skills/",
  "mcpServers": {
    "armature": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] }
  }
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "armature",
  "owner": { "name": "Ryan Lindsey" },
  "metadata": { "description": "Cross-repository epic and ticket orchestration", "version": "0.1.0" },
  "plugins": [
    {
      "name": "armature",
      "source": { "source": "url", "url": "https://github.com/ryanlindsey/armature.git" },
      "description": "Drive epics and tickets across many repositories from one project board.",
      "version": "0.1.0",
      "strict": true
    }
  ]
}
```

- [ ] **Step 4: Write the skill**

Create `skills/working-the-board/SKILL.md`:

```markdown
---
name: working-the-board
description: Use when working a roadmap, board, epic, ticket, issue, sprint or "what's next" - selects the next actionable item across repositories, claims it, and opens a PR that closes it
---

# Working the Board

Armature's MCP tools hold the facts. This skill holds the judgment.

**Announce at start:** "I'm using armature:working-the-board to work the next item."

## The loop

1. **Choose.** Run `board_next` (add `repo` or `epic` to narrow it). It returns the item and why it
   won, or a blocked explanation. If it is blocked, say what is blocking and STOP.
2. **Read.** Run `item_get` on the chosen ref. Read the body and every document it cites. If the item
   has an epic, read that too — `item_get` reports which repository the epic lives in, which is often
   not this one.
3. **Claim.** Run `item_claim`. It refuses if someone else moved the item first.
4. **Isolate and implement.** Use `superpowers:using-git-worktrees` and
   `superpowers:test-driven-development` if they are installed. Otherwise: branch as
   `issue-<number>-<slug>`, write the failing test first, then the implementation.
5. **Verify.** Run every command in this repository's `.armature.json` `verify` list. If there is no
   such list, run the project's test suite.
6. **Open a PR.** Title is a Conventional Commit. Body contains `Closes #<number>`. **Do not merge.**
7. **Hand back.** Move the item to the board's review status with `item_status` if the board has one.
   Report the PR link and STOP.

## Rules

- **Never pass a bare issue number to any tool.** Numbers repeat across repositories on one board.
  Always `owner/repo#number`. The tools refuse anything else.
- **If the armature tools are unavailable, STOP.** Do not fall back to `gh` commands to read or write
  the board. Say the server is unavailable and let a human decide.
- **An item that is not on the board is not work.** `item_get` reports this. Ask before adding it.
- **Never merge.** Armature opens PRs; people merge them.
```

- [ ] **Step 5: Write the commands**

Create `commands/armature-next.md`:

```markdown
---
description: Work the next actionable item on the board, on a branch, ending in a PR
argument-hint: "[owner/repo#number or issue URL]"
allowed-tools: Bash(git:*), Bash(npm:*), Bash(gh pr:*), Read, Edit, Write, Grep, Glob
---

Use the `armature:working-the-board` skill.

With `$ARGUMENTS`, work that item: pass it to `item_get` exactly as given — it is already a qualified
reference or a URL, and the tools will reject it if it is neither.

Without `$ARGUMENTS`, call `board_next` and work what it returns.
```

Create `commands/armature-doctor.md`:

```markdown
---
description: Show what armature derived about your board and what you declared
allowed-tools: Read
---

Call `board_survey` and report, as a table:

- The board, and where its identity came from
- Every repository with items on it
- The status options, and which were inferred to mean todo, claimed, review and done
- Any issue number claimed by more than one repository
- The count of items in each status

Then state plainly whether the inferred status meanings look right, and if any look wrong, say that
they can be overridden in `~/.config/armature/config.json`.
```

- [ ] **Step 6: Add the version-parity check to CI**

Add to `.github/workflows/ci.yml` under `steps`, after `npm test`:

```yaml
      - name: bundle is current
        run: |
          npm run build
          git diff --exit-code dist/server.js
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS — including the three packaging tests.

- [ ] **Step 8: Commit**

```bash
git add .claude-plugin commands skills tests/packaging.test.ts .github/workflows/ci.yml README.md
git commit -m "feat(plugin): package armature as an installable claude code plugin"
```

---

## Definition of done

- `npm run typecheck && npm test && npm run build` passes from a clean clone.
- `/plugin marketplace add ryanlindsey/armature` followed by installing `armature` yields six working
  tools, verified against a real board with `ARMATURE_DRY_RUN=1`.
- No repository name, board number, or alias from any real organisation appears in `server/` or
  `tests/`.
