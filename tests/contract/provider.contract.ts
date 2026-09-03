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
