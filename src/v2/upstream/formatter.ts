export * as Formatter from "./formatter.js"

// Shim: upstream `Formatter` runs configured formatters through AppProcess.
// No formatter integration exists here, so `file` always reports "not run"
// and the edit tool takes its read-back path unchanged.
import { Context, Effect } from "effect"

export interface Interface {
  readonly file: (filepath: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Formatter") {}
