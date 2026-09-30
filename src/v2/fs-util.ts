// Minimal `FSUtil.Service` implementation for the plugin bridge.
//
// The published `FSUtil.layer` needs effect's `FileSystem.FileSystem`, whose
// node implementation lives outside this package's dependency graph. Only four
// members are ever reached by the vendored edit/read sources, so those are
// implemented directly over `node:fs` and the rest of the interface is left
// unimplemented (calling it throws, which surfaces as an effect defect).
//
//   * file-access: `stat` (external-directory boundary), `up` (via Project.root)
//   * read:        `resolve`, `up`, `readDirectory`
//   * file-mutation uses the *static* `FSUtil.resolve`, not this service.

import fs from "node:fs/promises"
import path from "node:path"
import { Effect, FileSystem, Layer, Option } from "effect"
import { systemError, type PlatformError } from "effect/PlatformError"
import { FSUtil } from "@opencode/util/fs-util"

const missing = (cause: unknown) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

const failure = (method: string, target: string, cause: unknown): PlatformError =>
  systemError({
    _tag: missing(cause) ? "NotFound" : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause,
  })

const info = (stats: Awaited<ReturnType<typeof fs.stat>>): FileSystem.File.Info =>
  ({
    type: stats.isDirectory()
      ? "Directory"
      : stats.isFile()
        ? "File"
        : stats.isSymbolicLink()
          ? "SymbolicLink"
          : "Unknown",
    mtime: Option.some(stats.mtime),
    atime: Option.some(stats.atime),
    birthtime: Option.some(stats.birthtime),
    dev: stats.dev,
    ino: Option.some(stats.ino),
    mode: stats.mode,
    nlink: Option.some(stats.nlink),
    uid: Option.some(stats.uid),
    gid: Option.some(stats.gid),
    rdev: Option.some(stats.rdev),
    size: BigInt(stats.size),
    blksize: Option.some(BigInt(stats.blksize)),
    blocks: Option.some(BigInt(stats.blocks)),
  }) as unknown as FileSystem.File.Info

const exists = (target: string) => fs.stat(target).then(() => true, () => false)

const stat = (target: string) =>
  Effect.tryPromise({
    try: () => fs.stat(target),
    catch: (cause) => failure("stat", target, cause),
  }).pipe(Effect.map(info))

const readDirectory = (target: string) =>
  Effect.tryPromise({
    try: () => fs.readdir(target),
    catch: (cause) => failure("readDirectory", target, cause),
  }).pipe(Effect.map((entries) => [...entries].sort((a, b) => a.localeCompare(b))))

const resolve = (target: string) => Effect.sync(() => FSUtil.resolve(target))

// Walk from `start` upwards collecting `<dir>/<target>` hits. `stop` is
// searched too (callers filter its matches out themselves); `mode: "first"`
// stops at the nearest directory that has a hit.
const up = (options: FSUtil.UpOptions) =>
  Effect.tryPromise({
    try: async () => {
      const stop = options.stop === undefined ? undefined : path.resolve(options.stop)
      const found: string[] = []
      let dir = path.resolve(options.start)
      const inside = (parent: string, child: string) => child.startsWith(parent + path.sep)
      for (;;) {
        const hits: string[] = []
        for (const target of options.targets) {
          const candidate = path.join(dir, target)
          if (await exists(candidate)) hits.push(candidate)
        }
        if (hits.length > 0) {
          found.push(...hits)
          if (options.mode === "first") break
        }
        if (stop !== undefined && (dir === stop || !inside(stop, dir))) break
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      return found
    },
    catch: (cause) => failure("up", options.start, cause),
  })

export const impl = {
  stat,
  readDirectory,
  resolve,
  up,
} as unknown as FSUtil.Interface

export const fsUtilLayer = Layer.succeed(FSUtil.Service, impl)
