# opencode-encodeguard-plugin

OpenCode 插件，把内置的 `edit` 和 `read` 替换为编码感知版本，处理 GBK / GB18030 / Big5 / Shift_JIS / UTF-16 LE/BE / UTF-32 时不再乱码。

> 本分支**只支持 OpenCode V2**（`Plugin.define({ id, setup })`，文档：<https://opencode/v2/docs/plugins/>）。V1 的 `server()` / `tools/*` / `@opencode-ai/plugin` 已移除，仍需 V1 请用 1.x 版本。

## 安装

> V2 的 `plugins` 配置项里**路径必须是目录**——写 `.ts` 文件会被拒绝并告警 `configured plugin path must be a directory`。目录入口由 `Host.resolve` 依次探测 `<目录>/server.*`、`<目录>/index.*`，本仓库根目录的 `index.ts` 就是这个探测目标。

**1. 在项目 `opencode.json` 注册插件（指向插件目录，不是文件）**

```json
{ "plugins": ["/path/to/opencode-encodeguard-plugin"] }
```

本仓库自测时用的就是仓库内的：

```json
{ "plugins": ["./"] }
```

**2. 在本插件目录下跑一次 `npm install`**

```bash
cd /path/to/opencode-encodeguard-plugin
npm install
```

把 `iconv-lite`、`diff`、`mime-types`、`effect` 等装到插件的 `node_modules/`，运行时向上查找能解析到。

其他形态：

- npm 安装：`{ "plugins": ["opencode-encodeguard-plugin"] }`（安装后按目录入口解析，包根 `index.ts` 提供入口）。
- 把入口文件拷贝/软链到项目的 `.opencode/plugins/`：该目录下的 `.ts` / `.js` 文件会被自动发现（这是 V2 中唯一接受**文件**形态的本地插件位置）。

> 覆盖机制：内置 `edit` / `read` 是 Effect 插件，项目插件在其后按 id 注册；`editor.add` 按 id 覆盖（后注册者胜），所以同名工具被本插件替换。

## 实现结构：vendor 上游 + 最小补丁 + shim

`src/v2/upstream/` 按 `@opencode/core` v2.0.23 的 `packages/core/src` 相对导入图搬运，`.js` 后缀导入名保留（bun 直接把 `.js` 解析到 `.ts`；NodeNext 的 typecheck 也能解析）。对照 `sst/opencode` 同一 tag 的 `packages/core/src` 逐文件 diff，改动分四类：

| 类别 | 文件 |
| --- | --- |
| **原样搬运（diff = 0）** | `tool/plugin/edit.ts`、`tool/plugin/read.ts`、`tool/plugin/file-diff.ts`、`mime.ts`、`schema.ts`、`effect/keyed-mutex.ts`、`environment/{driver,exec-defaults,files,local}.ts` |
| **机械补丁** | `file-access.ts`、`file-mutation.ts`、`tool/read-filesystem.ts`、`environment/index.ts`：删掉 `makeLocationNode` 导入与 `export const node`（那是宿主 app-node 图的装配，插件用不到），`const layer` → `export const layer`；`environment/index.ts` 另外裁掉 `memory.js` 导出 |
| **`ENCODING PATCH` 标记的编码边界** | 见下节 |
| **shim（宿主内部服务的最小替身）** | `environment/environment.ts`（只留 `{ files }`）、`filesystem.ts`（只留 `Content` schema）、`formatter.ts`（`file() => false`，tag `@opencode/v2/Formatter`）、`permission.ts`（`assert` 直通）、`location.ts`（`Interface = Location.Info`）、`project.ts`（只留纯函数 `root`）、`tool.ts`（只 re-export `Context`）、`session/instructions.ts`（`load` no-op）、`session/error.ts`（`NotFoundError`） |

`src/v2/bridge.ts` 负责装配：建层 → 用 `Effect.all([EditTool.Plugin.effect(...), ReadTool.Plugin.effect(...)])` 在 `Effect.scoped` 里跑一遍并捕获 `editor.add` 的 payload → 把每个 Effect `Schema` 经 `Schema.toJsonSchemaDocument` 转成**普通 draft-2020-12 JSON Schema 对象**（绝不能把 Effect Schema 实例交出去，跨 effect 实例 `decodeUnknownEffect` 会失败）→ 用真实 `ctx.tool.transform` 重新注册 → `execute` 里 `Effect.runPromise` 把 Effect 桥回 Promise（宿主的 `executePromiseTool` 走 `Effect.promise`，所以拒绝会被包装成 `Tool.Error`，与内建工具同一出口），最后把 `output` 重新序列化成**纯 JSON 对象**。上游声明的 `output` 是 Effect Schema，宿主本会走 `Schema.encodeEffect`（能吃类实例）；我们换成普通 JSON Schema 后宿主改走 `Schema.decodeUnknownEffect(Schema.Json)`，而它只接受原型为 `Object.prototype` 的值——上游的 `TextPage` / `ListPage` 是类实例，少了这一步，任何带 `limit`/`offset` 的分页读取和目录列表都会以 `Expected JSON value` 失败（`FileContent` 恰好是对象字面量，所以不带分页参数时会侥幸通过，单测只测小文件就发现不了）。

