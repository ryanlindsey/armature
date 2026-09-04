import { readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const outfile = 'dist/server.js'

await build({
  entryPoints: ['server/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
})

// The bundle is committed, so it is one of the places the version lives — and the only one
// release-please cannot regenerate from source. It bumps server/version.ts through a `generic`
// extra-file, which finds its line by the trailing `x-release-please-version` marker; esbuild
// inlines VERSION as a bare literal and drops that comment, leaving nothing here to find. So put
// it back. Without this the release PR opens with a bundle reporting the previous version, and
// CI's "bundle is current" step fails on the one commit that must be green.
//
// Anchored on the whole line and asserted to be unique. If esbuild ever renames the binding
// (a second module declaring `VERSION` would make this one `VERSION2`) or inlines it somewhere
// else, the marker would land on the wrong line or on several — and release-please's silence is
// indistinguishable from success until a release goes out wrong. Fail the build instead.
const ANCHOR = /^var VERSION = "\d+\.\d+\.\d+";$/gm

const bundle = await readFile(outfile, 'utf8')
const hits = bundle.match(ANCHOR) ?? []
if (hits.length !== 1) {
  throw new Error(
    `expected exactly one inlined VERSION literal in ${outfile}, found ${hits.length}. ` +
      'esbuild renamed, duplicated or dropped it, and release-please would stop bumping the ' +
      'bundle without saying so. Re-anchor the marker in esbuild.config.mjs before releasing.',
  )
}

await writeFile(outfile, bundle.replace(ANCHOR, '$& // x-release-please-version'))
console.log('built dist/server.js')
