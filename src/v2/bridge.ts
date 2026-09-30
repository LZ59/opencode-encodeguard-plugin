// V2 plugin bridge.
//
// The upstream `edit`/`read` implementations are Effect plugins: they take a
// plugin `Context` and register themselves through `ctx.tool.transform`,
// pulling their dependencies out of an Effect service graph. OpenCode loads
// this package through the *promise* plugin API, so this module:
//
//   1. builds the service graph the vendored sources expect (layers + shims),
//   2. runs the upstream `Plugin.effect` against a capture-only Context and
//      keeps the `editor.add` payloads,
//   3. re-registers those payloads with the host, converting each Effect
//      schema to a plain JSON Schema on *this* effect instance (the host's
//      `effect` is a different module instance, so Effect schemas must never
//      cross that boundary) and wrapping `execute` so it returns a promise.
//
// Everything downstream of step 2 — tool descriptions, input/output shapes,
// option flags, and the edit/read logic itself — is upstream's code, unmodified.

import { Effect, JsonSchema, Layer, Schema, SchemaRepresentation, type Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { Context as EffectContext } from "@opencode/plugin/effect/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { Plugin } from "@opencode/plugin"
import { Tool } from "@opencode/schema/tool"
import { FSUtil } from "@opencode/util/fs-util"

import { Environment } from "./upstream/environment/index.js"
import { Formatter } from "./upstream/formatter.js"
import { Location } from "./upstream/location.js"
import { Permission } from "./upstream/permission.js"
import { SessionInstructions } from "./upstream/session/instructions.js"
import { FileAccess } from "./upstream/file-access.js"
import { FileMutation } from "./upstream/file-mutation.js"
import { ReadToolFileSystem } from "./upstream/tool/read-filesystem.js"
import { EditTool } from "./upstream/tool/plugin/edit.js"
import { ReadTool } from "./upstream/tool/plugin/read.js"
import { fsUtilLayer } from "./fs-util.ts"

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

// The host resolves a session's directory at call time, and `Plugin.Context`
// only exposes the location the plugin was loaded under. `Location.Interface`
// is therefore a getter-backed view over a mutable slot that each `execute`
// fills in before running its effect (the upstream services read
// `location.directory` lazily inside their generators).
const locationSlot: { info: Location.Interface } = { info: undefined as unknown as Location.Interface }

const locationView: Location.Interface = {
  get directory() {
    return locationSlot.info.directory
  },
  get workspaceID() {
    return locationSlot.info.workspaceID
  },
  get project() {
    return locationSlot.info.project
  },
} as unknown as Location.Interface

type SessionLocation = { readonly directory?: string; readonly workspaceID?: string } | undefined

async function resolveLocation(ctx: Plugin.Context, sessionID: string): Promise<Location.Interface> {
  const fallback = ctx.location as Location.Interface
  let sessionLocation: SessionLocation
  try {
    const session = (await ctx.session.get({ sessionID })) as { location?: SessionLocation }
    sessionLocation = session.location
  } catch {
    sessionLocation = undefined
  }
  const directory = sessionLocation?.directory
  if (!directory) return fallback
  return {
    directory,
    workspaceID: sessionLocation?.workspaceID ?? fallback.workspaceID,
    project: fallback.project,
  } as unknown as Location.Interface
}

// ---------------------------------------------------------------------------
// Service graph
// ---------------------------------------------------------------------------

// `Environment.makeFiles` needs a ChildProcessSpawner for the process-backed
// defaults, but the local driver overrides every FilesImpl member with raw
// node:fs, so nothing here ever spawns a process.
const spawner = ChildProcessSpawner.make(() =>
  Effect.die(new Error("opencode-encodeguard-plugin never spawns child processes")),
)

const environment = { files: Environment.makeFiles(Environment.makeLocalDriver(spawner)) }

const permission: Permission.Interface = {
  // Gating happens at the catalog level through each tool's
  // `options.permission`; plugin tools cannot reach the host's rule engine.
  assert: () => Effect.void,
}

const formatter: Formatter.Interface = {
  file: () => Effect.succeed(false),
}

const sessionInstructions: SessionInstructions.Interface = {
  load: () => Effect.void,
}

const base = Layer.mergeAll(
  fsUtilLayer,
  Layer.succeed(Environment.Service, environment),
  Layer.succeed(Location.Service, locationView),
  Layer.succeed(Permission.Service, permission),
  Layer.succeed(Formatter.Service, formatter),
  Layer.succeed(SessionInstructions.Service, sessionInstructions),
)

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

// Host-side validation builds its codec from a plain draft-2020-12 object via
// `JsonSchema.fromSchemaDraft2020_12`, and `inputJsonSchema` passes a plain
// object through untouched for the model. Effect `Schema` values must not be
// handed over: they belong to this package's `effect` instance and the host's
// `Schema.decodeUnknownEffect` cannot decode them.
const toJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  return (
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions }
  ) as JsonSchema.JsonSchema
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const toToolContext = (context: ToolContext): Tool.Context => ({
  sessionID: context.sessionID,
  agent: context.agent,
  messageID: context.messageID,
  id: context.id,
  progress: (update) => Effect.promise(() => context.progress(update)),
})

/** Runs the upstream Effect plugins and collects what they register. */
async function capture(): Promise<ReadonlyArray<Tool.Info<any, any>>> {
  const captured: Array<Tool.Info<any, any>> = []
  const editor: ToolEditor = {
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    add: (tool) => {
      captured.push(tool as Tool.Info<any, any>)
    },
    update: () => {},
    remove: () => {},
  }
  const fake = {
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as EffectContext

  await Effect.runPromise(
    Effect.scoped(
      Effect.all([EditTool.Plugin.effect(fake), ReadTool.Plugin.effect(fake)]).pipe(
        Effect.provide(ReadToolFileSystem.layer),
        Effect.provide(FileMutation.layer),
        Effect.provide(FileAccess.layer),
        Effect.provide(base),
      ),
    ),
  )
  return captured
}

/**
 * Registers the upstream `edit` and `read` tools with the host, shadowing the
 * built-ins of the same name.
 */
export async function register(ctx: Plugin.Context): Promise<void> {
  locationSlot.info = ctx.location as Location.Interface
  const tools = await capture()

  const registered = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.options === undefined ? {} : { options: tool.options }),
    input: toJsonSchema(tool.input as Schema.Top),
    ...(tool.output === undefined ? {} : { output: toJsonSchema(tool.output as Schema.Top) }),
    async execute(rawInput: unknown, context: ToolContext) {
      // Re-read the session's location for this call; the upstream services
      // observe it through `Location.Interface`'s getters.
      locationSlot.info = await resolveLocation(ctx, context.sessionID)
      return Effect.runPromise(
        tool.execute(rawInput, toToolContext(context)) as Effect.Effect<Tool.Result, Tool.Error>,
      )
    },
  }))

  await ctx.tool.transform((editor) => {
    for (const tool of registered) editor.add(tool)
  })
}