`src/v2/fs-util.ts` 是最小 `FSUtil.Service`：只实现 `stat` / `readDirectory` / `resolve` / `up`，错误用 `PlatformError.systemError({ _tag: "NotFound" | ... })` 构造，这样 `Effect.catchReason("PlatformError", "NotFound")` 能命中。

## 与上游同步

`scripts/vendor/` 描述 vendored 树的来源与改动，保证上游发版能被及时发现、机械地跟进：

- `manifest.txt` —— 23 个文件的三分类清单，头部记录 `tag` / `commit`。
  - `verbatim` 与上游逐字节一致，`sync` 直接覆盖
  - `patched` = 上游原文 + `patches/<path>.patch`（机械补丁 + `ENCODING PATCH`）
  - `shim` 不参与同步，本地文件为准，且必须带 `// Shim:` 标记
- `patches/*.patch` —— 只有 4 个文件需要打补丁，用 `diff -u --label a/… b/…` 生成，格式稳定可再生。

```bash
scripts/vendor.sh status           # 当前 tag vs 上游最新 tag，逐文件列出变更
scripts/vendor.sh sync <tag>       # 前移到 <tag>：覆盖 verbatim + 应用补丁，冲突则停下
scripts/vendor.sh verify           # 离线校验：树 == 上游原文 + 补丁（抓本地漂移）
scripts/vendor.sh patches          # 重新生成补丁
```

`sync` 会覆盖 `verbatim`、给 `patched` 打补丁、`shim` 一律不动，然后自动跑 `verify` + `typecheck` + `smoke`。补丁打不上就以 `CONFLICT <path>` 中止并把该文件留成上游原文，冲突因此总是显式暴露而不是悄悄错位。

`.github/workflows/upstream.yml` 每周比对一次 `sst/opencode` 的最新 tag，落后就把整份 diff 写进 job summary 并让 CI 变红。

## 编码感知（`ENCODING PATCH`）

对齐是尽力而为，UTF-8 文件与官方完全一致；非 UTF-8 文件保留原编码、BOM 和 CRLF/LF。差异只在 I/O 边界：

- `src/encoding.ts` 新增 `decodeRaw`（BOM → 编码嗅探 → `iconv-lite` 解码）与 `isPlausibleText`。
- `file-mutation.ts`：`readText` 改成按文件原编码解码；新增 `encodeText` 按原编码写回（BOM 按 `Bom.split` + `encodeFile` 还原，UTF-16 BOM 同样正确）。
- `tool/read-filesystem.ts`：`read()` 前置一段转码到 UTF-8 的 hunk。命中下列任一条件就跳过（保持上游原路径）：`detectEncoding` 判为 `UTF-8` / `Binary`、解码后文本含 U+0000、`isPlausibleText` 不通过。

二进制判定因此基于**解码后**文本是否含 U+0000，而非原始字节含 0。`isPlausibleText` 是后加的门：C0 控制字符（除 `\t` `\n` `\f` `\r`）、C1（U+0080–U+009F）、U+FFFD 合计超过 30% 判为非文本——否则一个 8 字节随机块 `00 01 02 03 00 ff 00 99` 会被当成合法 UTF-16 BE（解码后没有 NUL）而提升成文本。

`BOM_SIGS` 的顺序（UTF-16 LE 在 UTF-32 LE 之前）是上游既有行为，未改。

## 覆盖的工具

`edit` / `read` 都被替换，描述与参数说明与 v2.0.23 内置完全一致（`File to edit` / `Exact text to find and replace` 等）。

### `edit`（源：`src/v2/upstream/tool/plugin/edit.ts`）

