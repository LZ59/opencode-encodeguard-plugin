// Encoding-aware file I/O, factored out for unit testing.
//
// This is the canonical implementation of the encoding detection + codec logic
// that `tools/edit.ts` and `tools/read.ts` inline (those tools must stay
// self-contained so opencode's tool loader can resolve them without relative
// `.ts` imports). Keep this file in sync with the inlined copies.

import * as fs from "node:fs"
import { createRequire } from "node:module"

let iconv: any = null
try {
  iconv = createRequire(import.meta.url)("iconv-lite")
} catch {
  iconv = null
}

export const BOM_SIGS = [
  { name: "UTF-8", bytes: [0xef, 0xbb, 0xbf], length: 3 },
  { name: "UTF-16 LE", bytes: [0xff, 0xfe], length: 2 },
  { name: "UTF-16 BE", bytes: [0xfe, 0xff], length: 2 },
  { name: "UTF-32 LE", bytes: [0xff, 0xfe, 0x00, 0x00], length: 4 },
  { name: "UTF-32 BE", bytes: [0x00, 0x00, 0xfe, 0xff], length: 4 },
]

export interface BomInfo {
  name: string
  length: number
  bytes: number[]
}

export function detectBom(raw: Uint8Array): BomInfo | null {
  for (const sig of BOM_SIGS) {
    if (raw.length >= sig.length && sig.bytes.every((b, i) => raw[i] === b)) return sig
  }
  return null
}

export function stripBom(raw: Uint8Array): { bom: BomInfo | null; data: Uint8Array } {
  const bom = detectBom(raw)
  if (!bom) return { bom: null, data: raw }
  return { bom, data: raw.subarray(bom.length) }
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

export function detectEncoding(raw: Uint8Array): string {
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

export function decodeBytes(data: Uint8Array, detected: string): string {
  const nodeEnc = toNodeEncoding(detected)
  if (iconv) return iconv.decode(Buffer.from(data), nodeEnc)
  try {
    return new TextDecoder(nodeEnc, { fatal: false }).decode(data)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data)
  }
}

export function encodeBytes(text: string, detected: string): Uint8Array {
  const nodeEnc = toNodeEncoding(detected)
  if (iconv) return new Uint8Array(iconv.encode(text, nodeEnc))
  try {
    return new TextEncoder().encode(text)
  } catch {
    return new TextEncoder().encode(text)
  }
}

export interface EncodedFile {
  bom: boolean
  content: Uint8Array
  text: string
  encoding: string
}

// Mirrors upstream `decodeUtf8`: { bom, content (raw bytes), text } but
// encoding-aware.
export function decodeFile(filePath: string): EncodedFile {
  const raw = fs.readFileSync(filePath)
  const bom = detectBom(raw)
  const data = bom ? raw.subarray(bom.length) : raw
  const detected = bom ? bom.name : detectEncoding(raw)
  const encoding = bom && bom.name === "UTF-8" ? "UTF-8 BOM" : detected
  const text = decodeBytes(data, detected)
  return { bom: bom !== null, content: raw, text, encoding }
}

export function encodeFile(text: string, bom: boolean, encoding: string): Uint8Array {
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
// Exact-edit helpers (mirror v1.18.2 edit.ts).
// ---------------------------------------------------------------------------

export function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

export function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")
}

export function splitBom(text: string): { bom: boolean; text: string } {
  return text.startsWith("﻿") ? { bom: true, text: text.slice(1) } : { bom: false, text }
}

export function countOccurrences(content: string, search: string): number {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}
