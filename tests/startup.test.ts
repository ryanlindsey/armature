import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// ------------------------------------------------------------------------------------------
// The failure this file exists for: `main()` resolved a credential and a board *before*
// `server.connect()`, so a directory with no board killed the process on startup — exit 1,
// message on a stderr nobody reads, and the MCP client reporting "✘ failed" with no way to
// learn why. A freshly installed plugin has no board by definition, so this was every first
// run. The server must connect first and answer for a missing board through the protocol.
//
// Exercised end to end against the real bundle over real stdio, because the bug was in the
// wiring between config, transport and process lifetime — the exact seam a unit test with an
// injected provider steps over.
// ------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('..', import.meta.url))

let bundle: string
let buildDir: string
const dirs: string[] = []

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'armature-startup-build-'))
  bundle = join(buildDir, 'server.js')
  await build({
    entryPoints: [join(root, 'server/index.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    logLevel: 'silent',
  })
}, 120_000)

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * A server started in a directory with no git remote, no .armature.json and no user config —
 * the state of any machine that just installed the plugin.
 *
 * GITHUB_TOKEN is a dummy so credential resolution is decided locally and the run stays
 * hermetic: with no origin there is nothing to ask GitHub about, so no request is made either
 * way, and the test asserts on the board error rather than racing whatever `gh` happens to hold.
 */
async function startInEmptyDir(): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), 'armature-startup-'))
  dirs.push(dir)

  const child = spawn(process.execPath, [bundle], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GITHUB_TOKEN: 'dummy-token-for-test',
      ARMATURE_BOARD: undefined,
      GH_TOKEN: undefined,
    } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return new Session(child)
}

class Session {
  private buffered = ''
  private readonly pending = new Map<number, (message: any) => void>()
  readonly stderr: string[] = []
  exited: number | null = null

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.stderr.push(chunk))
    child.on('exit', (code) => {
      this.exited = code
    })
  }

  private consume(chunk: string): void {
    this.buffered += chunk
    let index: number
    while ((index = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, index).trim()
      this.buffered = this.buffered.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      this.pending.get(message.id)?.(message)
      this.pending.delete(message.id)
    }
  }

  request(id: number, method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `no response to ${method} within 20s; ` +
                `exit=${this.exited} stderr=${this.stderr.join('')}`,
            ),
          ),
        20_000,
      )
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async handshake(): Promise<any> {
    return this.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'startup-test', version: '1' },
    })
  }

  stop(): void {
    this.child.kill()
  }
}

describe('a server started where no board is configured', () => {
  it('completes the MCP handshake instead of exiting', async () => {
    const session = await startInEmptyDir()
    try {
      const response = await session.handshake()
      expect(response.result?.serverInfo?.name).toBe('armature')
      expect(session.exited).toBeNull()
    } finally {
      session.stop()
    }
  }, 60_000)

  it('lists its tools, so the plugin is usable enough to explain itself', async () => {
    const session = await startInEmptyDir()
    try {
      await session.handshake()
      const response = await session.request(2, 'tools/list')
      expect(response.result.tools.map((t: { name: string }) => t.name)).toContain('board_next')
    } finally {
      session.stop()
    }
  }, 60_000)

  // The message that used to land on a stderr the client discards now reaches the caller, where
  // it can actually be acted on.
  it('answers a tool call with the board error rather than dying', async () => {
    const session = await startInEmptyDir()
    try {
      await session.handshake()
      const response = await session.request(3, 'tools/call', {
        name: 'board_next',
        arguments: {},
      })
      const text = JSON.stringify(response)
      expect(text).toMatch(/No board found/i)
      expect(text).toMatch(/ARMATURE_BOARD|\.armature\.json/)
      expect(session.exited).toBeNull()
    } finally {
      session.stop()
    }
  }, 60_000)
})
