import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readCliTokenFromGh, resolveCredential } from './auth.js'
import { loadResolvedConfig } from './config-io.js'
import { logMutation } from './log.js'
import { BareRefError, formatRef, parseRef } from './ref.js'
import type { WorkItemRef } from './ref.js'
import { GitHubClient } from './providers/github/client.js'
import { GitHubBoardProvider } from './providers/github/provider.js'
import { ALIAS_REF, buildAliasMap, readSiblingConfigFrom, resolveAlias } from './providers/github/aliases.js'
import type { AliasMap, SiblingConfigReader } from './providers/github/aliases.js'
import { selectNext } from './providers/github/next.js'
import type { BoardProvider } from './providers/types.js'
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

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

// A dry-run creation has no real issue number — items.ts reports that honestly with the string
// "(dry-run)" for `id` and `projectItemId`, but `ref` is a structured WorkItemRef, and the only
// way createItem can populate ref.number before the issue exists is 0. Rendered through
// formatRef that reads as "acme/web#0", a plausible-looking real reference rather than a visible
// placeholder. Once this crosses into a tool result a model or person can act on, that's a
// hazard, not a quirk. Fixed here — not in items.ts, which is out of scope for this task — by
// dropping `ref` from the dry-run response entirely and adding an explicit `dryRun: true` flag,
// so there is no numeric or string stand-in that could be mistaken for a real item.
function presentCreated<T extends { ref: unknown }>(created: T, dryRun: boolean): unknown {
  if (!dryRun) return created
  const { ref: _omittedDryRunRef, ...rest } = created
  return { ...rest, dryRun: true }
}

export type RefResolver = (token: string) => Promise<WorkItemRef>

// Wraps parseRef with a fallback through the alias map: a token parseRef rejects as unqualified
// is retried as "alias#number" before the error surfaces. Building the map costs one sibling
// .armature.json read per repository on the board (see aliases.ts), so it must not happen at
// startup or on every call. `cachedMap` is populated only once a build actually succeeds — the
// `await` sits to the right of `??=`, so a rejected build leaves `cachedMap` null and the next
// lookup retries cleanly, rather than replaying a stale failure forever. This mirrors
// GitHubBoardProvider.survey()'s `this.cached ??= await surveyBoard(...)` in provider.ts. Two
// concurrent first calls can each start a build; both produce the same map and either result is
// fine to cache, so no lock guards against that.
// main() constructs exactly one resolver and closes over it for the life of the process.
export function makeRefResolver(provider: BoardProvider, read: SiblingConfigReader): RefResolver {
  let cachedMap: AliasMap | null = null
  const getMap = async (): Promise<AliasMap> => {
    cachedMap ??= await provider.survey().then((snapshot) => buildAliasMap(read, snapshot.repositories))
    // Non-null: the line above either already found a cached map or just assigned one — a
    // rejection from the assignment's right side throws before this line, leaving cachedMap
    // untouched (see comment above). TS can't see that guarantee across the await, since getMap
    // is a closure the exported resolver may re-enter concurrently.
    return cachedMap!
  }

  return async (token: string): Promise<WorkItemRef> => {
    try {
      return parseRef(token)
    } catch (error) {
      if (!(error instanceof BareRefError)) throw error

      const trimmed = token.trim()
      const shape = ALIAS_REF.exec(trimmed)
      if (!shape) throw error // a bare number, or otherwise not alias-shaped: refuse as before

      const map = await getMap()
      const resolved = resolveAlias(map, trimmed)
      if (resolved) return resolved

      const known = [...map.keys()].sort()
      throw new Error(
        `Unknown alias "${shape[1]}" in "${trimmed}". ` +
          (known.length
            ? `Known aliases: ${known.join(', ')}.`
            : 'No repository on this board declares an alias.'),
      )
    }
  }
}

