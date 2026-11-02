export * as Project from "./project.js"

// Shim: upstream `Project` is a database-backed service. The vendored
// `file-access` layer only calls the pure `Project.root` helper, which is
// vendored verbatim below.
import { Effect, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "./schema.js"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Project.NotFoundError", {
  projectID: Schema.String,
}) {}

// Keep this filesystem-only; permission checks use it and should not execute VCS commands.
export const root = Effect.fn("Project.root")(
  function* (
    fs: { readonly exists: (path: string) => Effect.Effect<boolean, unknown> },
    input: AbsolutePath,
    markers: readonly string[] = [".git", ".hg"],
  ) {
    for (let current: string = input; ; current = path.dirname(current)) {
      for (const marker of markers) {
        if (yield* fs.exists(path.join(current, marker))) return AbsolutePath.make(current)
      }
      if (path.dirname(current) === current) return undefined
    }
  },
  Effect.orElseSucceed(() => undefined),
)