- `options: { codemode: false, permission: "edit" }`——权限在目录级门控，规则整体 deny 时工具在该目录被隐藏（例如 plan agent 的 edit deny）。
- 三档匹配顺序：精确匹配 → Unicode 归一化匹配（智能引号 / 破折号 / NBSP 等宽度空格 1:1 归一化，偏移量仍指向原文）→ 行级回退（逐行 `trimEnd` + 归一化比较，支持行尾空白差异与整行跨度匹配）。
- CRLF 感知：按文件实际行尾（`\r\n` / `\n`）归一化 `oldString` / `newString` 再匹配与写回。
- 报错逐字对齐：`File not found: ...`、`Path is a directory, not a file: ...`、`Could not find oldString in ...`、`Found N matches for oldString, ...`（`replaceAll` 提示）、`No changes to apply: ...`、`oldString must not be empty. ...`。
- 输出对齐：`content` 为 `Edited <file> (N replacement(s))`（不附 diff 文本）；`output` / `metadata.files` 为 `{ file, patch, status, additions, deletions }`（`createTwoFilesPatch` + `diffLines` 统计）；路径在 location 内为 `/` 分隔的相对路径、外部为绝对路径。
- 整个「读 → 匹配 → 写」按路径串行（对齐上游 `withLock`）。

### `read`（源：`src/v2/upstream/tool/plugin/read.ts` + `tool/read-filesystem.ts`）

- `options: { codemode: false }`（权限按工具名回退到 `read`）。
- 三态结构化输出：小文件（≤ 50 KiB 且未传 `offset`/`limit`）整读为 `{ type: "file", encoding: "utf8" }`；分页读取为 `{ type: "text-page", content, mime, offset, truncated, next? }`；目录为 `{ type: "list-page", entries, truncated, next? }`。
- 分页规则对齐：单页 50 KiB 字节上限、2000 行上限、单行超 2000 字符截断并追加 `... (line truncated to 2000 chars)`、CR 剥离、`limit` 运行时按 2000 截断。上游自 v2.0.13 起移除了 Schema 上的 `maximum: 2000`（描述改为 “defaults to and capped at 2000”），所以超限值在 Schema 层被接受、由 `Math.min(limit, MAX_READ_LINES)` 收敛；单页仍受 50 KiB 字节预算约束，两者取先到者。
- 模型内容格式对齐：`Read file <path>, lines A-B` + `N: line` 行号前缀 + `[Output truncated. Continue reading with offset: N]`；目录为 `Read directory ...` + 每行 `entry.path`。
- 媒体检测对齐上游 `Mime.detect`（magic bytes 而非扩展名）：png / jpeg / gif / webp / pdf 返回 base64 file part + `Image read successfully` / `PDF read successfully`，超 20 MiB 报 `Media exceeds ... byte ingestion limit: ...`。
- 目录排序对齐：目录在前、组内 `localeCompare`，目录名带尾部分隔符。
- 报错逐字对齐：`File not found: ...`（含 `Did you mean one of these?` 建议，大小写不敏感包含匹配、最多 3 条）、`Cannot read binary file: ...`、`Offset N is out of range for this file (M lines)`（v2.0.13 起附带行数）、`Path is not a file or directory: ...`、`Unable to read ...`。
- 文件名恢复对齐：请求名中的普通空格 ↔ 实际文件名中的 NBSP / 窄 NBSP 自动回退。
- `metadata` 对齐：`{ truncated }`。

编码感知带来的正向差异（相对内置）：UTF-16 文件按文本读取（内置会因原始字节含 NUL 报 `Cannot read binary file`），GBK 文件直接显示正确中文而不是 UTF-8 乱码。

每次 `execute` 前用 `ctx.session.get(sessionID).location`（回退到 `ctx.location`）刷新 location 槽位，保持「按会话目录解析相对路径」的旧行为。

## 已知差距（宿主内部拿不到的 API）

对齐是尽力而为，以下上游能力超出插件接口，无法复刻：

1. **Formatter 钩子**：写回后不跑 formatter，diff 以「原内容 vs 重新读取的落盘内容」计算（等价于上游无 formatter 分支）。
2. **逐调用权限断言 / 外部目录审批**：shim 的 `Permission.assert` 是直通的，真正的门控靠 `options.permission` 的目录级隐藏；对 location 外的绝对路径没有 `external_directory` 审批环节。
3. **AGENTS.md 注入**：`read` 成功后不触发 `sessionInstructions` 的 AGENTS.md 发现与注入。
4. **resource 的 worktree 展示**：`session.location` 只带 `directory` 不带 `project`，路径展示（diff/报错里的相对路径）的 worktree 判定回退到插件自身 location 的 project——只影响展示文本，不影响文件访问。

另外：V2 会为配置的插件目录订阅文件监听以实现源码改动自动热重载；在 WSL drvfs（`/mnt/*`）等不支持 inotify 的挂载上会记录 `failed to subscribe ... TimeoutError` 告警——仅自动热重载失效，插件本身正常加载（重载配置或重启会话即可手动生效）。

