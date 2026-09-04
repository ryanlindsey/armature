import { hostnameOf, isGitHubHost, redactCredentials } from './url.js'

export type WorkItemRef = {
  owner: string
  repo: string
  number: number
}

const SEGMENT = '[A-Za-z0-9._-]+'
const SHORTHAND = new RegExp(`^(${SEGMENT})\\/(${SEGMENT})#(\\d+)$`)
// The host is captured rather than skipped: the path shape below is not distinctive — Gitea and
// Forgejo serve issues at exactly /owner/repo/issues/N — so which host it came from is the only
// thing that says whether this URL names a GitHub issue at all.
const URL_FORM = new RegExp(
  `^https?:\\/\\/([^/]+)\\/(${SEGMENT})\\/(${SEGMENT})\\/issues\\/(\\d+)(?:[/?#]|$)`,
)

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

export class ForeignHostError extends Error {
  constructor(input: string, host: string) {
    super(
      `"${redactCredentials(input)}" is hosted on ${host}, which armature cannot read. ` +
        `Armature talks to github.com only, and Gitea, Forgejo and GitLab all serve issues at ` +
        `the same /owner/repo/issues/number path — so reading this as a GitHub reference would ` +
        `name a different tracker's issue. Use a github.com URL, or owner/repo#number.`,
    )
    this.name = 'ForeignHostError'
  }
}

export function parseRef(input: string): WorkItemRef {
  const trimmed = input.trim()

  const shorthand = SHORTHAND.exec(trimmed)
  if (shorthand) {
    return { owner: shorthand[1]!, repo: shorthand[2]!, number: Number(shorthand[3]!) }
  }

  const url = URL_FORM.exec(trimmed)
  if (!url) throw new BareRefError(trimmed)

  // hostnameOf, not the raw capture: `[^/]+` takes the whole authority, userinfo included.
  const host = hostnameOf(url[1]!)
  if (!isGitHubHost(host)) throw new ForeignHostError(trimmed, host)
  return { owner: url[2]!, repo: url[3]!, number: Number(url[4]!) }
}

export function formatRef(ref: WorkItemRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}
