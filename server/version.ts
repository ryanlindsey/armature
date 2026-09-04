// The trailing annotation is what release-please's generic updater looks for. Without it a
// release bumps package.json and leaves this behind, and the committed dist/server.js then
// reports a version that no longer matches the plugin a user installed.
export const VERSION = '0.3.0' // x-release-please-version
