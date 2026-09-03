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
