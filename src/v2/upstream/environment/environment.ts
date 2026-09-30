import { Context } from "effect"
import type { Files } from "./files.js"

// Shim: upstream `environment.ts` binds a Driver (local, or a workspace
// placement) and also exposes the process `spawner`. Only `files` is read by
// the vendored edit/read tools, and the layer is supplied by the plugin
// bridge rather than the Location node graph.
export interface Interface {
  readonly files: Files
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Environment") {}

export * as EnvironmentService from "./environment.js"
