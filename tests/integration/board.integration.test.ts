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
    return new GitHubBoardProvider(
      new GitHubClient(credential),
      { provider: 'github', owner: owner!, number },
      { boardSource: 'env', dryRun: true },
    )
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

    // `if (!candidate) return` used to pass silently on a board with nothing to claim — a green
    // test that verified nothing. The board this suite runs against must be able to exercise
    // the assertion, or the suite must say it cannot.
    const candidate = snapshot.items.find((i) => i.status === snapshot.semantics.todo)
    expect(
      candidate,
      `the integration board must hold at least one item in "${snapshot.semantics.todo}"`,
    ).toBeDefined()

    const before = candidate!.status
    await p.claim(candidate!.ref)

    // A fresh provider, not `p.survey()` again: survey() memoises, so re-surveying the same
    // provider compared a cached object with itself and would have passed even if claim() had
    // moved the item. (The provider does now invalidate after a write, but a test of "the board
    // did not change" must not depend on the cache behaviour of the thing it is testing.)
    const reread = await (await provider()).survey()
    const after = reread.items.find((i) => i.id === candidate!.id)
    expect(after, 'the item vanished from the board between surveys').toBeDefined()
    expect(after!.status).toBe(before)
  })
})
