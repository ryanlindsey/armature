import { describe, expect, it } from 'vitest'
import { BareRefError, formatRef, parseRef } from '../../server/ref.js'
import type { WorkItemRef } from '../../server/ref.js'
import { selectNext } from '../../server/providers/github/next.js'
import type { BoardProvider } from '../../server/providers/types.js'

/**
 * What the fixture board holds beyond the guarantees every adapter owes.
 *
 * `epic` is optional because `BoardProvider.epic` is: an adapter that cannot report linked pull
 * requests declines epics, and its harness passes no epic ref, which skips that block. A harness
 * that does pass one is declaring the adapter supports epics, and the block holds it to that.
 *
 * `writes` is optional for the same reason `epic` is: a harness passes it to declare that its
 * adapter can be driven to create issues here, where `owner/repo` is the repository to create
 * in and `issuesCreated` counts every issue the backend has created so far — including ones a
 * failed call left behind, which is exactly what "nothing was created" has to be checked against.
 *
 * `checklist` is optional because `BoardProvider.check` is: a tracker whose items are not Markdown
 * has no task list to tick. A harness passes it — an item on the board whose checklist holds at
 * least two unticked entries and one ticked — to declare that its adapter implements `check`, and the block
 * holds it to that. Absent, the block is skipped.
 */
export type ContractFixture = {
  epic?: WorkItemRef
  writes?: { owner: string; repo: string; issuesCreated: () => number }
  checklist?: WorkItemRef
}

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
  fixture: ContractFixture = {},
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

    describe.skipIf(!fixture.epic)('epics, if the adapter reports them', () => {
      const epicRef = fixture.epic!

      it("returns the epic's children, and the epic itself is not among them", async () => {
        const provider = await makeProvider()
        expect(provider.epic, 'the harness named an epic, so the adapter must report one').toBeDefined()
        const survey = await provider.epic!(epicRef)
        expect(survey.children.length).toBeGreaterThan(0)
        expect(survey.children.map((c) => formatRef(c.ref))).not.toContain(formatRef(epicRef))
      })

      // Same-numbered children in different repositories must stay two children, each carrying
      // its own title — the collision the ref type exists for, asked of the epic path.
      it('keeps every child distinct and describes each by its own item', async () => {
        const provider = await makeProvider()
        const survey = await provider.epic!(epicRef)
        const refs = survey.children.map((c) => formatRef(c.ref))
        expect(new Set(refs).size).toBe(refs.length)
        for (const child of survey.children) {
          expect(child.title).toBe((await provider.getItem(child.ref)).title)
        }
      })

      // Two rankings that could disagree is a bug waiting to be written: epic_survey's `next`
      // must be board_next's answer, not a second opinion.
      it('agrees with board_next about which child is next', async () => {
        const provider = await makeProvider()
        const survey = await provider.epic!(epicRef)
        const next = selectNext(await provider.survey(), { epic: epicRef })
        // Two nulls would agree about nothing: the fixture must give the ranking something to rank.
        expect(next.kind, 'the fixture epic must have an actionable child').toBe('item')
        expect(survey.next.ref).toEqual(next.kind === 'item' ? next.item.ref : null)
        expect(survey.next.because).toBe(next.because)
      })
    })

    // Optional capability. A tracker whose items are not Markdown has no checklist, so this is not
    // part of the surface every adapter must implement — but an adapter that does implement it
    // must implement it this way.
    describe.skipIf(!fixture.checklist)('checklists, if the adapter has them', () => {
      const ref = fixture.checklist!

      it('ticks an entry and reports it ticked when the item is read again', async () => {
        const provider = await makeProvider()
        expect(provider.check, 'the harness named a checklist item, so the adapter must implement check')
          .toBeDefined()
        const before = await provider.getItem(ref)
        const target = before.checklist?.find((e) => !e.checked)
        expect(target, 'the fixture item must hold an unticked entry').toBeDefined()

        await provider.check!(ref, [{ text: target!.text, checked: true }])

        const after = await provider.getItem(ref)
        expect(after.checklist!.find((e) => e.text === target!.text)!.checked).toBe(true)
      })

      it('unticks an entry and reports it unticked when the item is read again', async () => {
        const provider = await makeProvider()
        const before = await provider.getItem(ref)
        const target = before.checklist?.find((e) => e.checked)
        expect(target, 'the fixture item must hold a ticked entry').toBeDefined()

        await provider.check!(ref, [{ text: target!.text, checked: false }])

        const after = await provider.getItem(ref)
        expect(after.checklist!.find((e) => e.text === target!.text)!.checked).toBe(false)
      })

      it('leaves every entry unchanged when one entry in the batch is unmatched', async () => {
        const provider = await makeProvider()
        const before = await provider.getItem(ref)
        const target = before.checklist?.find((e) => !e.checked)
        expect(target, 'the fixture item must hold an unticked entry').toBeDefined()

        await expect(
          provider.check!(ref, [
            { text: target!.text, checked: true },
            { text: 'no entry reads this', checked: true },
          ]),
        ).rejects.toThrow()

        const after = await provider.getItem(ref)
        expect(after.checklist).toEqual(before.checklist)
      })
    })

    describe.skipIf(!fixture.writes)('creating items, if the harness can', () => {
      const into = fixture.writes!
      const blockersOf = (item: unknown) => (item as { blockedBy?: WorkItemRef[] }).blockedBy

      it('files a new item in the status it is asked for, and reads it back so', async () => {
        const provider = await makeProvider()
        const { semantics } = await provider.survey()
        const created = await provider.create({
          owner: into.owner, repo: into.repo, title: 'contract: status', body: '',
          status: semantics.claimed,
        })
        expect((await provider.getItem(created.ref)).status).toBe(semantics.claimed)
      })

      // The collision the ref type exists for, asked of the write path: two blockers sharing a
      // number must land as two, each still naming its own repository.
      it('marks a new item blocked by same-numbered items in two repositories, fully qualified', async () => {
        const provider = await makeProvider()
        const snapshot = await provider.survey()
        const [number, repos] = Object.entries(snapshot.collisions)[0]!
        const blockers = repos.slice(0, 2).map((full) => {
          const [owner, repo] = full.split('/')
          return { owner: owner!, repo: repo!, number: Number(number) }
        })

        const created = await provider.create({
          owner: into.owner, repo: into.repo, title: 'contract: blockers', body: '',
          blockedBy: blockers,
        })
        const read = blockersOf(await provider.getItem(created.ref))
        expect(read, 'getItem must report blockedBy').toBeDefined()
        expect(read!.map(formatRef).sort()).toEqual(blockers.map(formatRef).sort())
        for (const ref of read!) expect(() => parseRef(formatRef(ref))).not.toThrow()
      })

      it('refuses a status the board does not offer, and creates nothing', async () => {
        const provider = await makeProvider()
        const before = into.issuesCreated()
        await expect(provider.create({
          owner: into.owner, repo: into.repo, title: 'contract: refused', body: '',
          status: 'No Such Status Anywhere',
        })).rejects.toThrow(/No Such Status Anywhere/)
        expect(into.issuesCreated()).toBe(before)
      })
    })
  })
}
