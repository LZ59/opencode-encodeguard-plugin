// OpenCode V2 `read` tool: encoding-aware reimplementation aligned with the
// V2.0.12 built-in (opencode packages/core/src/tool/plugin/read.ts and
// tool/read-filesystem.ts).
//
// Behavior mirrors the built-in exactly:
//   * input field descriptions; `offset` 1-based, `limit` capped at 2000;
//   * magic-byte media detection (Mime.detect): png/jpeg/gif/webp/pdf are
//     returned as base64 file parts with "Image read successfully" /
//     "PDF read successfully" text, over the 20 MiB ingest limit fails;
//   * small files without offset/limit come back whole as
//     `{ type: "file", encoding: "utf8" }`; larger files or paged reads use
//     `{ type: "text-page" }` with CR-stripped lines, 2000-char line cap,
//     50 KiB byte cap, `truncated`/`next` continuation;
//   * directories return `{ type: "list-page" }` — directories first, then
//     localeCompare order, trailing `path.sep` on directories;
//   * `toModelContent` formatting: `Read file <path>, lines A-B` +
//     `<line>: <content>` prefixes + `[Output truncated. Continue reading
//     with offset: N]`, `Read directory ...` headers;
//   * errors verbatim: `File not found: ...` (+ "Did you mean one of these?"
//     suggestions), `Cannot read binary file: ...`, `Offset N is out of
//     range`, `Media exceeds ... byte ingestion limit: ...`, `Path is not a
//     file or directory: ...`;
//   * NBSP/narrow-NBSP filename recovery (alternatePath) and metadata
//     `{ truncated }`.
//
// The ONLY behavioral delta is the I/O boundary: instead of the UTF-8-only
// `ReadToolFileSystem`, text files are decoded in their original encoding
// (GBK, GB18030, Big5, Shift_JIS, UTF-16 LE/BE, UTF-32, ...) — so UTF-16
// files read as text here instead of tripping the upstream raw-null-byte
// BinaryFileError, and GBK files render instead of mojibake. Binary
// detection therefore runs on the decoded text (U+0000 present) rather than
// raw bytes.
//
// Not replicable from a plugin (no API surface on the promise plugin
// context), documented in README: the AGENTS.md discovery/injection into
// session instructions after a successful read.

import * as path from "node:path"
import * as fs from "node:fs"
import * as url from "node:url"
import { createRequire } from "node:module"
import { decodeFile } from "../encoding.ts"
import type { Result as ToolResult } from "@opencode/plugin/promise/tool"
import { resourceFor, resolveLexical, type V2Location } from "./location.ts"

export type { V2Location }

export interface ReadParams {
  path: string
  offset?: number
  limit?: number
}

export const DESCRIPTION = `Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.

This is the encoding-aware variant: identical behavior, but text files are decoded in their original encoding (GBK, GB18030, Big5, Shift_JIS, UTF-16, etc.) instead of assuming UTF-8.`

export const INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "File or directory to read" },
    offset: {
      type: "integer",
      minimum: 0,
      description: "The line or directory entry to start reading from (1-based)",
    },
    limit: {
      type: "integer",
      minimum: 0,
      maximum: 2000,
      description: "The maximum number of lines or directory entries to read (defaults to 2000)",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const

export const OUTPUT = {
  oneOf: [
    {
      type: "object",
      title: "ReadTool.FileContent",
      properties: {
        type: { type: "string", enum: ["file"] },
        uri: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        mime: { type: "string" },
      },
      required: ["type", "uri", "content", "encoding", "mime"],
      additionalProperties: false,
    },
    {
      type: "object",
      title: "ReadTool.TextPage",
      properties: {
        type: { type: "string", enum: ["text-page"] },
        content: { type: "string" },
        mime: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        truncated: { type: "boolean" },
        next: { type: "integer", minimum: 1 },
      },
      required: ["type", "content", "mime", "offset", "truncated"],
      additionalProperties: false,
    },
    {
      type: "object",
      title: "ReadTool.ListPage",
      properties: {
        type: { type: "string", enum: ["list-page"] },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              type: { type: "string", enum: ["file", "directory", "symlink"] },
            },
            required: ["path", "type"],
            additionalProperties: false,
          },
        },
        truncated: { type: "boolean" },
        next: { type: "integer", minimum: 1 },
      },
      required: ["type", "entries", "truncated"],
      additionalProperties: false,
    },
  ],
} as const