export type DispatchOptions = {
  dryRun: boolean
  /** Where mutation log lines go. Defaults to logMutation's own stderr writer. */
  logWrite?: (line: string) => void
  /**
   * Resolves a `ref` / `epic` / `parent` token to a WorkItemRef. Defaults to parseRef alone, so
   * dispatch stays testable without a real GitHubClient or board survey. main() overrides this
   * with a `makeRefResolver` instance that also retries an unqualified token through the alias
   * map before giving up.
   */
  resolveRef?: RefResolver
}

// The pure request-handling core, factored out of main() so it can run against any
// BoardProvider — real or a test double — without needing a credential, a network, or a live
// stdio transport. main() below is the only thing that wires this to an actual process.
export async function dispatch(
  provider: BoardProvider,
  name: string,
  args: Record<string, string>,
  options: DispatchOptions,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const resolveRef: RefResolver = options.resolveRef ?? (async (token) => parseRef(token))

  switch (name) {
    case 'board_survey':
      return ok(await provider.survey())

    case 'board_next': {
      const snapshot = await provider.survey()
      return ok(
        selectNext(snapshot, {
          repo: args.repo,
          epic: args.epic ? await resolveRef(args.epic) : undefined,
        }),
      )
    }

    case 'item_get':
      return ok(await provider.getItem(await resolveRef(args.ref!)))

    case 'item_claim': {
      const ref = await resolveRef(args.ref!)
      const before = await provider.getItem(ref)
      const after = await provider.claim(ref)
      logMutation(
        { ref: formatRef(ref), field: 'Status', before: before.status, after: after.status },
        options.logWrite,
      )
      return ok(after)
    }

    case 'item_status': {
      const ref = await resolveRef(args.ref!)
      const before = await provider.getItem(ref)
      const after = await provider.setStatus(ref, args.status!)
      logMutation(
        { ref: formatRef(ref), field: 'Status', before: before.status, after: after.status },
        options.logWrite,
      )
      return ok(after)
    }

    case 'item_create': {
      const [owner, repoName] = (args.repo ?? '').split('/')
      if (!owner || !repoName) throw new Error(`"repo" must be owner/name, got "${args.repo}".`)
      const created = await provider.create({
        owner,
        repo: repoName,
        title: args.title!,
        body: args.body!,
        parent: args.parent ? await resolveRef(args.parent) : undefined,
      })
      logMutation(
        {
          // See presentCreated above: a dry-run ref.number is not real, so the log gets the same
          // "(dry-run)" sentinel items.ts already uses for id/projectItemId, never a fake ref.
          ref: options.dryRun ? '(dry-run)' : formatRef(created.ref),
          field: 'created',
          before: null,
          after: created.title,
        },
        options.logWrite,
      )
      return ok(presentCreated(created, options.dryRun))
    }

    default:
      throw new Error(`Unknown tool "${name}".`)
  }
}

async function main(): Promise<void> {
  const credential = await resolveCredential({ readCliToken: readCliTokenFromGh, env: process.env })
  const client = new GitHubClient(credential)
  const config = await loadResolvedConfig({ env: process.env, client })

  // Constructed once per process: GitHubBoardProvider.survey() memoises for the life of the
  // instance, so building a fresh provider per call (as a naive wiring would) would survey the
  // board on every single tool invocation and throw the cache away each time.
  const provider = new GitHubBoardProvider(client, config.board, DRY_RUN)

  // Built once and closed over for the same reason: makeRefResolver caches the alias map
  // internally after its first build, and a fresh resolver per call would throw that cache away
  // and re-read every sibling's .armature.json on every tool invocation.
  const refResolver = makeRefResolver(provider, readSiblingConfigFrom(client))

  const server = new Server(
    { name: 'armature', version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, string>
    return dispatch(provider, request.params.name, args, { dryRun: DRY_RUN, resolveRef: refResolver })
  })

  await server.connect(new StdioServerTransport())
}

// Guarded so importing this module (as tests do, to exercise `dispatch`) never starts a real
// server, spawns `gh`, or hits the network — only running `node dist/server.js` (or this file)
// directly does.
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
