export * as Project from "./project.js"

// Shim: upstream `Project` is a database-backed service. The vendored
// `file-access` layer only calls the pure `Project.root` helper, which is
// vendored verbatim below.
import { Effect, Schema } from "effect"
import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import { AbsolutePath } from "./schema.js"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Project.NotFoundError", {
  projectID: Schema.String,
}) {}

// Keep this filesystem-only; permission checks use it and should not execute VCS commands.
export const root = Effect.fn("Project.root")(function* (
  fs: FSUtil.Interface,
  input: AbsolutePath,
  markers: readonly string[] = [".git", ".hg"],
) {
  return yield* fs.up({ targets: [...markers], start: input, mode: "first" }).pipe(
    Effect.map((matches) => (matches[0] ? AbsolutePath.make(path.dirname(matches[0])) : undefined)),
    Effect.orElseSucceed(() => undefined),
  )
})
