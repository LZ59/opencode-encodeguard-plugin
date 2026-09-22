// OpenCode V2 `edit` tool: encoding-aware reimplementation aligned with the
// V2.0.12 built-in (opencode packages/core/src/tool/plugin/edit.ts).
//
// Behavior mirrors the built-in exactly:
//   * input field descriptions and the JSON Schema contract,
//   * three-tier matching: exact -> unicode-normalized (smart quotes, dashes,
//     exotic spaces) -> line-based trailing match (trimEnd + normalization),
//   * CRLF handling (`\r\n`-aware line-ending conversion of the strings),
//   * BOM preservation (original BOM or a BOM introduced by newString),
//   * error messages (`File not found:`, `Path is a directory, not a file:`,
//     `Could not find oldString in ...`, `Found N matches ...`),
//   * output `{ files, replacements }`, content
//     `Edited <file> (N replacement(s))`, metadata `{ files }`.
//
// The ONLY behavioral delta is the I/O boundary: instead of the UTF-8-only
// `FileMutation.readText` / `write`, the file is decoded/encoded in its
// original encoding (GBK, GB18030, Big5, Shift_JIS, UTF-16 LE/BE, UTF-32,
// ...) with its BOM re-attached at the byte layer.
//
// Not replicable from a plugin (no API surface on the promise plugin
// context), documented in README:
//   * the formatter hook — the diff is computed against a fresh re-read,
//     mirroring the built-in's no-formatter branch;
//   * the internal `permission.assert` call — `options.permission: "edit"`
//     still gives catalog-level allow/ask/deny gating;
//   * external_directory approval for absolute paths outside the location.

import * as fs from "node:fs"
import { createTwoFilesPatch, diffLines } from "diff"
import { decodeFile, encodeFile, splitBom } from "../encoding.ts"
import { resourceFor, resolveLexical, type V2Location } from "./location.ts"
import type { Result as ToolResult } from "@opencode/plugin/promise/tool"

export interface EditParams {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export const DESCRIPTION = `Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as \`1: \`. Never include the prefix in oldString or newString. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.

This is the encoding-aware variant: identical behavior, but the file is decoded/written in its original encoding (GBK, GB18030, Big5, Shift_JIS, UTF-16, etc.) and BOM instead of forcing UTF-8.`

export const INPUT = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File to edit",
    },
    oldString: { type: "string", description: "Exact text to find and replace" },
    newString: { type: "string", description: "Text to replace oldString with (must differ from oldString)" },
    replaceAll: {
      type: "boolean",
      description:
        "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
    },
  },
  required: ["path", "oldString", "newString"],
  additionalProperties: false,
} as const

export const OUTPUT = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          patch: { type: "string" },
          status: { type: "string", enum: ["added", "deleted", "modified"] },
          additions: { type: "integer" },
          deletions: { type: "integer" },
        },
        required: ["file", "patch", "status", "additions", "deletions"],
        additionalProperties: false,
      },
    },
    replacements: { type: "number" },
  },
  required: ["files", "replacements"],
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------
// Matching — verbatim port of the V2.0.12 built-in (edit.ts).
// ---------------------------------------------------------------------------

const crlf = "\r\n"

interface Match {
  readonly start: number
  readonly end: number
}

// One-to-one character mappings, so match offsets into the normalized string
// stay valid offsets into the original source. Escapes are used for every
// code point to keep this file ASCII-safe (semantically identical to the
// upstream character-class literals).
const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")

const findOccurrences = (content: string, search: string) => {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

const findLineOccurrences = (content: string, search: string) => {
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd()),
      )
    )
      return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}

// ---------------------------------------------------------------------------
// Helpers mirroring packages/core/src/tool/plugin/file-diff.ts.
// ---------------------------------------------------------------------------

function fileDiff(file: string, before: string, after: string, status: "added" | "deleted" | "modified" = "modified") {
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file,
    patch: createTwoFilesPatch(file, file, before, after),
    status,
    ...counts,
  }
}

// Permission resource of a path (location-relative with forward slashes for
// files inside the location or its project/worktree, absolute otherwise) and
// per-path serialization of read -> match -> write — see ./location.ts and
// the built-in's fileMutation.withLock around the whole pipeline.
const locks = new Map<string, Promise<void>>()
function withLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

// ---------------------------------------------------------------------------
// Tool body — same flow as the V2.0.12 built-in execute.
// ---------------------------------------------------------------------------

export function runEdit(params: EditParams, location: V2Location): Promise<ToolResult> {
  if (params.oldString === params.newString) {
    return Promise.reject(new Error("No changes to apply: oldString and newString are identical."))
  }
  if (params.oldString === "") {
    return Promise.reject(new Error("oldString must not be empty. Use write to create or overwrite a file."))
  }

  const filePath = resolveLexical(location.directory, params.path)

  return withLock(filePath, () => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${params.path}`)
    }
    if (fs.statSync(filePath).isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${params.path}`)
    }

    let original
    try {
      original = decodeFile(filePath)
    } catch {
      throw new Error(`Unable to edit ${params.path}`)
    }

    const source = original.text
    const ending = source.includes(crlf) ? crlf : "\n"
    const oldString = params.oldString.replaceAll(crlf, "\n").replaceAll("\n", ending)
    const newString = params.newString.replaceAll(crlf, "\n").replaceAll("\n", ending)
    const exact = findOccurrences(source, oldString)
    // These one-to-one mappings preserve offsets into the original source.
    const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(source), normalizeForMatch(oldString))
    const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(source, oldString)
    const matches = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing
    const replacements = matches.length
    const replaced = (params.replaceAll === true ? matches : matches.slice(0, 1))
      .toReversed()
      .reduce((content, match) => `${content.slice(0, match.start)}${newString}${content.slice(match.end)}`, source)

    if (replacements === 0) {
      throw new Error(
        `Could not find oldString in ${params.path}. It must match exactly, including whitespace and indentation.`,
      )
    }
    if (replacements > 1 && params.replaceAll !== true) {
      throw new Error(
        `Found ${replacements} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
      )
    }

    // BOM: keep the original, or one introduced by newString at position 0
    // (upstream Bom.join semantics, at the encoding-aware byte layer).
    const next = splitBom(replaced)
    const bom = original.bom || next.bom
    try {
      fs.writeFileSync(filePath, encodeFile(next.text, bom, original.encoding))
    } catch {
      throw new Error(`Unable to edit ${params.path}`)
    }

    // The built-in re-reads after its formatter hook; plugins cannot run the
    // formatter, so this mirrors the no-formatter branch (re-read for parity —
    // reflects any external write that landed while we held the lock).
    const formatted = decodeFile(filePath).text
    const files = [fileDiff(resourceFor(location, filePath), source, formatted)]
    const output = { files, replacements }
    return {
      output,
      content: `Edited ${output.files[0]?.file} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
      metadata: { files: output.files },
    } satisfies ToolResult
  })
}
