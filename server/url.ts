// URL facts armature needs in more than one place: whether a host is GitHub's, and how to render
// a URL that may carry a credential without leaking it. Both questions are asked by ref.ts (about
// a work item URL) and by config.ts (about a git remote), and answering them differently in the
// two places is exactly how one of them ends up wrong.

/**
 * Strips userinfo out of every scheme-qualified URL in `text`.
 *
 * `https://user:ghp_SECRET@github.com/acme/web/` is an ordinary GitHub remote — the credential
 * helper writes them, and so do CI checkouts. Any message that interpolates a remote, or echoes
 * git's stderr, therefore may carry a live token, and armature's messages travel to stderr and
 * to the MCP client. Applied to whole messages rather than to bare URLs so a git error that
 * quotes the remote is covered too.
 *
 * `git@github.com:acme/web.git` is left alone: the scp-like remote form carries a username and
 * cannot carry a password.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]*@/g, '$1***@')
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * The bare, lower-cased hostname of a URL authority — userinfo and port removed.
 *
 * A URL's authority is everything between `//` and the next `/`, which means a regex that
 * captures "the host" captures `user:ghp_SECRET@github.com` for a credential-carrying remote.
 * Naming that in an error would leak the token, so every message reports this instead.
 */
export function hostnameOf(authority: string): string {
  const lowered = authority.toLowerCase()
  return lowered.slice(lowered.lastIndexOf('@') + 1).replace(/:\d+$/, '')
}

/**
 * Whether `host` is a host armature can actually talk to.
 *
 * GitHubClient posts to `https://api.github.com/graphql` and nowhere else, so github.com is the
 * only host whose issues armature can read. The check matters because the URL shapes are not
 * distinctive: Gitea and Forgejo serve issues at `/owner/repo/issues/N`, and every forge uses
 * `/owner/repo` for remotes. Without it, `https://gitea.example/acme/web/issues/278` parsed
 * cleanly into `acme/web#278` and named a different tracker's issue.
 *
 * Accepts an authority component, so userinfo and a port are tolerated rather than mistaken for
 * part of the hostname.
 */
export function isGitHubHost(host: string): boolean {
  return GITHUB_HOSTS.has(hostnameOf(host))
}
