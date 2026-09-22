// Encoding-aware replacement for opencode's built-in `read` tool.
//
// Can be used in two ways (the V2 plugin entrypoint does NOT use this file —
// V2 registers `src/v2/read.ts`, which mirrors the V2.0.12 built-in):
//   1. As a standalone custom tool: drop this file into `.opencode/tools/read.ts`
//      and the filename registers it as the `read` tool (overrides built-in).
//   2. In an OpenCode V1 plugin: imported by the plugin entrypoint and
//      registered via `tool: { read }` in the hooks returned from `server()`;
//      per OpenCode docs, plugin tools shadow built-in tools of the same name.
//
// Faithfully mirrors the v1.17.0 release `read` (packages/core/src/tool/read.ts):
// params `path`/`offset`/`limit`, directory listing, paged text reading with
// `offset`/`limit`/`hasMore`/`totalLines` semantics, image (jpeg/png/gif/webp)
// returned as a base64 attachment, binary files rejected with an error.
//
// The ONLY behavioral delta is the I/O boundary: instead of the UTF-8-only
// `ReadToolFileSystem`, we decode the file in its original encoding (GBK,
// GB18030, Big5, Shift_JIS, UTF-16 LE/BE, UTF-32, etc.) so non-UTF-8 source
// files render correctly — which lets the model produce a matching `oldString`
// for the companion `edit` tool instead of falling back to shell.
//
// See https://opencode.ai/v2/docs/build/plugins (V2) and
// https://opencode.ai/docs/custom-tools/ (V1 standalone tools)

import * as path from "node:path"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import { tool } from "@opencode-ai/plugin"

export const DESCRIPTION = `Read a text file or supported image, page through a large text file by line offset, or list a directory with encoding awareness.

This is the encoding-aware variant of the built-in read tool. It behaves identically (params, paging, directory listing, image/binary handling) but decodes the file in its original encoding (GBK, GB18030, Big5, Shift_JIS, UTF-16, etc.) instead of assuming UTF-8, so non-UTF-8 source files render correctly.`

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

// ---------------------------------------------------------------------------
// Encoding-aware I/O.
// ---------------------------------------------------------------------------

let iconv: any = null
try {
  iconv = createRequire(import.meta.url)("iconv-lite")
} catch {
  iconv = null
}

const BOM_SIGS = [
  { name: "UTF-8", bytes: [0xef, 0xbb, 0xbf], length: 3 },
  { name: "UTF-16 LE", bytes: [0xff, 0xfe], length: 2 },
  { name: "UTF-16 BE", bytes: [0xfe, 0xff], length: 2 },
  { name: "UTF-32 LE", bytes: [0xff, 0xfe, 0x00, 0x00], length: 4 },
  { name: "UTF-32 BE", bytes: [0x00, 0x00, 0xfe, 0xff], length: 4 },
]

function detectBom(raw: Uint8Array): { name: string; length: number; bytes: number[] } | null {
  for (const sig of BOM_SIGS) {
    if (raw.length >= sig.length && sig.bytes.every((b, i) => raw[i] === b)) return sig
  }
  return null
}

function hasNullBytes(raw: Uint8Array, sampleLimit = 4096): boolean {
  const end = Math.min(raw.length, sampleLimit)
  for (let i = 0; i < end; i++) if (raw[i] === 0) return true
  return false
}

function isLikelyUtf8(raw: Uint8Array): boolean {
  let i = 0
  while (i < raw.length) {
    if (raw[i] < 0x80) {
      i += 1
      continue
    }
    if ((raw[i] & 0xe0) === 0xc0) {
      if (i + 1 >= raw.length || (raw[i + 1] & 0xc0) !== 0x80) return false
      i += 2
    } else if ((raw[i] & 0xf0) === 0xe0) {
      if (i + 2 >= raw.length || (raw[i + 1] & 0xc0) !== 0x80 || (raw[i + 2] & 0xc0) !== 0x80) return false
      i += 3
    } else if ((raw[i] & 0xf8) === 0xf0) {
      if (
        i + 3 >= raw.length ||
        (raw[i + 1] & 0xc0) !== 0x80 ||
        (raw[i + 2] & 0xc0) !== 0x80 ||
        (raw[i + 3] & 0xc0) !== 0x80
      )
        return false
      i += 4
    } else return false
  }
  return true
}

