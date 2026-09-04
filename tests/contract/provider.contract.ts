import { describe, expect, it } from 'vitest'
import { BareRefError, parseRef } from '../../server/ref.js'
import type { BoardProvider } from '../../server/providers/types.js'

/**
 * The backend-agnostic guarantees every adapter must satisfy. A Jira adapter's definition of
 * done is "pass these" rather than "read the GitHub adapter and imitate it".
 *
 * Most of these assertions iterate `snapshot.items`, which makes them vacuous over an empty
 * board — a provider returning zero items, computing no collisions and validating no refs used
 * to pass the whole suite. The first test below is therefore a precondition on the *fixture*,
 * not on the provider: it fails the suite outright if the board it was handed cannot exercise
 * the guarantees that follow.
 */
export function describeBoardProvider(
  name: string,
  makeProvider: () => Promise<BoardProvider>,
): void {
  describe(`${name} satisfies the board provider contract`, () => {
    // Read the precondition first: everything after it assumes this passed.
    it('is given a board that can actually exercise this contract', async () => {
      const snapshot = await (await makeProvider()).survey()

      expect(snapshot.items.length, 'the fixture board must hold items').toBeGreaterThan(0)

      const colliding = Object.entries(snapshot.collisions)
      expect(
        colliding.length,
        'the fixture board must hold at least one number claimed by two repositories — ' +
          'the collision the whole ref type exists for',
      ).toBeGreaterThan(0)

      const [number] = colliding[0]!
      const holders = snapshot.items.filter((i) => i.ref.number === Number(number))
      expect(holders.length).toBeGreaterThan(1)
      expect(
        new Set(holders.map((i) => i.title)).size,
        'the colliding items must be distinguishable, or the resolution assertion below could ' +
          'not fail even for a provider that returned the wrong one',
      ).toBe(holders.length)
    })

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

    it('names the board it describes, and where that identity came from', async () => {
      const snapshot = await (await makeProvider()).survey()
      expect(snapshot.board.provider).toBeTruthy()
      expect(snapshot.board.name).toBeTruthy()
      expect(['env', 'repo', 'user', 'derived']).toContain(snapshot.board.source)
    })

    it('reports collisions for numbers claimed by more than one repository', async () => {
      const snapshot = await (await makeProvider()).survey()
      for (const [, repos] of Object.entries(snapshot.collisions)) {
        expect(repos.length).toBeGreaterThan(1)
      }
    })

    it('detects all collisions: every number in multiple repos appears in snapshot.collisions', async () => {
      const snapshot = await (await makeProvider()).survey()

      // Build a map of number -> set of repos claiming it
      const numberToRepos = new Map<number, Set<string>>()
      for (const item of snapshot.items) {
        const repoId = `${item.ref.owner}/${item.ref.repo}`
        if (!numberToRepos.has(item.ref.number)) {
          numberToRepos.set(item.ref.number, new Set())
        }
        numberToRepos.get(item.ref.number)!.add(repoId)
      }

      // Forward direction: every number claimed by multiple repos must be in collisions with exact set
      for (const [number, repos] of numberToRepos) {
        if (repos.size > 1) {
          // This number is claimed by multiple repositories; must appear in collisions
          expect(number in snapshot.collisions).toBe(true)
          const expectedRepos = Array.from(repos).sort()
          const actualRepos = snapshot.collisions[number]!.sort()
          expect(actualRepos).toEqual(expectedRepos)
        }
      }

      // Reverse direction: every entry in collisions must correspond to a number that genuinely
      // appears in multiple repos with that exact repo set (no phantom entries)
      for (const [number, repos] of Object.entries(snapshot.collisions)) {
        const num = Number(number)
        expect(numberToRepos.has(num)).toBe(true)
        const actualRepos = Array.from(numberToRepos.get(num)!).sort()
        expect(actualRepos).toEqual(repos.sort())
      }
    })

    it('names a status for claimed, todo and done', async () => {
      const snapshot = await (await makeProvider()).survey()
      expect(snapshot.semantics.todo).toBeTruthy()
      expect(snapshot.semantics.claimed).toBeTruthy()
      expect(snapshot.semantics.done).toBeTruthy()
    })

    // This is the incident itself, asked of the provider rather than of parseRef.
    //
    // The assertion that used to sit here read `provider.getItem(parseRef('278'))` and expected a
    // throw — but parseRef throws before getItem is ever called, so it tested parseRef, and it
    // could not test the provider: BoardProvider.getItem takes an already-parsed ref, which is
    // exactly the design that makes a bare number inexpressible. What a provider can get wrong is
    // resolving a *qualified* ref to the wrong repository's item when the number is shared, and
    // that is what this checks.
    it('resolves a colliding number to the repository its ref names, and to no other', async () => {
      const provider = await makeProvider()
      const snapshot = await provider.survey()

      const collision = Object.entries(snapshot.collisions)[0]
      expect(collision, 'the fixture must supply a colliding number — see the precondition').toBeDefined()
      const [number, repos] = collision!

      for (const full of repos) {
        const [owner, repo] = full.split('/')
        const requested = { owner: owner!, repo: repo!, number: Number(number) }

        const item = await provider.getItem(requested)
        const onTheBoard = snapshot.items.find(
          (i) => i.ref.number === requested.number && `${i.ref.owner}/${i.ref.repo}` === full,
        )!

        expect(item.ref).toEqual(requested)
        expect(item.title).toBe(onTheBoard.title)
      }
    })
  })
}
