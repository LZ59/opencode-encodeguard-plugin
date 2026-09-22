// opencode-encodeguard-plugin: OpenCode plugin that replaces the built-in
// `edit` and `read` tools with encoding-aware variants, so files in GBK,
// GB18030, Big5, Shift_JIS, UTF-16 LE/BE, UTF-32, etc. don't get mojibake'd.
//
// Plugin tools that share a name with a built-in tool shadow the built-in:
// registering `edit` and `read` here overrides the stock versions.
//
// The default export supports both plugin APIs from one entrypoint
// (https://opencode/v2/docs/plugins/#support-v1):
//   * OpenCode V2 reads `id` + `setup()`, which registers the tools through
//     `ctx.tool.transform`.
//   * OpenCode V1 (>= 1.18.29) calls `server()`, which returns the V1 `tool`
//     map. V1 releases older than 1.18.29 expect a function default export and
//     need plugin version 1.x.
//
// Install (npm):
//   npm i opencode-encodeguard-plugin
//   // in opencode.json: { "plugins": ["opencode-encodeguard-plugin"] }
//
// Install (local checkout, OpenCode V2) — configured path entries must be
// DIRECTORIES (a .ts path is rejected); the directory entry is index.ts:
//   // in opencode.json: { "plugins": ["/path/to/opencode-encodeguard-plugin"] }
//
// Install (OpenCode V1) — the `plugin` key accepts file paths:
//   // in opencode.json: { "plugin": [".../opencode-encodeguard-plugin.ts"] }

import { Plugin } from "@opencode/plugin"
import { edit } from "./tools/edit.ts"
import { read } from "./tools/read.ts"
import { makeV2Tools } from "./tools/v2.ts"

export default {
  ...Plugin.define({
    id: "opencode.encodeguard",
    async setup(ctx) {
      await ctx.tool.transform((editor) => {
        for (const tool of makeV2Tools(ctx)) editor.add(tool)
      })
    },
  }),
  // OpenCode V1 entrypoint; V2 ignores it.
  async server() {
    return { tool: { edit, read } }
  },
}
