# T-LOCAL-007 第三轮返工报告（回复 #0030）

时间：2026-10-22 15:45 CST
基线：`main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`
范围：只修 #0030 的两项（pathLen 方向、最终元数据取消提交），保留此前所有补丁与证据。
本轮未提交、未推送、未部署；未改 `拾光云端后台` 任何文件；未连正式云端/旧 18443；未操作真实库/素材/账户；未安装系统信任；未弹窗。

## 1. pathLen 计数方向（P2）

**问题**：`countCaBelow` 原来从 `index + 1` 朝根端数。数组顺序是 `leaf → intermediate → root`，pathLen 应数当前签发者向**叶端**的非 self-issued 中间 CA。

**修复**（`server/device-enrollment.mjs`）：
- `countCaBelow(certificates, index)` 改为只遍历 `1 .. index-1`，排除叶（0 不是 CA）与 self-issued CA。
- 预置锚不在响应链时，调用 `countCaBelow(certificates, certificates.length)`，与锚在链内时使用同一路径口径。
- 叶子、锚、有效期、keyCertSign、clientAuth 等既有约束不变；90 天上限未放宽。

**确定性回归**（`tests/device-enrollment.test.mjs`，真实 openssl 生成链）：

| 场景 | 带根 | 不带根 |
| --- | --- | --- |
| root(pathLen0) → intermediate → leaf | 拒绝 | 拒绝 |
| root(2) → parent(1) → child(0) → leaf | 接受 | 接受 |
| root(2) → parent(0) → child(5) → leaf | 拒绝 | 拒绝 |

旧代码上该用例失败（`before-fix-pathlen.log`：第一场景 `Missing expected exception`），新代码三种场景六条断言均通过。

## 2. 最终元数据取消提交（P2）

**问题**：`#saveMetadata` 先改内存再异步写临时文件/fsync/rename；取消落在 rename 期间时，外层 `#assertActive` 只能返回 STALE，磁盘却已 `activated=true`。

**修复**：
- 元数据内容先写唯一暂存文件（`#stageFile`：write + fsync + close + chmod），失败只删自己的暂存文件。
- 提交进入串行链 `metadataPublishChain`；rename 前核验一次操作身份，rename 后再核验一次。
- 若 rename 期间被外部取消/退出/高级配置撤销身份：按单调代次 `metadataCommitSeq` 回滚到提交前内存值（无旧值则删除文件），然后返回 `STALE`。回滚仅在代次未被后一笔提交推进时执行，且串行链保证回滚先于后一笔提交；旧操作不会删除/覆盖新提交。
- 提交成功后的 pending 清理改为同步 `rmSync`，不再留下“已提交却因清理 await 返回 STALE”的窗口。
- 首次安装元数据也走同一发布路径并携带 `entry`；安装阶段取消同样不会把 `activated=true` 落盘。

**确定性回归**：
- `rename` 真实 I/O gate（与独立验收相同位置）：`activated=true` 暂存文件已就绪、rename 未执行时 `cancel()+logout()`，放行后返回 `STALE`，磁盘/内存均 `activated=false`，无暂存残留；原码原钥重试成功。
- `chmod` 暂存 I/O gate：暂存文件写完但未进入 rename 时取消，暂存被清理，磁盘/内存不变；重试成功。
- 旧的时钟同步取消用例仍保留（取消发生在最终元数据构造时）。
- 旧代码上两个 gate 用例均失败（`before-fix-rename-gate.log`、`before-fix-staging-gate.log`，磁盘 `activated=true`）。

## 3. 云端 90 天口径

- 采纳 #0030：本地叶证书仍按 `notAfter - notBefore <= 90 天` 校验，**没有**放宽到 91 天。
- `notBefore` 的 5 分钟安装预检容差保留，Node 真实 TLS 时间校验不关闭。
- 本轮不修改云端；GPT 的云端 `notAfter = notBefore + 90d` 修复按其日志与证据独立保留。

## 4. 测试与证据

全部在 `collab/results/T-LOCAL-007-round3/`：

- `npm test`：**169/169**，0 失败/跳过（`tests-all.log`）。
- `node --test tests/device-enrollment.test.mjs`：**22/22**（`tests-enroll.log`）。
- `node --test tests/cloud-auth.test.mjs`：**19/19**（`tests-auth.log`）。
- `npm run build`（tsc + vite）：退出 0（`build.log`）；`git diff --check` 退出 0（`diff-check.log`）。
- UI 隔离验收 `verify-ui.mjs`：Chromium / WebKit 均 PASS，0 pageerror，各 11 张截图，共 22 张（`test-ui.log`、`ui-results.json`、`screenshots/`）。仍为一次性本机 HTTPS/mTLS mock + 临时 `MEDIA_DATA_DIR`/合成 WAV。
- 独立反例：**未改动** GPT `collab/reviews/T-LOCAL-007-round2/probes.mjs`，在 `/tmp` 按原相对路径复制执行（不写入 GPT 证据目录）。结果 `gpt-probe-results.json`：四个 pathLen 场景 `mismatch:false`；`cancelDuringMetadataRename` 为 `STALE`、`persistedActivated:false`、`staleCommit:false`、重试 `session:true`。日志 `gpt-probe.log`。
- 最小 diff：`diff.patch`（仅 `server/device-enrollment.mjs` 与 `tests/device-enrollment.test.mjs`；在 round2 交付态上 `patch -p1 --dry-run` 与反向 dry-run 均通过，见 `patch-dryrun.log`、`patch-reverse.log`）。
- 旧代码失败对照：`before-fix-pathlen.log`、`before-fix-rename-gate.log`、`before-fix-staging-gate.log`。

## 5. 边界

- 未提交、未推送、未部署；`scripts/qa.mjs` 的 T-LOCAL-001 路由补丁未触碰（开工/交付均保持原工作区 diff）。
- 未修改 `拾光云端后台`；未创建正式账户、未连接正式云端、未访问旧 18443、未安装系统信任。
- 正式 `apiOrigin`/`enrollmentOrigin`/两张公开 CA 仍未签发，`config/cloud-release.json` 继续 `enabled=false`。
- T-LOCAL-001/002/003/005/006 与 CLOUD-001 既有补丁、round1/round2 证据原样保留。

## 6. 待 GPT

1. 按本报告、`diff.patch`、三份测试日志、UI 结果与 `gpt-probe-results.json` 独立复验第三轮；重点看 pathLen 四种链、rename gate 回滚、回滚是否可能覆盖后一笔提交。
2. 若通过，请补充一次性隔离的 Java↔Node 真实开通联调入口；正式 CA/地址与提交/推送/部署仍需老板明确授权，本轮不擅自执行。
