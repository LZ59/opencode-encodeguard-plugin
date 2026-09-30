// opencode-encodeguard-plugin: OpenCode plugin that replaces the built-in
// `edit` and `read` tools with encoding-aware variants, so files in GBK,
// GB18030, Big5, Shift_JIS, UTF-16 LE/BE, UTF-32, etc. don't get mojibake'd.
//
// Plugin tools that share a name with a built-in tool shadow the built-in:
// registering `edit` and `read` here overrides the stock versions.
//
// The tool logic is the OpenCode v2.0.12 source itself, vendored verbatim into
// `src/v2/upstream/` with two small classes of change:
//   * encoding-aware decode/encode at the I/O boundary (marked
//     `ENCODING PATCH`),
//   * shims for the host-internal services the vendored sources import
//     (`src/v2/upstream/*` files with a `Shim:` header).
// `src/v2/bridge.ts` builds the Effect service graph and hands the upstream
// registrations to the host.
// (https://opencode/v2/docs/plugins/)
//
// Install (npm):
//   npm i opencode-encodeguard-plugin
//   // in opencode.json: { "plugins": ["opencode-encodeguard-plugin"] }
//
// Install (local checkout) — configured path entries must be DIRECTORIES (a
// .ts path is rejected); the directory entry is index.ts:
//   // in opencode.json: { "plugins": ["/path/to/opencode-encodeguard-plugin"] }

import { Plugin } from "@opencode/plugin"
import { register } from "./src/v2/bridge.ts"

export default Plugin.define({
  id: "opencode.encodeguard",
  async setup(ctx) {
    await register(ctx)
  },
})