// ---------------------------------------------------------------------------
// Constants — verbatim from tool/read-filesystem.ts.
// ---------------------------------------------------------------------------

const MAX_READ_LINES = 2_000
const MAX_READ_BYTES = 50 * 1024
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const FIRST_CHUNK = 256 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MEDIA_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

/** Failures whose message passes through verbatim (upstream tagged errors). */
class ReadFailure extends Error {}

// ---------------------------------------------------------------------------
// Media detection — verbatim port of packages/core/src/mime.ts (Mime.detect).
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  return controls / bytes.length <= 0.3
}

function detectMime(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  if (
    startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]) &&
    (startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x66]) || startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x73]))
  )
    return "image/avif"
  return isText(bytes) ? "text/plain" : "application/octet-stream"
}

// Extension-based mime for text outputs — same `mime-types` lookup the
// built-in uses (loaded defensively like iconv-lite).
let mimeTypes: any = null
try {
  mimeTypes = createRequire(import.meta.url)("mime-types")
} catch {
  mimeTypes = null
}

function lookupMime(filePath: string): string {
  return (mimeTypes && mimeTypes.lookup && mimeTypes.lookup(filePath)) || "application/octet-stream"
}

// ---------------------------------------------------------------------------
// Output shapes — mirror read-filesystem.ts.
// ---------------------------------------------------------------------------

interface FileOutput {
  type: "file"
  uri: string
  name: string
  content: string
  encoding: "utf8" | "base64"
  mime: string
}

interface TextPageOutput {
  type: "text-page"
  content: string
  mime: string
  offset: number
  truncated: boolean
  next?: number
}

interface ListEntry {
  path: string
  type: "file" | "directory" | "symlink"
}

interface ListPageOutput {
  type: "list-page"
  entries: ListEntry[]
  truncated: boolean
  next?: number
}

type ReadOutput = FileOutput | TextPageOutput | ListPageOutput

interface TextPart {
  readonly type: "text"
  readonly text: string
}

