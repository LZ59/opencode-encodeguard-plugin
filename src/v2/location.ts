// Shared location helpers for the V2 tool implementations: the session's
// directory context and the permission-resource form of a path
// (location-relative with forward slashes inside the location or its
// project/worktree, absolute otherwise — mirrors FileAccess.resolve).

import * as path from "node:path"
import * as os from "node:os"

/** Directory context of the executing session (resolved per call by tools/v2.ts). */
export interface V2Location {
  directory: string
  projectDirectory?: string
}

// Resolve a lexical tool path against the session directory, with `~` home
// expansion — mirrors FileAccess.resolvePath (minus the home override).
export function resolveLexical(directory: string, input: string): string {
  let normalized = input
  if (normalized === "~") {
    normalized = os.homedir()
  } else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = path.join(os.homedir(), normalized.slice(2))
  }
  let absolute = path.resolve(directory, normalized)
  if (process.platform === "win32") absolute = absolute.replace(/\//g, "\\")
  return absolute
}

const slash = (value: string) => value.replaceAll("\\", "/")

const contains = (base: string, target: string) => {
  const relative = path.relative(base, target)
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)
}

export function resourceFor(location: V2Location, absolute: string): string {
  const project = location.projectDirectory
  const internal =
    contains(location.directory, absolute) ||
    (project !== undefined && project !== path.parse(project).root && contains(project, absolute))
  return internal ? slash(path.relative(location.directory, absolute) || ".") : slash(absolute)
}
