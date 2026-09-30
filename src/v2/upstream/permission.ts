export * as Permission from "./permission.js"

// Shim: upstream `permission.ts` wires a ruleset engine onto Bus/Session/Agent.
// The vendored edit/read tools only reach `Permission.Service.assert`; the
// actual gating for this plugin happens at the catalog level through each
// tool's `options.permission`, so `assert` is a pass-through here.
import { Context, Effect, Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Permission as PermissionSchema } from "@opencode/schema/permission"

export { Rule, Ruleset } from "@opencode/schema/permission"

export const ID = PermissionSchema.ID
export type ID = typeof ID.Type

export const Source = PermissionSchema.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: PermissionSchema.Request.fields.sessionID,
  action: PermissionSchema.Request.fields.action,
  resources: PermissionSchema.Request.fields.resources,
  save: PermissionSchema.Request.fields.save,
  metadata: PermissionSchema.Request.fields.metadata,
  source: PermissionSchema.Request.fields.source,
}

export const Request = PermissionSchema.Request
export type Request = typeof Request.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: Agent.ID.pipe(Schema.optional),
}).annotate({ identifier: "Permission.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export interface Interface {
  readonly assert: (input: AssertInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}
