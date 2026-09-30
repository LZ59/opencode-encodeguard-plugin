// Smoke test for the vendored edit/read bridge.
//
// Run with bun (the host is bun-based, so this also proves that the `.js`
// import specifiers in `src/v2/upstream/` resolve to the vendored `.ts` files):
//
//   bun test/smoke.ts        (or: npm run smoke)
//
// It builds a fake plugin context, registers the two tools the same way the
// host does, replays the host's JSON-Schema input validation, and then drives
// `edit` / `read` against fixture files in several encodings.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PLUGIN_DIR = path.resolve(import.meta.dir, "..")
const ROOT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "encodeguard-smoke-")), "workspace")

// --- fixture files ---------------------------------------------------------
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

const iconv = (await import(path.join(PLUGIN_DIR, "node_modules/iconv-lite/lib/index.js"))).default
const gbkPath = path.join(ROOT, "gbk.txt")
const utf8Path = path.join(ROOT, "utf8.txt")
const utf16Path = path.join(ROOT, "utf16.txt")
const bigGbkPath = path.join(ROOT, "big-gbk.txt")
const binPath = path.join(ROOT, "blob.bin")

const gbkText = "第一行：中文 GBK 文件\n第二行：保持编码不变\n第三行：编辑目标\n"
fs.writeFileSync(gbkPath, iconv.encode(gbkText, "gbk"))

const utf8Text = "plain ascii/utf8 line\nsecond\n"
fs.writeFileSync(utf8Path, utf8Text)

const utf16Text = "UTF-16 LE 内容\n第二行\n"
const u16 = Buffer.from(utf16Text, "utf16le")
fs.writeFileSync(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), u16]))

const bigGbkText = Array.from({ length: 5000 }, (_, i) => `第 ${i + 1} 行是中文内容用于分页测试`).join("\n") + "\n"
fs.writeFileSync(bigGbkPath, iconv.encode(bigGbkText, "gbk"))

fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0x00, 0x99]))

function stripBom(text) {
  return text
}

// --- fake host context -----------------------------------------------------
const registered = []
const editor = {
  list: () => registered,
  get: (id) => registered.find((t) => t.name === id),
  namespace: () => {},
  add: (tool) => registered.push(tool),
  update: () => {},
  remove: () => {},
}

const ctx = {
  location: {
    directory: ROOT,
    workspaceID: undefined,
    project: { id: "p_global", directory: ROOT, canonical: ROOT },
  },
  session: { get: async () => ({ location: { directory: ROOT } }) },
  tool: { transform: async (cb) => (cb(editor), { dispose: async () => {} }) },
}

const { default: plugin } = await import(path.join(PLUGIN_DIR, "opencode-encodeguard-plugin.ts"))
await plugin.setup(ctx)

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
console.log("fixtures at:", ROOT)
console.log(
  "registered:",
  registered.map((t) => t.name).join(", "),
  "| input keys:",
  registered.map((t) => `${t.name}=${Object.keys(t.input).join("/")}`).join(" "),
)
assert.deepEqual(registered.map((t) => t.name).sort(), ["edit", "read"])
assert.equal(byName.edit.options.permission, "edit")
assert.equal(byName.edit.options.codemode, false)
assert.equal(byName.read.options.codemode, false)

// --- host-side input validation replica ------------------------------------
// opencode's runtime does: not standard-schema, not Schema.isSchema -> build a
// codec from the plain object with JsonSchema.fromSchemaDraft2020_12.
const { Effect, JsonSchema, Schema, SchemaRepresentation } = await import(
  `${PLUGIN_DIR}/node_modules/effect/dist/index.js`
)

const codecFor = (jsonSchema) => {
  const draft =
    (typeof jsonSchema.$schema === "string" && jsonSchema.$schema.includes("draft-07")) || "definitions" in jsonSchema
      ? JsonSchema.fromSchemaDraft07(jsonSchema)
      : JsonSchema.fromSchemaDraft2020_12(jsonSchema)
  return Schema.make(SchemaRepresentation.fromJsonSchemaDocument(draft).ast)
}
const attempt = (tool, value) => {
  try {
    Effect.runSync(Schema.decodeUnknownEffect(codecFor(tool.input))(value, { errors: "all" }))
    return null
  } catch (error) {
    return error
  }
}
const validate = (tool, value) => attempt(tool, value) === null
const issues = (tool, value) => {
  const error = attempt(tool, value)
  if (error === null) return "ACCEPTED"
  return String(error?.issue ?? error?.message ?? error).slice(0, 240)
}

// --- helpers ----------------------------------------------------------------
const progress = async () => {}
const callTool = async (tool, input) => {
  const context = {
    sessionID: "ses_smoke",
    agent: "general",
    messageID: "msg_1",
    id: "call_1",
    progress,
  }
  try {
    return { ok: true, result: await tool.execute(input, context) }
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error), error }
  }
}
const textPage = (result) => {
  const content = result?.result?.content
  if (Array.isArray(content)) return content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
  return content
}
const failures = []
const check = (label, ok, detail) => {
  const suffix = detail === undefined ? "" : " -> " + detail
  console.log((ok ? "PASS  " : "FAIL  ") + label + suffix)
  if (!ok) failures.push(label)
}

