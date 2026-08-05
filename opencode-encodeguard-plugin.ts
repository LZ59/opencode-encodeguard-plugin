// opencode-encodeguard-plugin: OpenCode plugin that replaces the built-in
// `edit` and `read` tools with encoding-aware variants, so files in GBK,
// GB18030, Big5, Shift_JIS, UTF-16 LE/BE, UTF-32, etc. don't get mojibake'd.
//
// Per OpenCode plugin docs, plugin tools shadow built-in tools of the same
// name — so registering `edit` and `read` here overrides the stock versions.
//
// Install (npm):
//   npm i opencode-encodeguard-plugin
//   // in opencode.json: { "plugin": ["opencode-encodeguard-plugin"] }
//
// Install (local checkout):
//   // in opencode.json: { "plugin": ["./.opencode/plugins/opencode-encodeguard-plugin.mjs"] }

import type { Plugin } from "@opencode-ai/plugin"
import { edit } from "./tools/edit.ts"
import { read } from "./tools/read.ts"

export const EncodingGuardPlugin: Plugin = async () => {
  return {
    tool: { edit, read },
  }
}

export default EncodingGuardPlugin
