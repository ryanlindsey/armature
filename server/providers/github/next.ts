import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardItem, BoardSnapshot } from '../types.js'

export type NextResult =
  | { kind: 'item'; item: BoardItem; because: string }
  | { kind: 'blocked'; because: string }

const EPIC_TITLE = /\bEpic\s+(\d+)\b/i

// A spec or an epic is never work, whether or not it has children on the board yet. The parent
// rule in selectNext catches an epic once its first child is filed; this catches the window
// before that, and a spec, which is filed before its plan exists (ryanlindsey/armature#75).
// Anchored at the start so a Conventional Commit scope — `feat(epic): …` — is still work.
const NOT_WORK_TITLE = /^\s*(spec|epic)\s*:/i

const SHOWN_EXCLUSIONS = 5

// Loud, not silent: a real work item whose title happens to start "Spec:" would otherwise never
// be chosen, and nothing would say so.
function excludedNote(items: BoardItem[]): string {
  if (items.length === 0) return ''
  const shown = items.slice(0, SHOWN_EXCLUSIONS).map((i) => formatRef(i.ref)).join(', ')
  const more = items.length > SHOWN_EXCLUSIONS ? ` and ${items.length - SHOWN_EXCLUSIONS} more` : ''
  return ` ${items.length} item(s) excluded by a "Spec:" or "Epic:" title: ${shown}${more}.`
}

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

  // `!== undefined`, not truthiness: a model asked for an optional string it has nothing to say
  // about passes "". Treated as falsy, that silently became "no filter" — board_next answered
  // about the whole board while the caller believed it had narrowed the question, and the
  // `because` never mentioned a filter at all. An empty filter now matches nothing and says so.
  const repoLower = options.repo?.toLowerCase()
  const inRepo =
    repoLower !== undefined
      ? children.filter((i) => `${i.ref.owner}/${i.ref.repo}`.toLowerCase() === repoLower)
      : children

  // Lower-cased on both sides for the same reason `repo` is: `epic` arrives from a person or a
  // model, and GitHub's own casing is what the board reports. Matching exactly through formatRef
  // meant `--epic ACME/platform#10` reported the epic "not found" — failing loud, but stating
  // something false.
  const epicKey = options.epic ? key(options.epic).toLowerCase() : undefined
  const underEpic =
    epicKey !== undefined
      ? inRepo.filter((i) => i.parent !== null && key(i.parent).toLowerCase() === epicKey)
      : inRepo

  // `underEpic` has already lost every parent, so anything dropped here was dropped for its
  // title alone — the only exclusions worth reporting.
  const open = underEpic.filter((i) => i.status === todo && i.state === 'OPEN')
  const excluded = open.filter((i) => NOT_WORK_TITLE.test(i.title))
  const actionable = open.filter((i) => !NOT_WORK_TITLE.test(i.title))
  const note = excludedNote(excluded)

  if (actionable.length === 0) {
    if (inRepo.length === 0 && options.repo !== undefined) {
      return {
        kind: 'blocked',
        because: `No items matching filter "${options.repo}" found on board.`,
      }
    }
    if (underEpic.length === 0 && options.epic) {
      return {
        kind: 'blocked',
        because: `No items matching epic filter ${formatRef(options.epic)} found on board.`,
      }
    }
    const scope = options.repo !== undefined ? ` in "${options.repo}"` : ''
    return {
      kind: 'blocked',
      because:
        `Nothing is actionable${scope}: no open item sits in "${todo}". ` +
        `${underEpic.length} item(s) were considered.${note}`,
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
    because: `${formatRef(chosen.ref)} is ${parentNote}. ${ranked.length - 1} other item(s) queued behind it.${note}`,
  }
}
