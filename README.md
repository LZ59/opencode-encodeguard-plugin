# opencode-encodeguard-plugin

OpenCode 插件，把内置的 `edit` 和 `read` 替换为编码感知版本，处理 GBK / GB18030 / Big5 / Shift_JIS / UTF-16 LE/BE / UTF-32 时不再乱码。

同一入口同时适配 **OpenCode V2**（`id` + `setup()`）与 **OpenCode V1**（`server()`）：

- V2 文档（权威）：https://opencode/v2/docs/plugins/
- V1 文档（迁移参考）：https://opencode.ai/docs/plugins/

## 安装

### OpenCode V2

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

把 `iconv-lite`、`diff`、`mime-types` 装到插件的 `node_modules/`，运行时向上查找能解析到。

其他形态：

- npm 安装：`{ "plugins": ["opencode-encodeguard-plugin"] }`（安装后按目录入口解析，包根 `index.ts` 提供入口）。
- 把入口文件拷贝/软链到项目的 `.opencode/plugins/`：该目录下的 `.ts` / `.js` 文件会被自动发现（这是 V2 中唯一接受**文件**形态的本地插件位置）。

> 覆盖机制：内置工具本身是 Effect 插件，项目插件在其后按 id 注册；`editor.add` 按 id 覆盖（后注册者胜），所以同名 `edit` / `read` 被本插件替换。

### OpenCode V1（≥ 1.18.29）

```json
{ "plugin": ["/path/to/opencode-encodeguard-plugin/opencode-encodeguard-plugin.ts"] }
```

V1 的 `plugin` 键接受文件路径，直接指向入口 `.ts`。V1 < 1.18.29 期待函数默认导出，无法加载双入口对象导出，请改用本插件的 1.x 版本。

## 覆盖的工具

`edit` / `read` 都被替换。UTF-8 文件与官方完全一致；非 UTF-8 文件保留原编码、BOM 和 CRLF/LF。唯一差异在 I/O 边界：编码检测 + 原编码解码/写回，替代官方的 UTF-8-only 读写。

### V2 路径（`src/v2/*`，对齐 v2.0.12 内置工具）

**`edit`**（参照 `packages/core/src/tool/plugin/edit.ts`）：

- 描述与参数说明与 v2.0.12 内置完全一致（`File to edit` / `Exact text to find and replace` 等），`options: { codemode: false, permission: "edit" }`。
- 三档匹配顺序：精确匹配 → Unicode 归一化匹配（智能引号 / 破折号 / NBSP 等宽度空格 1:1 归一化，偏移量仍指向原文）→ 行级回退（逐行 `trimEnd` + 归一化比较，支持行尾空白差异与整行跨度匹配）。
- CRLF 感知：按文件实际行尾（`\r\n` / `\n`）归一化 `oldString` / `newString` 再匹配与写回。
- 报错逐字对齐：`File not found: ...`、`Path is a directory, not a file: ...`、`Could not find oldString in ...`、`Found N matches for oldString, ...`（`replaceAll` 提示）、`No changes to apply: ...`、`oldString must not be empty. ...`。
- 输出对齐：`content` 为 `Edited <file> (N replacement(s))`（不再附 diff 文本）；`output` / `metadata.files` 为 `{ file, patch, status, additions, deletions }`（`createTwoFilesPatch` + `diffLines` 统计）；路径在 location 内为 `/` 分隔的相对路径、外部为绝对路径。
- BOM 保留（原 BOM 或 `newString` 引入的 BOM），按目标编码以字节层还原（UTF-16 BOM 同样正确）。
- 整个「读 → 匹配 → 写」按路径串行（对齐上游 `withLock`）。
- JSON Schema 输入校验在真实运行时生效（实测类型、必填、`maximum` 上限都会被拒绝并回显 `Invalid arguments for tool`）。

**`read`**（参照 `packages/core/src/tool/plugin/read.ts` + `tool/read-filesystem.ts`）：

- 三态结构化输出：小文件（≤ 50 KiB 且未传 `offset`/`limit`）整读为 `{ type: "file", encoding: "utf8" }`；分页读取为 `{ type: "text-page", content, mime, offset, truncated, next? }`；目录为 `{ type: "list-page", entries, truncated, next? }`。
- 分页规则对齐：单页 50 KiB 字节上限、2000 行上限、单行超 2000 字符截断并追加 `... (line truncated to 2000 chars)`、CR 剥离、`limit` 上限 2000。
- 模型内容格式对齐：`Read file <path>, lines A-B` + `N: line` 行号前缀 + `[Output truncated. Continue reading with offset: N]`；目录为 `Read directory ...` + 每行 `entry.path`。
- 媒体检测对齐上游 `Mime.detect`（magic bytes 而非扩展名）：png / jpeg / gif / webp / pdf 返回 base64 file part + `Image read successfully` / `PDF read successfully`，超 20 MiB 报 `Media exceeds ... byte ingestion limit: ...`。
- 目录排序对齐：目录在前、组内 `localeCompare`，目录名带尾部分隔符。
- 报错逐字对齐：`File not found: ...`（含 `Did you mean one of these?` 建议，大小写不敏感包含匹配、最多 3 条）、`Cannot read binary file: ...`、`Offset N is out of range`、`Path is not a file or directory: ...`、`Unable to read ...`。
- 文件名恢复对齐：请求名中的普通空格 ↔ 实际文件名中的 NBSP / 窄 NBSP 自动回退。
- `metadata` 对齐：`{ truncated }`。
- `options: { codemode: false }`（权限按工具名回退到 `read`）。

