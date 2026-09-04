import { build } from 'esbuild'

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
})
console.log('built dist/server.js')