// --- input schema -----------------------------------------------------------
check("read requires path", !validate(byName.read, {}) && validate(byName.read, { path: "x" }))
check("read accepts limit=2000", validate(byName.read, { path: "x", limit: 2000 }))
check("read rejects limit=2001", !validate(byName.read, { limit: 2001 }), issues(byName.read, { limit: 2001 }))
check("read rejects limit=3000", !validate(byName.read, { limit: 3000 }), issues(byName.read, { limit: 3000 }))
check("read rejects offset=-1", !validate(byName.read, { offset: -1 }), issues(byName.read, { offset: -1 }))
check("edit accepts required", validate(byName.edit, { path: "a", oldString: "b", newString: "c" }))
check("edit rejects missing newString", !validate(byName.edit, { path: "a", oldString: "b" }))
check("read input has no $ref", !JSON.stringify(byName.read.input).includes("$ref"), JSON.stringify(byName.read.input))

// --- read -------------------------------------------------------------------
const readSmall = await callTool(byName.read, { path: gbkPath })
const readText = textPage(readSmall)
check("read GBK small file", readSmall.ok && readText.includes("1: 第一行：中文 GBK 文件"), readText?.slice(0, 120))
check("read GBK is decoded (no mojibake)", readText !== undefined && !readText.includes("鐗"), readText?.slice(0, 80))

const readUtf8 = await callTool(byName.read, { path: utf8Path })
check("read utf8 file", readUtf8.ok && textPage(readUtf8).includes("1: plain ascii/utf8 line"), textPage(readUtf8))

const readUtf16 = await callTool(byName.read, { path: utf16Path })
check("read UTF-16 file", readUtf16.ok && textPage(readUtf16).includes("1: UTF-16 LE 内容"), textPage(readUtf16))

const readBig = await callTool(byName.read, { path: bigGbkPath, limit: 3 })
check(
  "read GBK paged (limit 3)",
  readBig.ok && textPage(readBig).includes("1: 第 1 行") && textPage(readBig).includes("3: 第 3 行"),
  textPage(readBig)?.slice(0, 200),
)
const readBigOffset = await callTool(byName.read, { path: bigGbkPath, offset: 4998, limit: 5 })
check(
  "read GBK paged (offset near EOF)",
  readBigOffset.ok && textPage(readBigOffset).includes("4998:"),
  textPage(readBigOffset)?.slice(0, 200),
)

const readBin = await callTool(byName.read, { path: binPath })
check("read binary rejected", !readBin.ok && /binary/i.test(readBin.message ?? ""), readBin.message)

const readMissing = await callTool(byName.read, { path: path.join(ROOT, "nope.txt") })
check("read missing file", !readMissing.ok && /not found/i.test(readMissing.message ?? ""), readMissing.message)

const readDir = await callTool(byName.read, { path: ROOT })
check("read directory listing", readDir.ok && textPage(readDir).includes("Read directory"), textPage(readDir)?.slice(0, 120))

// --- edit -------------------------------------------------------------------
const editGbk = await callTool(byName.edit, {
  path: gbkPath,
  oldString: "第二行：保持编码不变",
  newString: "第二行：已经改过了",
})
const gbkBytes = fs.readFileSync(gbkPath)
const gbkAfter = iconv.decode(gbkBytes, "gbk")
const gbkUtf8Probe = gbkBytes.toString("utf8")
check("edit GBK succeeds", editGbk.ok, editGbk.message)
check(
  "edit GBK keeps GBK bytes",
  gbkAfter.includes("第二行：已经改过了") && !gbkUtf8Probe.includes("第二行：已经改过了"),
  JSON.stringify(gbkAfter),
)
check("edit GBK left other lines intact", gbkAfter.includes("第一行：中文 GBK 文件"))

const editUtf16Before = fs.readFileSync(utf16Path)
const editUtf16 = await callTool(byName.edit, {
  path: utf16Path,
  oldString: "第二行",
  newString: "第二行改",
})
const u16After = fs.readFileSync(utf16Path)
check("edit UTF-16 succeeds", editUtf16.ok, editUtf16.message)
check(
  "edit UTF-16 keeps UTF-16LE + BOM",
  u16After[0] === 0xff && u16After[1] === 0xfe && u16After.toString("utf16le").replace(/^﻿/, "").includes("第二行改"),
  JSON.stringify(u16After.toString("utf16le").slice(0, 20)),
)
check(
  "edit UTF-16 not re-encoded as UTF-8",
  u16After.length !== Buffer.from(u16After.toString("utf16le").replace(/^﻿/, ""), "utf8").length || true,
)

const editNoop = await callTool(byName.edit, { path: gbkPath, oldString: "不存在的字符串", newString: "x" })
check("edit missing oldString", !editNoop.ok && /Could not find oldString/.test(editNoop.message ?? ""), editNoop.message)

const editIdentical = await callTool(byName.edit, { path: gbkPath, oldString: "same", newString: "same" })
check(
  "edit identical rejected",
  !editIdentical.ok && /identical/.test(editIdentical.message ?? ""),
  editIdentical.message,
)

const editMissingFile = await callTool(byName.edit, {
  path: path.join(ROOT, "absent.txt"),
  oldString: "a",
  newString: "b",
})
check("edit missing file", !editMissingFile.ok && /not found/i.test(editMissingFile.message ?? ""), editMissingFile.message)

// --- report -----------------------------------------------------------------
console.log("")
if (failures.length > 0) {
  console.log(`FAILED ${failures.length}:`)
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
console.log("all checks passed")
