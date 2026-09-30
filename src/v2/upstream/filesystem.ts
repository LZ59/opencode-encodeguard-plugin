export * as FileSystem from "./filesystem.js"

// Shim: upstream `filesystem.ts` is a full read/list/find/write service. The
// vendored read tool only needs the `Content` schema it spreads into
// `FileContent`; the definition below is upstream's verbatim.
import { Schema } from "effect"

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type
