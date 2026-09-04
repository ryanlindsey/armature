import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isEntryPoint } from '../server/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'armature-entrypoint-'))
  dirs.push(dir)
  return dir
}

describe('isEntryPoint', () => {
  it('recognises the module being run directly', () => {
    const dir = temp()
    const file = join(dir, 'server.js')
    writeFileSync(file, '')

    expect(isEntryPoint(pathToFileURL(file).href, file)).toBe(true)
  })

  // The failure this guards: Node resolves import.meta.url through symlinks, while argv[1] is
  // whatever the launcher was invoked as. A plugin launched through a symlinked dist/server.js
  // therefore compared a real path to a symlink path, found them unequal, and exited 0 with no
  // output — a dead MCP server that reported nothing at all.
  it('recognises the module when the launcher path is a symlink to it', () => {
    const dir = temp()
    const real = join(dir, 'server.js')
    const link = join(dir, 'launcher.js')
    writeFileSync(real, '')
    symlinkSync(real, link)

    expect(isEntryPoint(pathToFileURL(real).href, link)).toBe(true)
  })

  it('still recognises it when both sides are symlinks to one file', () => {
    const dir = temp()
    const real = join(dir, 'server.js')
    const link = join(dir, 'launcher.js')
    writeFileSync(real, '')
    symlinkSync(real, link)

    expect(isEntryPoint(pathToFileURL(link).href, link)).toBe(true)
  })

  it('does not fire when a different file is being run', () => {
    const dir = temp()
    const module = join(dir, 'server.js')
    const other = join(dir, 'other.js')
    writeFileSync(module, '')
    writeFileSync(other, '')

    expect(isEntryPoint(pathToFileURL(module).href, other)).toBe(false)
  })

  it('does not fire when there is no argv[1] at all', () => {
    const dir = temp()
    const module = join(dir, 'server.js')
    writeFileSync(module, '')

    expect(isEntryPoint(pathToFileURL(module).href, undefined)).toBe(false)
  })

  // Importing the module must never throw, whatever argv[1] happens to be.
  it('does not fire, and does not throw, when argv[1] names nothing on disk', () => {
    const dir = temp()
    const module = join(dir, 'server.js')
    writeFileSync(module, '')

    expect(isEntryPoint(pathToFileURL(module).href, join(dir, 'absent.js'))).toBe(false)
  })
})
