export * as SessionErrors from "./error.js"

// Shim: upstream `session/error.ts` carries the whole session error taxonomy.
// The vendored `file-access` service only names `SessionErrors.NotFoundError`
// inside an error union that this plugin never produces.
import { Schema } from "effect"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Session.NotFoundError", {
  sessionID: Schema.String,
}) {}
