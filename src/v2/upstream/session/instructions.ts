export * as SessionInstructions from "./instructions.js"

// Shim: upstream injects discovered AGENTS.md files as synthetic session
// messages through Bus/SessionStore. That machinery is out of scope for this
// plugin, so `load` is a no-op and discovery is inert.
import { Context, Effect } from "effect"

export interface Interface {
  readonly load: (input: {
    readonly sessionID: string
    readonly paths: ReadonlyArray<string>
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInstructions") {}