function detectEncoding(raw: Uint8Array): string {
  const bom = detectBom(raw)
  if (bom) return bom.name
  if (raw.length >= 4 && raw[0] === 0 && raw[1] === 0 && raw[2] !== 0 && raw[3] !== 0) return "UTF-32 LE"
  if (raw.length >= 4 && raw[0] !== 0 && raw[1] !== 0 && raw[2] === 0 && raw[3] === 0) return "UTF-32 BE"
  if (hasNullBytes(raw)) {
    if (raw.length >= 2 && raw[0] !== 0 && raw[1] === 0) return "UTF-16 LE"
    if (raw.length >= 2 && raw[0] === 0 && raw[1] !== 0) return "UTF-16 BE"
    return "Binary"
  }
  if (isLikelyUtf8(raw)) return "UTF-8"
  return "GBK"
}

const ENCODING_ALIAS: Record<string, string> = {
  "UTF-8": "utf-8",
  "UTF-8 BOM": "utf-8",
  "UTF-16 LE": "utf-16le",
  "UTF-16 BE": "utf-16be",
  "UTF-32 LE": "utf-32le",
  "UTF-32 BE": "utf-32be",
  GBK: "gbk",
  GB18030: "gb18030",
  Big5: "big5",
  Shift_JIS: "shift-jis",
  "windows-1252": "windows-1252",
  Latin1: "latin1",
  "EUC-KR": "euc-kr",
  "EUC-JP": "euc-jp",
}

function toNodeEncoding(detected: string): string {
  const alias = ENCODING_ALIAS[detected]
  if (alias) return alias
  const lower = detected.toLowerCase()
  for (const [key, val] of Object.entries(ENCODING_ALIAS)) {
    if (key.toLowerCase() === lower) return val
  }
  return "utf-8"
}

function decodeBytes(data: Uint8Array, detected: string): string {
  const nodeEnc = toNodeEncoding(detected)
  if (iconv) return iconv.decode(Buffer.from(data), nodeEnc)
  try {
    return new TextDecoder(nodeEnc, { fatal: false }).decode(data)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data)
  }
}

function readText(filePath: string): string {
  const raw = fs.readFileSync(filePath)
  const bom = detectBom(raw)
  const data = bom ? raw.subarray(bom.length) : raw
  const detected = bom ? bom.name : detectEncoding(raw)
  return decodeBytes(data, detected)
}

function readSample(filePath: string, size: number): Uint8Array {
  const fd = fs.openSync(filePath, "r")
  try {
    const n = Math.min(SAMPLE_BYTES, size)
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, 0)
    return new Uint8Array(buf)
  } finally {
    fs.closeSync(fd)
  }
}

function sniffMime(sample: Uint8Array, ext: string): string {
  const lower = ext.toLowerCase()
  const imageExt: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  }
  if (imageExt[lower]) {
    if (lower === ".png" && sample[0] === 0x89 && sample[1] === 0x50) return imageExt[lower]
    if (lower === ".gif" && sample[0] === 0x47 && sample[1] === 0x49) return imageExt[lower]
    if ((lower === ".jpg" || lower === ".jpeg") && sample[0] === 0xff && sample[1] === 0xd8) return imageExt[lower]
    if (lower === ".webp" && sample[8] === 0x57 && sample[9] === 0x45) return imageExt[lower]
  }
  return "application/octet-stream"
}

function isPdf(sample: Uint8Array): boolean {
  return sample[0] === 0x25 && sample[1] === 0x50 && sample[2] === 0x44 && sample[3] === 0x46
}

function isBinaryFile(filePath: string, bytes: Uint8Array): boolean {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
  }
  if (bytes.length === 0) return false
  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintableCount++
  }
  return nonPrintableCount / bytes.length > 0.3
}

function listDirectory(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries
    .map((e) => (e.isDirectory() || e.isSymbolicLink() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b))
}