编码感知带来的正向差异（相对内置）：UTF-16 文件按文本读取（内置会因原始字节含 NUL 报 `Cannot read binary file`），GBK 文件直接显示正确中文而不是 UTF-8 乱码。二进制判定因此基于**解码后**文本是否含 U+0000，而非原始字节含 0。

### V1 路径（`tools/*`，行为保持不变）

- `edit` 基于 V1 发布版 v1.16.2 的 exact-edit：参数 `path` / `oldString` / `newString` / `replaceAll`，仅精确匹配（无模糊回退），相同报错与输出形状（含 diff 输出）。
- `read` 基于 V1 发布版 v1.17.0：参数 `path` / `offset` / `limit`，目录列表、按行分页（`totalLines` / `hasMore` 语义），图片以 base64 附件返回。
- 这两个文件保持自包含（编码逻辑内联），可单独放进 `.opencode/tools/edit.ts` / `read.ts` 按文件名注册为自定义工具。

## 已知差距（V2 promise 插件拿不到的 API）

对齐是尽力而为，以下上游能力插件接口未暴露，无法复刻：

1. **Formatter 钩子**：写回后不跑 formatter，diff 以「原内容 vs 重新读取的落盘内容」计算（等价于上游无 formatter 分支）。
2. **逐调用权限断言 / 外部目录审批**：promise 插件上下文没有 Permission 服务。`options.permission` 只提供目录级门控（规则整体 deny 时工具在目录级被隐藏，例如 plan agent 的 edit deny）；对 location 外的绝对路径没有 `external_directory` 审批环节。
3. **AGENTS.md 注入**：`read` 成功后不触发 `sessionInstructions` 的 AGENTS.md 发现与注入。
4. **resource 的 worktree 展示**：`session.location` 只带 `directory` 不带 `project`，路径展示（diff/报错里的相对路径）的 worktree 判定回退到插件自身 location 的 project——只影响展示文本，不影响文件访问。

另外：V2 会为配置的插件目录订阅文件监听以实现源码改动自动热重载；在 WSL drvfs（`/mnt/*`）等不支持 inotify 的挂载上会记录 `failed to subscribe ... TimeoutError` 告警——仅自动热重载失效，插件本身正常加载（重载配置或重启会话即可手动生效）。

## 目录

```
opencode-encodeguard-plugin/
├── opencode-encodeguard-plugin.ts  # 插件入口（V2 setup() + V1 server() 双导出）
├── index.ts                        # V2 目录入口（Host.resolve 探测 <dir>/index.*）
├── tools/
│   ├── edit.ts                     # V1 edit（自包含，v1.16.2 语义）
│   ├── read.ts                     # V1 read（自包含，v1.17.0 语义）
│   └── v2.ts                       # V2 装配：描述 / 输入输出 Schema / options / 每次调用解析 session 位置
├── src/
│   ├── encoding.ts                 # 共享编码检测 / 解码 / 编码 / BOM 逻辑
│   └── v2/
│       ├── edit.ts                 # V2 edit 实现（v2.0.12 对齐 + 编码感知 I/O）
│       ├── read.ts                 # V2 read 实现（v2.0.12 对齐 + 编码感知 I/O）
│       └── location.ts             # 位置解析（~ 展开）与 permission resource 计算
├── opencode.json                   # 本仓库自测配置（"plugins": ["./"]）
├── tsconfig.json
└── package.json
```

## 依赖

运行时（`dependencies`）：`@opencode/plugin@^2.0.12`（V2 类型）、`@opencode-ai/plugin@^1.18.32`（V1 类型）、`iconv-lite`（编码转换）、`diff`（patch/统计）、`mime-types`（文本输出 mime，与上游同一查询）。

开发（`devDependencies`）：`typescript`、`@types/node`；`npm run typecheck` 跑 `tsc --noEmit`。

## 验证

已实测环境：OpenCode **v2.0.12**。要点：

1. `opencode api get "/api/plugin?location[directory]=<仓库>"` 可见 `opencode.encodeguard ... active`（入口 `index.ts`）。
2. 用会话内 `read` 读 GBK 中文文件 → 中文无乱码、输出为 `Read file ..., lines 1-N` 格式。
3. 用会话内 `edit` 改写该文件 → `Edited <file> (1 replacement)`，落盘字节仍为 GBK（非 UTF-8）。
4. `read` 传 `limit: 5001` → 被输入 Schema 拒绝（`Expected a value less than or equal to 2000`）。