interface FilePart {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

// ---------------------------------------------------------------------------
// Model-facing content — verbatim port of read.ts `toModelContent`.
// ---------------------------------------------------------------------------

export function toModelContent(
  path: string,
  offset: number | undefined,
  output: ReadOutput,
): string | readonly (TextPart | FilePart)[] {
  if (output.type === "file" && output.encoding === "base64")
    return [
      { type: "text", text: output.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
      {
        type: "file",
        uri: `data:${output.mime};base64,${output.content}`,
        mime: output.mime,
        name: path,
      },
    ] as const

  if (output.type === "list-page") {
    const start = offset || 1
    const content = [
      output.entries.length === 0
        ? `Read directory ${path}, 0 entries`
        : `Read directory ${path}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    output.entries.forEach((entry) => content.push(entry.path))
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const start = output.type === "text-page" ? output.offset : 1
  // Pages already join selected lines; a trailing newline represents a selected blank line.
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  const lines = output.content === "" ? [] : text.split("\n")
  const content = [
    lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
  ]
  lines.forEach((line, index) => content.push(`${start + index}: ${line}`))
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
  return content.join("\n")
}

// ---------------------------------------------------------------------------
// Paging — port of read-filesystem.ts `textPage` over decoded text (the
// built-in applies the same selection rules to raw UTF-8 bytes; decoding
// first is the encoding-aware delta). eof is always true here: the whole
// file has been read.
// ---------------------------------------------------------------------------

function textPage(decoded: string, offsetParam: number | undefined, limitParam: number | undefined) {
  const offset = offsetParam || 1
  const limit = Math.min(limitParam || MAX_READ_LINES, MAX_READ_LINES)
  const split = decoded.split("\n")
  const complete = split.at(-1) === "" ? split.slice(0, -1) : split
  const available = complete.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))

  const entries: string[] = []
  let size = 0
  let next: number | undefined
  for (const [index, value] of available.slice(offset - 1).entries()) {
    const line = offset + index
    if (entries.length >= limit || size >= MAX_READ_BYTES) {
      next = line
      break
    }
    const text = value.length > MAX_LINE_LENGTH ? value.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : value
    const lineSize = Buffer.byteLength(text, "utf-8") + (entries.length > 0 ? 1 : 0)
    if (size + lineSize > MAX_READ_BYTES) {
      next = line
      break
    }
    entries.push(text)
    size += lineSize
  }
  if (next === undefined && entries.length >= limit && offset - 1 + entries.length < available.length)
    next = offset + entries.length

  // Char start offset of every split piece: consumedLines-th newline in the
  // text == start of piece `consumedLines` (mirrors nthNewline byte logic).
  const starts: number[] = []
  let position = 0
  for (const piece of split) {
    starts.push(position)
    position += piece.length + 1
  }
  const consumedLines = next === undefined ? available.length : next - 1
  const consumedEnd = consumedLines <= 0 ? 0 : consumedLines < starts.length ? starts[consumedLines] : decoded.length

  return { entries, offset, next, available, consumedEnd }
}

// ---------------------------------------------------------------------------
// Directory listing — port of read-filesystem.ts `list`.
// ---------------------------------------------------------------------------

function listEntries(dir: string): ListEntry[] {
  const items: ListEntry[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) items.push({ path: entry.name + path.sep, type: "directory" })
    else if (entry.isSymbolicLink()) items.push({ path: entry.name, type: "symlink" })
    else if (entry.isFile()) items.push({ path: entry.name, type: "file" })
    // DirEntry type "other" (sockets, fifos) is skipped, like upstream.
  }
  items.sort((a, b) =>
    a.type === "directory"
      ? b.type === "directory"
        ? a.path.localeCompare(b.path)
        : -1
      : b.type === "directory"
        ? 1
        : a.path.localeCompare(b.path),
  )
  return items
}

// ---------------------------------------------------------------------------
// Filename recovery and missing-path errors — ports of read.ts
// `alternatePath` / `missing`.
// ---------------------------------------------------------------------------

function alternatePath(absolute: string): string | undefined {
  const dir = path.dirname(absolute)
  const base = path.basename(absolute).replace(/[\u00a0\u202f]/g, " ")
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return undefined
  }
  const matches = names.filter((name) => {
    if (name.replace(/[\u00a0\u202f]/g, " ") !== base) return false
    try {
      return fs.lstatSync(path.join(dir, name)).isFile()
    } catch {
      return false
    }
  })
  if (matches.length !== 1) return undefined
  return path.join(dir, matches[0])
}

function missing(input: string, absolute: string): Error {
  const base = path.basename(input).toLowerCase()
  let suggestions: string[] = []
  try {
    suggestions = fs
      .readdirSync(path.dirname(absolute))
      .filter((entry) => {
        const candidate = entry.toLowerCase()
        return candidate.includes(base) || base.includes(candidate)
      })
      .map((entry) => path.join(path.dirname(input), entry))
      .slice(0, 3)
  } catch {
    // unreadable parent directory -> no suggestions, like upstream
  }
  const message =
    suggestions.length === 0
      ? `File not found: ${input}`
      : `File not found: ${input}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
  return new ReadFailure(message)
}

function readFileRange(filePath: string, offset: number, length: number): Uint8Array {
  const fd = fs.openSync(filePath, "r")
  try {
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, offset)
    return new Uint8Array(buffer.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
}

function tryStat(filePath: string): { stat?: fs.Stats; code?: string } {
  try {
    return { stat: fs.statSync(filePath) }
  } catch (error: any) {
    return { code: error?.code }
  }
}

// ---------------------------------------------------------------------------
// Tool body — same flow as the V2.0.12 built-in execute.
// ---------------------------------------------------------------------------

export function runRead(params: ReadParams, location: V2Location): Promise<ToolResult> {
  const requested = resolveLexical(location.directory, params.path)
  try {
    const initial = resolveInitial(requested, params)
    return Promise.resolve(readResolved(initial.filePath, initial.display, initial.stat, params, location))
  } catch (error: any) {
    // ReadFailure messages pass through verbatim (upstream tagged errors);
    // a race-y ENOENT resolves against the requested path; anything else is
    // the generic `Unable to read` (upstream mapError fallback).
    let failure: Error
    if (error instanceof ReadFailure) failure = error
    else if (error?.code === "ENOENT") failure = missing(params.path, requested)
    else failure = new Error(`Unable to read ${params.path}`)
    return Promise.reject(failure)
  }
}

// Existence + NBSP filename recovery — mirrors access.authorizeRead,
// alternatePath and missing in the built-in.
function resolveInitial(requested: string, params: ReadParams): { filePath: string; display: string; stat: fs.Stats } {
  let filePath = requested
  let display = params.path
  let resolved = tryStat(filePath)
  if (resolved.stat === undefined) {
    if (resolved.code !== "ENOENT") throw new Error(`Unable to read ${params.path}`)
    const alternate = alternatePath(filePath)
    if (alternate === undefined) throw missing(params.path, filePath)
    filePath = alternate
    display = path.join(path.dirname(params.path), path.basename(alternate))
    resolved = tryStat(filePath)
    if (resolved.stat === undefined) {
      throw resolved.code === "ENOENT" ? missing(params.path, filePath) : new Error(`Unable to read ${params.path}`)
    }
  }
  return { filePath, display, stat: resolved.stat! }
}

function readResolved(
  filePath: string,
  display: string,
  stat: fs.Stats,
  params: ReadParams,
  location: V2Location,
): ToolResult {
  const resource = resourceFor(location, filePath)

  if (stat.isDirectory()) {
    const visible = listEntries(filePath)
    const offset = params.offset || 1
    const limit = Math.min(params.limit || MAX_READ_LINES, MAX_READ_LINES)
    const selected = visible.slice(offset - 1, offset - 1 + limit)
    const truncated = offset - 1 + selected.length < visible.length
    const output: ListPageOutput = {
      type: "list-page",
      entries: selected,
      truncated,
      ...(truncated ? { next: offset + selected.length } : {}),
    }
    return finish(display, params.offset, output)
  }

  if (!stat.isFile()) {
    throw new ReadFailure(`Path is not a file or directory: ${resource}`)
  }

  const media = detectMime(readFileRange(filePath, 0, Math.min(FIRST_CHUNK, stat.size)))
  if (MEDIA_MIMES.has(media)) {
    if (stat.size > MAX_MEDIA_INGEST_BYTES)
      throw new ReadFailure(`Media exceeds ${MAX_MEDIA_INGEST_BYTES} byte ingestion limit: ${resource}`)
    const base64 = fs.readFileSync(filePath).toString("base64")
    const output: FileOutput = {
      type: "file",
      uri: url.pathToFileURL(filePath).href,
      name: path.basename(filePath),
      content: base64,
      encoding: "base64",
      mime: media,
    }
    return finish(display, params.offset, output)
  }

  const decoded = decodeFile(filePath).text

  const paged = stat.size > MAX_READ_BYTES || params.offset !== undefined || params.limit !== undefined
  if (!paged) {
    if (decoded.includes("\u0000")) throw new ReadFailure(`Cannot read binary file: ${resource}`)
    const output: FileOutput = {
      type: "file",
      uri: url.pathToFileURL(filePath).href,
      name: path.basename(filePath),
      content: decoded,
      encoding: "utf8",
      mime: lookupMime(filePath),
    }
    return finish(display, params.offset, output)
  }

  const page = textPage(decoded, params.offset, params.limit)
  if (decoded.slice(0, page.consumedEnd).includes("\u0000")) {
    throw new ReadFailure(`Cannot read binary file: ${resource}`)
  }
  if (page.entries.length === 0 && page.offset !== 1) {
    throw new ReadFailure(`Offset ${page.offset} is out of range`)
  }
  const output: TextPageOutput = {
    type: "text-page",
    content: page.entries.join("\n"),
    mime: lookupMime(filePath),
    offset: page.offset,
    truncated: page.next !== undefined,
    ...(page.next === undefined ? {} : { next: page.next }),
  }
  return finish(display, params.offset, output)
}

function finish(display: string, offset: number | undefined, output: ReadOutput): ToolResult {
  return {
    output,
    content: toModelContent(display, offset, output),
    metadata: { truncated: output.type === "file" ? false : output.truncated },
  }
}
