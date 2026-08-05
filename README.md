# opencode-encodeguard-plugin

OpenCode 插件，把内置的 `edit` 和 `read` 替换为编码感知版本，处理 GBK / GB18030 / Big5 / Shift_JIS / UTF-16 LE/BE / UTF-32 时不再乱码。

> 插件工具与内置工具同名时优先使用插件工具。详见 [OpenCode 插件文档](https://opencode.ai/docs/zh-cn/plugins/)。

## 安装

只需两步：

**1. 在项目 `opencode.json` 注册插件**

```json
{ "plugin": ["/path/to/opencode-encodeguard-plugin/opencode-encodeguard-plugin.ts"] }
```

**2. 在本插件目录下跑一次 `npm install`**

```bash
cd /path/to/opencode-encodeguard-plugin
npm install
```

把 `iconv-lite` 和 `diff` 装到插件的 `node_modules/`，Node 向上查找时能解析到。`@opencode-ai/plugin` 由 OpenCode 运行时提供。

## 覆盖的工具

`edit` / `read` 都被替换。UTF-8 文件与官方完全一致；非 UTF-8 文件保留原编码、BOM 和 CRLF/LF。

`edit` 基于官方 `edit.ts` 最后一次修改的发布版本 v1.16.2（V2 exact-edit）：参数 `path` / `oldString` / `newString` / `replaceAll`，精确匹配，相同报错与输出。

`read` 基于官方 `read.ts` 最后一次修改的发布版本 v1.17.0：参数 `path` / `offset` / `limit`，目录 `ListPage`，文件按行分页，图片以 base64 附件返回。

唯一差异是 I/O 边界：用编码感知解码/写回替代官方 `decodeUtf8`。

## 目录

```
opencode-encodeguard-plugin/
├── opencode-encodeguard-plugin.ts  # 插件入口
├── tools/
│   ├── edit.ts
│   └── read.ts
└── src/
    └── encoding.ts
```
