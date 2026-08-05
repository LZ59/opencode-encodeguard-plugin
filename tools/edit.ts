// Encoding-aware replacement for opencode's built-in `edit` tool.
//
// Can be used in two ways:
//   1. As a standalone custom tool: drop this file into `.opencode/tools/edit.ts`
//      and the filename registers it as the `edit` tool (overrides built-in).
//   2. As part of the encoding-guard-edit plugin: imported by `index.mjs` and
//      registered via `tool: { edit }` in the plugin's returned hooks; per
//      OpenCode docs, plugin tools shadow built-in tools of the same name.
//
// Faithfully mirrors the v1.16.2 release `edit` (packages/core/src/tool/edit.ts,
// the V2 exact-edit variant): exact-only matching (no fuzzy fallbacks — those
// are explicit TODOs upstream), params `path`/`oldString`/`newString`/
// `replaceAll`, same error messages, same output shape, and a structured
// `metadata.files` / `metadata.replacements` payload.
//
// The ONLY behavioral delta is the I/O boundary: instead of `decodeUtf8`
// (UTF-8 + BOM only via `new TextDecoder()`), we detect and preserve the
// file's original encoding (GBK, GB18030, Big5, Shift_JIS, UTF-16 LE/BE,
// UTF-32, etc.) and any BOM — so non-UTF-8 files are not corrupted.
//
// See https://opencode.ai/docs/custom-tools/

import * as path from "node:path"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import { tool } from "@opencode-ai/plugin"
import { createTwoFilesPatch, diffLines } from "diff"

const DESCRIPTION = `Replace exact text in one file with encoding awareness.

This is the encoding-aware variant of the built-in edit tool. It behaves identically (exact matching, params, error messages, output) but decodes/writes the file in its original encoding (GBK, GB18030, Big5, Shift_JIS, UTF-16, etc.) and BOM instead of forcing UTF-8, so non-UTF-8 source files are not corrupted.`

// ---------------------------------------------------------------------------
// Encoding-aware I/O (replaces upstream `decodeUtf8` + `joinBom`).
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
  "Big5-HKSCS": "big5-hkscs",
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

function encodeBytes(text: string, detected: string): Uint8Array {
  const nodeEnc = toNodeEncoding(detected)
  if (iconv) return new Uint8Array(iconv.encode(text, nodeEnc))
  try {
    return new TextEncoder().encode(text)
  } catch {
    return new TextEncoder().encode(text)
  }
}

// Mirrors upstream `decodeUtf8`: returns { bom, content (raw bytes), text }.
function decodeFile(filePath: string): { bom: boolean; content: Uint8Array; text: string; encoding: string } {
  const raw = fs.readFileSync(filePath)
  const bom = detectBom(raw)
  const data = bom ? raw.subarray(bom.length) : raw
  const detected = bom ? bom.name : detectEncoding(raw)
  const encoding = bom && bom.name === "UTF-8" ? "UTF-8 BOM" : detected
  const text = decodeBytes(data, detected)
  return { bom: bom !== null, content: raw, text, encoding }
}

// Mirrors upstream `joinBom`: re-attach BOM at the byte layer for non-UTF-8.
function encodeFile(text: string, bom: boolean, encoding: string): Uint8Array {
  const body = encodeBytes(text, encoding === "UTF-8 BOM" ? "UTF-8" : encoding)
  if (!bom) return body
  const sig =
    encoding === "UTF-8 BOM" || encoding === "UTF-8"
      ? BOM_SIGS[0].bytes
      : BOM_SIGS.find((b) => b.name === encoding)?.bytes ?? BOM_SIGS[0].bytes
  const out = new Uint8Array(sig.length + body.length)
  out.set(sig, 0)
  out.set(body, sig.length)
  return out
}

// ---------------------------------------------------------------------------
// Helpers copied verbatim from v1.16.2 edit.ts (exact-edit behavior).
// ---------------------------------------------------------------------------

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")
}

function splitBom(text: string): { bom: boolean; text: string } {
  return text.startsWith("﻿") ? { bom: true, text: text.slice(1) } : { bom: false, text }
}

function countOccurrences(content: string, search: string): number {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

function previewLines(value: string, prefix: "+" | "-"): string[] {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines
    .slice(0, 6)
    .map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

function toModelOutput(file: string, replacements: number, oldString: string, newString: string): string {
  return [
    `Edited file successfully: ${file}`,
    `Replacements: ${replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")
}

// Approximate upstream `writeIfUnchanged`: we read the file at execute start
// (the `source.content` is the bytes we decoded from), and write unconditionally
// under a per-path lock. We cannot atomically compare-and-swap without the
// internal FileMutation service, but the concurrency window is the same order
// as a normal edit; the lock serializes same-file edits.
const locks = new Map<string, Promise<void>>()
function withLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(filePath, next.catch(() => {}))
  return next
}

export const edit = tool({
  description: DESCRIPTION,
  args: {
    path: tool.schema.string().describe(
      "File path to edit. Relative paths resolve within the active location. Absolute paths inside that location are accepted; external absolute paths require external_directory approval.",
    ),
    oldString: tool.schema.string().describe("Exact text to replace"),
    newString: tool.schema.string().describe("Replacement text, which must differ from oldString"),
    replaceAll: tool.schema
      .boolean()
      .optional()
      .describe("Replace all exact occurrences of oldString (default false)"),
  },
  async execute(params, ctx) {
    const instanceDir = ctx.directory
    const worktree = ctx.worktree
    let filePath = params.path
    if (!path.isAbsolute(filePath)) filePath = path.resolve(instanceDir, filePath)
    if (process.platform === "win32") filePath = filePath.replace(/\//g, "\\")

    if (params.oldString === params.newString) {
      throw new Error("No changes to apply: oldString and newString are identical.")
    }
    if (params.oldString === "") {
      throw new Error("oldString must not be empty. Use write to create or overwrite a file.")
    }

    return withLock(filePath, () => {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Unable to edit ${params.path}`)
      }
      if (fs.statSync(filePath).isDirectory()) {
        throw new Error(`Unable to edit ${params.path}`)
      }

      const source = decodeFile(filePath)
      const ending = detectLineEnding(source.text)
      const oldString = convertToLineEnding(params.oldString, ending)
      const newString = convertToLineEnding(params.newString, ending)
      const replacements = countOccurrences(source.text, oldString)
      if (replacements === 0) {
        throw new Error(
          "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
        )
      }
      if (replacements > 1 && params.replaceAll !== true) {
        throw new Error(
          "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
        )
      }

      const replaced =
        params.replaceAll === true ? source.text.replaceAll(oldString, newString) : source.text.replace(oldString, newString)
      const counts = diffLines(source.text, replaced).reduce(
        (result, item) => ({
          additions: result.additions + (item.added ? (item.count ?? 0) : 0),
          deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
        }),
        { additions: 0, deletions: 0 },
      )
      const next = splitBom(replaced)
      const desiredBom = source.bom || next.bom
      const outBytes = encodeFile(next.text, desiredBom, source.encoding)
      fs.writeFileSync(filePath, outBytes)

      const patch = createTwoFilesPatch(filePath, filePath, source.text, replaced)
      const filediff = {
        file: filePath,
        patch,
        status: "modified" as const,
        ...counts,
      }
      const output = toModelOutput(filePath, replacements, params.oldString, params.newString)
      return {
        title: path.relative(worktree, filePath),
        output,
        metadata: {
          files: [filediff],
          replacements,
        },
      }
    })
  },
})
