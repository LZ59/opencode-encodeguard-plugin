# AGENTS.md

## 版本策略

- 插件版本**跟随上游**：`package.json` 的 `version` 必须等于 `scripts/vendor/manifest.txt` 里记录的 `sst/opencode` tag 去掉 `v`（当前 `v2.2.5` → `2.2.5`）。
- 同步上游时一并改版本，不要单独递增插件版本：

  ```bash
  npm version <tag> --no-git-tag-version   # 同时更新 package.json 与 package-lock.json
  ```

## 上游同步

```bash
scripts/vendor.sh status        # 当前 tag vs 上游最新 tag
scripts/vendor.sh sync <tag>    # 覆盖 verbatim + 应用补丁 + 重生成补丁
scripts/vendor.sh verify        # 树 == 上游原文 + 补丁
```

- `verbatim` 文件由 `sync` 覆盖；`patched` 文件冲突会显式中止；`shim` 不参与同步，需按上游对应文件的 API 变化手动跟进。
- 同步后依次跑 `vendor.sh verify`、`npm run typecheck`、`bun test/smoke.ts`（无 bun 时用 `npx bun@1 test/smoke.ts`）。
