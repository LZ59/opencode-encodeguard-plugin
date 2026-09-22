// OpenCode V2 directory entrypoint.
//
// Configured `plugins` entries that are paths must be DIRECTORIES in V2
// (a configured .ts file is rejected with "configured plugin path must be a
// directory"). For a directory, `Host.resolve` probes `<dir>/server.*` and
// then `<dir>/index.*` — this file is that probe target, so
// `plugins: ["./"]` loads the plugin.
//
// The npm/bare-name and V1 file-path flows use package.json `main`/`exports`
// (and V1's `plugin: [".../opencode-encodeguard-plugin.ts"]` imports this
// entry module directly); both point at the real entry below.

export { default } from "./opencode-encodeguard-plugin.ts"
