export * as Tool from "./tool.js"

// Shim: upstream `tool.ts` is a large stateful service (registration, hooks,
// snapshots) that lives below the edit/read seam. The vendored tool sources
// only need the `Tool.Context` type, which upstream itself re-exports from
// `@opencode/schema/tool`.
export type { Context } from "@opencode/schema/tool"
