// OpenCode V2 adapters: registers the encoding-aware `edit` / `read` tools
// through `ctx.tool.transform` (see https://opencode.ai/v2/docs/plugins).
// A registration whose effective name matches a built-in tool shadows that
// built-in (the tool state is a map keyed by name; project plugins register
// after the core built-ins, so theirs wins).
//
// The tool logic lives in `../src/v2/edit.ts` and `../src/v2/read.ts`, which
// mirror the V2.0.12 built-ins (packages/core/src/tool/plugin/*) with an
// encoding-aware I/O boundary. This module only handles the plugin-context
// pieces:
//
//   * location: V2's execute context carries no `directory` / worktree, so
//     the session's location is resolved per call (falling back to the
//     plugin's own location) and passed into the implementations;
//   * registration: descriptions, input/output JSON Schemas and options
//     (`codemode: false`, `permission: "edit"` for catalog-level gating —
//     plugin tools cannot reach the permission service to assert per-path).
//
// Errors are thrown: the promise adapter runs execute as `Effect.promise`,
// so a rejection fails that tool call with the error's message (upstream
// ToolFailure-equivalent for the model).

import type { Plugin } from "@opencode/plugin"
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool"
import { DESCRIPTION as EDIT_DESCRIPTION, INPUT as EDIT_INPUT, OUTPUT as EDIT_OUTPUT, runEdit } from "../src/v2/edit.ts"
import type { EditParams } from "../src/v2/edit.ts"
import { DESCRIPTION as READ_DESCRIPTION, INPUT as READ_INPUT, OUTPUT as READ_OUTPUT, runRead } from "../src/v2/read.ts"
import type { ReadParams } from "../src/v2/read.ts"

interface ResolvedLocation {
  directory: string
  projectDirectory?: string
}

// The V2 execute context no longer exposes the session directory; ask the
// server for the session's location and fall back to where the plugin itself
// is loaded when the lookup fails. `session.location` carries only the
// directory (no project), so the worktree-aware part of the permission
// resource check falls back to the plugin's own project — it only affects
// path display in diffs/errors, not file access.
async function resolveLocation(ctx: Plugin.Context, sessionID: string): Promise<ResolvedLocation> {
  const projectDirectory: string | undefined = ctx.location.project?.directory
  try {
    const session = await ctx.session.get({ sessionID })
    const directory = session.location?.directory
    if (directory) return { directory, projectDirectory }
  } catch {
    // fall through to the plugin location
  }
  return { directory: ctx.location.directory, projectDirectory }
}

export function makeV2Tools(ctx: Plugin.Context): ToolInfo[] {
  return [
    {
      name: "edit",
      description: EDIT_DESCRIPTION,
      input: EDIT_INPUT,
      output: EDIT_OUTPUT,
      // The built-in declares `{ codemode: false, permission: "edit" }`;
      // permission maps the built-in edit rules onto this replacement at the
      // catalog level (deny-with-`*` hides the tool, e.g. for plan agents).
      options: { codemode: false, permission: "edit" },
      async execute(rawInput: unknown, context: ToolContext) {
        const params = rawInput as EditParams
        const location = await resolveLocation(ctx, context.sessionID)
        return await runEdit(params, location)
      },
    },
    {
      name: "read",
      description: READ_DESCRIPTION,
      input: READ_INPUT,
      output: READ_OUTPUT,
      // Matches the built-in read registration exactly; permission defaults
      // to the tool name ("read") for catalog-level gating.
      options: { codemode: false },
      async execute(rawInput: unknown, context: ToolContext) {
        const params = rawInput as ReadParams
        const location = await resolveLocation(ctx, context.sessionID)
        return await runRead(params, location)
      },
    },
  ]
}
