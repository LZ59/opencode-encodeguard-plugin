export * as Location from "./location.js"

// Shim: upstream builds `Location` by resolving a `Project` out of the
// database. Here the plugin context already carries the active location, so
// the service is a plain `Layer.succeed` of that value.
import { Context } from "effect"
import { Info } from "@opencode/schema/location"

export { Info }

export interface Interface extends Info {}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}