function normalizeWin(p: string): string {
  return process.platform === "win32" ? p.replace(/\//g, "\\") : p
}

export const read = tool({
  description: DESCRIPTION,
  args: {
    path: tool.schema.string().describe("File or directory path to read"),
    offset: tool.schema
      .number()
      .optional()
      .describe("The 1-based directory entry or text line offset to start reading from"),
    limit: tool.schema.number().optional().describe("The maximum number of directory entries or text lines to read"),
  },
  async execute(params, ctx) {
    const instanceDir = ctx.directory
    const worktree = ctx.worktree
    let filePath = params.path
    if (!path.isAbsolute(filePath)) filePath = path.resolve(instanceDir, filePath)
    filePath = normalizeWin(filePath)
    const title = path.relative(worktree, filePath)

    if (!fs.existsSync(filePath)) {
      // "Did you mean" hint, like upstream when a path is missing.
      const dir = path.dirname(filePath)
      const base = path.basename(filePath)
      if (fs.existsSync(dir)) {
        const items = fs
          .readdirSync(dir)
          .filter((it) => it.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(it.toLowerCase()))
          .map((it) => path.join(dir, it))
          .slice(0, 3)
        if (items.length > 0) {
          throw new Error(`Unable to read ${params.path}\n\nDid you mean one of these?\n${items.join("\n")}`)
        }
      }
      throw new Error(`Unable to read ${params.path}`)
    }

    // Directory => ListPage.
    if (fs.statSync(filePath).isDirectory()) {
      const items = listDirectory(filePath)
      const limit = params.limit ?? DEFAULT_LIMIT
      const offset = params.offset || 1
      const start = offset - 1
      const sliced = items.slice(start, start + limit)
      const hasMore = start + sliced.length < items.length
      return {
        title,
        output: sliced.join("\n"),
        metadata: {
          type: "directory",
          path: filePath,
          entries: sliced,
          offset,
          limit,
          hasMore,
          totalEntries: items.length,
        },
      }
    }

    const stat = fs.statSync(filePath)
    const sample = readSample(filePath, Number(stat.size))
    const mime = sniffMime(sample, path.extname(filePath))
    const isImage = SUPPORTED_IMAGE_MIMES.has(mime)

    // Image (or PDF) => base64 attachment, mirroring upstream toModelOutput.
    if (isImage || isPdf(sample)) {
      const bytes = fs.readFileSync(filePath)
      const base64 = Buffer.from(bytes).toString("base64")
      const outMime = isPdf(sample) ? "application/pdf" : mime
      return {
        title,
        output: isPdf(sample) ? "PDF read successfully" : "Image read successfully",
        metadata: { type: "file", mime: outMime, encoding: "base64" },
        attachments: [{ type: "file", mime: outMime, url: `data:${outMime};base64,${base64}` }],
      }
    }

    if (isBinaryFile(filePath, sample)) {
      throw new Error(`Cannot read binary file: ${filePath}`)
    }

    // Text file => TextPage (paged, encoding-aware).
    const text = readText(filePath)
    const allLines = text.split("\n")
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop()
    const totalLines = allLines.length

    const limit = params.limit ?? DEFAULT_LIMIT
    const offset = params.offset || 1
    const start = offset - 1
    if (start >= totalLines && !(totalLines === 0 && offset === 1)) {
      throw new Error(`Offset ${offset} is out of range for this file (${totalLines} lines)`)
    }

    const raw: string[] = []
    let bytesUsed = 0
    let cut = false
    let more = false
    for (let i = start; i < totalLines; i++) {
      if (raw.length >= limit) {
        more = true
        break
      }
      const line = allLines[i].length > MAX_LINE_LENGTH ? allLines[i].substring(0, MAX_LINE_LENGTH) + "... (line truncated)" : allLines[i]
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytesUsed + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }
      raw.push(line)
      bytesUsed += size
    }

    const content = raw.map((line, i) => `${i + offset}: ${line}`).join("\n")
    const last = offset + raw.length - 1
    const hasMore = more || cut || start + raw.length < totalLines
    const suffix = cut
      ? `\n\n(Output capped at ${MAX_BYTES / 1024} KB. Use offset=${last + 1} to continue.)`
      : more
        ? `\n\n(Showing lines ${offset}-${last} of ${totalLines}. Use offset=${last + 1} to continue.)`
        : `\n\n(End of file - total ${totalLines} lines)`
    const pageText = content + suffix

    return {
      title,
      output: pageText,
      metadata: {
        type: "text",
        path: filePath,
        content,
        offset,
        limit,
        hasMore,
        totalLines,
      },
    }
  },
})