## 目录

```
opencode-encodeguard-plugin/
├── opencode-encodeguard-plugin.ts  # 插件入口（Plugin.define + setup）
├── index.ts                        # V2 目录入口（Host.resolve 探测 <dir>/index.*）
├── src/
│   ├── encoding.ts                 # 共享编码检测 / 解码 / 编码 / BOM（含 decodeRaw、isPlausibleText）
│   └── v2/
│       ├── bridge.ts               # 建层 → 捕获上游 payload → JSON Schema → 重新注册 + execute 桥接
│       ├── fs-util.ts              # 最小 FSUtil.Service（stat / readDirectory / resolve / up）
│       └── upstream/               # 上游 v2.0.23 源码 + shim（见「实现结构」表格）
├── test/smoke.ts                   # bun 冒烟测试（注册、输入校验、GBK/UTF-16 读写、分页、二进制）
├── scripts/
│   ├── vendor.sh                    # 上游同步：status / sync <tag> / verify / patches
│   └── vendor/
│       ├── manifest.txt             # 23 个 vendored 文件的 verbatim|patched|shim 清单 + 来源 tag
│       └── patches/                 # 4 份补丁（机械 + ENCODING PATCH）
├── .github/workflows/upstream.yml   # 每周比对 sst/opencode 最新 tag，落后即报错
├── opencode.json                   # 本仓库自测配置（"plugins": ["./"]）
├── tsconfig.json
└── package.json
```

## 依赖

运行时（`dependencies`）：`@opencode/{ai,plugin,schema,util}@2.0.23`（类型 + 上游导入面）、`effect@4.0.0-rc.112`（与宿主同版本，必须精确锁定）、`iconv-lite`（编码转换）、`diff`（patch/统计）、`mime-types`（文本输出 mime，与上游同一查询）。

开发（`devDependencies`）：`typescript`、`@types/node`、`@types/mime-types`。

- `npm run typecheck` → `tsc --noEmit`（`test/` 不在 `include` 里）。
- `npm run smoke` → `bun test/smoke.ts`。

## 验证

源码与依赖：`@opencode/*` **2.0.23**、effect **4.0.0-rc.112**（上游 v2.0.23 仍锁定同一 rc，无需改动）。

1. `npm run typecheck` 通过。
2. `npm run smoke` 全过（33 项）：注册出且仅 `edit` / `read`；输入是普通 JSON Schema（无 `$ref`）；必填字段生效、`offset=-1` 被拒；`limit` 已无 Schema 上限，`limit=5000` 由运行时截到恰好 2000 行；`file` / `text-page` / `list-page` / `edit` 四种 `output` 都通过宿主的 `Schema.Json` 校验（`proto=Object`）；GBK / UTF-16 读取正确解码；GBK 分页（`limit=3`、`offset=4998`）；越界 offset 报 `out of range for this file (3 lines)`；二进制拒绝；目录列表；GBK 编辑后落盘仍是 GBK 字节；UTF-16 编辑后仍是 `FF FE` + `utf16le`；缺文件 / 找不到 oldString / 相同字符串三类报错文案。
3. 真实 opencode **v2.0.23** 加载（全局 CLI 已从 2.0.12 升到 2.0.23）：`opencode run --standalone` 日志出现 `msg="loading plugin" id=... entrypoint=file:///.../index.ts`，且没有任何插件相关报错——说明 `.js` → `.ts` 模块解析成功。
4. 宿主内注册与覆盖（同样在 v2.0.23 下）：在 `setup()` 里临时调 `ctx.tool.list()`，对比 `transform` 前后快照——`before` 的 `edit` / `read` 的 `input` 是 Effect Schema，`after` 的 `name` / `input` / `options` 与本插件注册的 payload **完全一致**，证明宿主确实用本插件覆盖了内建同名工具。
5. 真实模型端到端（OpenCode v2.0.23 + 本 worktree 的插件 + 新建的 GBK 项目）：`read notes.txt` 不带参数、带 `limit=2`（走分页）、`read .`（走目录列表）三次调用**全部成功**，中文与 UTF-16 内容正确、`blob.bin` 报 `Cannot read binary file`；`edit` 把 GBK 文件里的『待编辑』改成『已完成』，落盘后与 `iconv` 往返编码**逐字节一致**，未被编辑的 GBK / UTF-16 文件字节数不变；`read` 传 `offset=-1` 时宿主 `validateInput` 拒绝并回显 `Invalid arguments for tool "read": - offset: Expected a value greater than or equal to 0` 及完整参数。
