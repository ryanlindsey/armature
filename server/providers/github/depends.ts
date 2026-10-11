import { formatRef, type WorkItemRef } from '../../ref.js'
import { codeMask } from './checklist.js'

// The canonical `Depends on` line, and the only dependency prose the server reads or writes.
//
// working-the-board's prerequisite check reads this prose, not the native blockedBy links, so the
// two must agree after every armature write (spec ryanlindsey/armature#93). This module is the
// pure half of that: parsing the canonical set out of a body, and producing a body whose canonical
// set equals a given blocker set while leaving every other byte where it was.
//
// Deliberately narrow. Exactly ``Depends on `owner/repo#N` ``, alone on its line (surrounding
// whitespace allowed), one ref per line, outside code. "blocked by …", two refs on a line, a bare
// `#128` or a list marker in front are prose the server leaves alone: rewriting a sentence into
// canonical lines is a judgment, and it belongs to the skill.
const CANONICAL = /^Depends on `([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9]\d*)`$/

export type DependsSync = { body: string; added: WorkItemRef[]; removed: WorkItemRef[] }

// A body ends inside a fence that never closes, so a line appended to it would be code. GitHub
// renders an unclosed fence to the end of the document, and a Depends on line written there is
// invisible to every reader, the prerequisite check included.
export class UnclosedFenceError extends Error {
  constructor(refs: WorkItemRef[]) {
    super(
      `Cannot add ${refs.map((r) => `Depends on \`${formatRef(r)}\``).join(', ')} to this body: ` +
        `it ends inside a code fence that is never closed, so an appended line would be code, ` +
        `not prose. Nothing was changed. Close the fence (add a matching \`\`\` or ~~~ line) ` +
        `with item_update, then retry.`,
    )
    this.name = 'UnclosedFenceError'
  }
}

export function dependsOnLine(ref: WorkItemRef): string {
  return `Depends on \`${formatRef(ref)}\``
}

// Canonical lines outside code, in body order, distinct on owner/repo case-insensitively and
// number exactly. The first spelling seen is the one reported.
export function parseDependsOn(body: string): WorkItemRef[] {
  const lines = splitLines(body)
  const mask = codeMask(body)
  const seen = new Set<string>()
  const refs: WorkItemRef[] = []
  lines.forEach((line, i) => {
    const ref = canonicalRef(line.text, mask[i]!)
    if (!ref || seen.has(refKey(ref))) return
    seen.add(refKey(ref))
    refs.push(ref)
  })
  return refs
}

// A body whose canonical set equals `blockers`.
//
// Removes every canonical line whose ref is not a blocker, and every repeat of one already seen
// (the first stays), each with its own line ending. Adds a line for each blocker that has none,
// in the order given: directly after the last canonical line that remains, or, when none does, at
// the end after one blank line. New lines use the body's line ending (`\r\n` if it has one).
//
// `removed` names refs that left the set, in body order. A repeat dropped while its ref stays a
// blocker is not a dependency removed, so it is not listed. When nothing needs changing the input
// is returned byte-for-byte.
export function syncDependsOn(body: string, blockers: WorkItemRef[]): DependsSync {
  const target = distinct(blockers)
  const targetKeys = new Set(target.map(refKey))

  const lines = splitLines(body)
  const mask = codeMask(body)
  const kept: Line[] = []
  const seen = new Set<string>()
  const removedKeys = new Set<string>()
  const removed: WorkItemRef[] = []
  let dropped = false
  let anchor = -1 // index in `kept` of the last canonical line kept

  lines.forEach((line, i) => {
    const ref = canonicalRef(line.text, mask[i]!)
    if (!ref) {
      kept.push({ ...line })
      return
    }
    const key = refKey(ref)
    if (!targetKeys.has(key) || seen.has(key)) {
      dropped = true
      if (!targetKeys.has(key) && !removedKeys.has(key)) {
        removedKeys.add(key)
        removed.push(ref)
      }
      return
    }
    seen.add(key)
    kept.push({ ...line })
    anchor = kept.length - 1
  })

  const added = target.filter((ref) => !seen.has(refKey(ref)))
  if (!dropped && added.length === 0) return { body, added: [], removed: [] }

  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const fresh = added.map(dependsOnLine)

  if (added.length === 0) return { body: join(kept), added, removed }

  if (anchor >= 0) {
    const at = kept[anchor]!
    // The anchor ends the body: it gains a line ending, and the last new line inherits its lack.
    const endsBody = at.eol === ''
    if (endsBody) at.eol = eol
    const inserted = fresh.map((text, i) => ({
      text,
      eol: endsBody && i === fresh.length - 1 ? '' : eol,
    }))
    kept.splice(anchor + 1, 0, ...inserted)
    return { body: join(kept), added, removed }
  }

  // No canonical line remains: append. Trailing whitespace-only lines go, then one blank line.
  while (kept.length > 0 && /^[ \t]*$/.test(kept[kept.length - 1]!.text)) kept.pop()
  const finalNewline = /\n$/.test(body) ? eol : ''
  let prefix = ''
  if (kept.length > 0) {
    kept[kept.length - 1]!.eol = ''
    prefix = join(kept) + eol + eol
  }
  const result = prefix + fresh.join(eol) + finalNewline

  // Appending is the one place a new line can land in code: after a fence that never closes.
  const resultMask = codeMask(result)
  const firstNew = splitLines(prefix).length - 1
  if (resultMask.slice(firstNew, firstNew + fresh.length).some(Boolean)) {
    throw new UnclosedFenceError(added)
  }
  return { body: result, added, removed }
}

// Set equality: owner/repo case-insensitive, number exact.
export function sameRefSet(a: WorkItemRef[], b: WorkItemRef[]): boolean {
  const left = new Set(a.map(refKey))
  const right = new Set(b.map(refKey))
  return left.size === right.size && [...left].every((key) => right.has(key))
}

type Line = { text: string; eol: string }

// Lines with their own endings, so a removal takes exactly its line and mixed endings survive.
// Splits on `\r?\n` exactly as codeMask does, so line i here is mask index i there.
function splitLines(body: string): Line[] {
  const parts = body.split(/(\r?\n)/)
  const lines: Line[] = []
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i]!, eol: parts[i + 1] ?? '' })
  return lines
}

function join(lines: Line[]): string {
  return lines.map((line) => line.text + line.eol).join('')
}

function canonicalRef(text: string, isCode: boolean): WorkItemRef | null {
  if (isCode) return null
  const match = CANONICAL.exec(text.trim())
  if (!match) return null
  // Past 2^53 the number is not the one written, and would not round-trip through dependsOnLine.
  const number = Number(match[3]!)
  if (!Number.isSafeInteger(number)) return null
  return { owner: match[1]!, repo: match[2]!, number }
}

function refKey(ref: WorkItemRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`
}

function distinct(refs: WorkItemRef[]): WorkItemRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = refKey(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
