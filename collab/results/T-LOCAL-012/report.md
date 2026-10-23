# T-LOCAL-012 本地音频引擎安装器加固 — 交付报告

- 工单：`拾光云端后台/collab/specs/T-LOCAL-012.md`（只读）
- 回复：GPT `#0066`；DeepSeek 回复编号 `#0067`
- 实施时间：2026-10-23（本机时区）
- 本地工程：`素材管理器`，基线 HEAD `2c15663` + 既有 T-LOCAL-006～011 未提交改动（全部保留，未混入本补丁）
- 结论：按 #0066 的“先安装器安全加固和隔离测试”完成实现；未做前端/分析算法，未启用默认开关，未提交/推送/部署，未访问生产服务器或真实引擎。

## 一、范围与结论

本轮只处理安装器安全层：

1. 生产信任固定为应用内 `ENGINE_RELEASE`（`1.0.0` / darwin-arm64 / 120156053 字节 / SHA256 `61911f96…c7413e`），HTTP、浏览器、普通环境变量不能替换 URL/hash/CA。
2. 下载改为严格 TLS、固定 CA、单 Agent keep-alive、拒绝重定向/压缩编码/异常长度；流式累计字节，空闲 30s、总截止 10min，取消/中断清理网络与临时目录。
3. 解包改用成熟库 `tar-stream`，只允许白名单普通文件 `audio-analyze`；拒绝链接/设备/FIFO/绝对路径/`..`/重复/异常 PAX/超长/超量。
4. 安装/取消/卸载共享状态机与跨进程锁；先写新版本目录，再原子切换 `current.json`，旧版本保留到提交成功；提交失败旧版本仍可用。
5. 新增 `POST /api/audio-engine/cancel`；install 必须 `confirm:true`；默认关闭时 status/install/cancel/uninstall/get/analyze 六条路由仍统一 503。
6. 公开 CA 随 Git 检出与分享包一致提供：`.gitignore` 精确放行 `!server/audio-engine-ca.pem`，未取消 `*.pem` 全局忽略。

## 二、改了什么

| 文件 | 变化 |
|---|---|
| `server/audio-engine.mjs` | 安装器重写：固定发布描述、TLS/下载、超时/取消、tar-stream 白名单解包、跨进程锁、指针式提交、固定错误码、`version`/`binaryPath` 只读接口供后续 analysis 使用。 |
| `server/index.mjs` | install 要求 `confirm:true`；新增 cancel 路由；安装/取消/卸载错误统一固定码，不回落原始异常。 |
| `package.json`、`package-lock.json` | 新增直接依赖 `tar-stream@2.2.0`（锁文件固定；原本已是传递依赖）。 |
| `.gitignore` | 只精确放行公开 CA，不取消其它 `*.pem`/`*.key` 忽略。 |
| `tests/audio-engine-installer.test.mjs` | 13 项定向测试：成功/复用/状态零外呼、确认/平台/磁盘、hash/长度/编码/重定向/证书/中断、空闲/总截止、两阶段取消、恶意归档 12 类、目标/父链接、提交失败保留旧版、活锁/死锁/双进程、CA 分发、错误脱敏。 |
| `tests/audio-engine-fixtures.mjs` | 一次性 openssl 证书、回环 HTTPS、合成 tar.gz、release/engine 夹具。 |
| `tests/audio-feature-flag.test.mjs` | 默认关闭路由扩到 6 条；显式开启后验证缺 confirm 400、cancel 空闲 200。 |
| `collab/results/T-LOCAL-012/perf.mjs` | 可复跑冷/热/状态外呼证据。 |

未改动：`server/audio-analysis.mjs`、`server/audio-feature.mjs`、`scripts/qa.mjs` 的 T-LOCAL-001 补丁、T10/T11 前端与 `style.css`、`拾光云端后台` 任何文件。

## 三、验证

全部为临时 `MEDIA_DATA_DIR`/临时目录、合成文件/合成小归档、随机回环 TLS；未下载 120MB 真实引擎、未访问 `112.74.109.173`、未连正式账户/库/素材。

| 检查 | 结果 | 证据 |
|---|---|---|
| 安装器定向测试 | **13/13 pass，0 fail** | `evidence/installer-tests.log` |
| 默认冻结/路由回归 | **3/3 pass，0 fail**；6 路由 503；无 session 401、跨站 Origin 403 先于 503；探针 `net=0 process=0 sql=0` | `evidence/default-freeze.log` |
| 全量单元测试 | **215/215 pass，0 fail** | `evidence/full-tests.log` |
| 认证/发行配置入口回归 | **26/26 pass，0 fail** | `evidence/auth-release.log` |
| 构建 | `npm run build` 退出码 0（tsc + vite） | `evidence/build.log` |
| 空白/补丁检查 | `git diff --check` 退出码 0；`diff.patch` 对基线 dry-run/实际应用后 8 个文件逐字节一致 | `evidence/diff-check.log`、`evidence/patch-check.log` |
| 补丁可应用性 | 从基线副本 `patch -p1` 成功，8 个文件 `cmp` 全部 OK | `evidence/patch-check.log` |

覆盖的负例（安装器测试内）：hash 错、缺/错 Content-Length、压缩编码、302、证书不匹配、socket 中断、空闲超时、慢速滴流总截止、下载取消、解包阶段取消、重入 BUSY、安装中卸载 409、symlink/hardlink/FIFO、`../`、绝对路径、超长名、重复目标、PAX 路径/未知扩展、非白名单、展开超量、条目超量、目标/父目录链接、磁盘不足、提交失败保留旧版、活锁 BUSY、死 pid 锁恢复、双进程竞争、缺 confirm、非支持平台、CA 检出/分享一致性。

## 四、隔离性能（不代表公网正式安装 SLA）

`perf.mjs`：随机回环 TLS + 合成 4KB gzip 归档（压缩后 119 字节），临时数据目录；每轮 1 次请求。

| 场景 | 样本 | 平均耗时 | 握手数 | 说明 |
|---|---|---|---|---|
| 冷路径（每轮新实例/新连接池） | 5 | 13.35 ms | **5** | 每轮 1 次新 TLS + 1 次请求 |
| 热路径（同实例，卸载后重装） | 5 | 10.94 ms | **0** | 复用 keep-alive 连接，1 次请求 |
| status 轮询 | 500 次 | 19.02 ms（0.038 ms/次） | **0 请求 / 0 握手** | 只读本地指针/标记，无外呼 |

产物：`perf.json`、`evidence/perf.log`。这些数字只证明隔离环境的行为与连接复用，不宣称 120MB 公网下载耗时。

## 五、边界与未做

- 未提交、未推送、未部署；未重启当前服务；未改默认启动环境或开启 `SHIGUANG_AUDIO_ANALYSIS`。
- 未连 `112.74.109.173`、未下载/执行真实发行引擎、未动 nginx/安全组/证书/systemd/Docker/MySQL、未操作真实素材/库。
- 未改云端工程任何文件；唯一写云端例外未触发（本轮不需要 `collab/results/<工单号>`）。
- 未实现前端、analysis schema/算法、CA 轮换/多 CA、动态签名更新平台。
- 旧平铺安装兼容读取；新安装写版本目录 + `current.json`。
- 取消在提交短临界区到达时会等提交完成并返回已安装；下载/校验/解包阶段可取消。

## 六、需要 GPT 验收

1. 重点 review：固定发布描述不可被环境变量/HTTP 替换；TLS/长度/hash/超时/取消；tar-stream 白名单与 PAX/链接防护；跨进程锁与提交失败保留旧版；status 零外呼/错误脱敏。
2. 独立验收通过后再决定下一层（前端/分析）；本轮不自行扩展。
3. 若需返工，请限定文件/行为/测试范围；不要要求关闭默认开关或改 8443。

## 七、文件索引

- `implementation.md`：布局、接口、错误码、并发/取消语义、复跑命令、限制。
- `diff.patch`：相对开工基线的最小补丁（8 个文件；不含本轮报告/日志/性能脚本）。
- `perf.json`、`perf.mjs`：隔离性能。
- `evidence/`：`installer-tests.log`、`default-freeze.log`、`full-tests.log`、`auth-release.log`、`build.log`、`diff-check.log`、`patch-check.log`、`perf.log`。

## 八、Round 2（回复 GPT #0068，三项最小返工）

GPT 首轮独立验收 16/16 通过，但 `probe-round1.mjs` 三个反例全部复现；本轮只修安装器与必要测试，未改分析算法/表结构/前端/云端，未启用默认开关、未重启/部署/正式下载执行。

### 8.1 修复

1. **共享 `.tmp` 误删**：安装任务改用私有前缀 `audio-installer-job-*`，目录内写 `.owner.json`（`kind=shiguang-audio-installer` / pid / jobId / 32 位随机 token）。`#cleanOwnedTmp` 只回收“同前缀 + 非链接目录 + owner 格式有效 + 记录 pid 已死”的目录；未知目录、无标记目录、活跃进程目录一律保留。成功/取消/卸载/崩溃恢复都走同一规则。
2. **状态信任链**：`#installedInfo` 现在逐级校验 `enginesRoot → engineRoot → versionsRoot → 版本目录 → binary`，`current.json` / 版本 `.installed.json` / legacy marker 均为非链接普通文件，`O_NOFOLLOW` 打开且有界读取（≤4 KiB）；指针损坏/链接/超限直接视为未安装，不再静默回退 legacy。legacy 平铺路径的 marker 同样校验；`binaryPath` 在未通过信任链时返回 `null`，不提供越界路径。status 仍为纯只读、零外呼。
3. **tar 元数据预算**：在 `gunzip` 之后、`tar-stream` parser 之前加总字节计数 `Transform`，硬上限为 `extractedMaxBytes + 固定 64 KiB`（覆盖 tar header/PAX/GNU 元数据/padding；该上限由 `safeRelease` 计算，外部传入更大值会被压回固定上限）。超限统一 `ENGINE_ARCHIVE_TOO_LARGE`，并销毁 read/gunzip/counter/extractor；解包流量中取消同样走该清理路径，新增测试验证 temp/staging 清理。仍保留根因修复前的 `header.size` 与展开总量检查，不手写 tar parser，不把压缩上限当展开上限。
4. **锁回收 fail-closed**：去掉“无 owner 超过 2 秒即回收”的时间盲删。新建锁先写完整 owner 到私有 creating 目录，再原子 `rename` 成锁目录；没有可验证 owner 的锁一律 `ENGINE_BUSY` 并原样保留。死 owner 锁仍可恢复，回收前二次读取并核对 token，缩小竞争窗口。

### 8.2 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 安装器定向测试 | **18/18 pass，0 fail**（新增 5 项：无 owner 锁、共享 `.tmp` 归属、三代祖先/legacy marker 链接、PAX 膨胀/多扩展头、解包流量中取消） | `round2/evidence/round2-installer-tests.log` |
| 默认冻结/路由回归 | **3/3 pass，0 fail**；6 路由 503、`net=0 process=0 sql=0` 不变 | `round2/evidence/round2-default-freeze.log` |
| GPT 首轮独立反例 | **3/3 pass，0 fail**（直接运行云端 `probe-round1.mjs`） | `round2/evidence/round2-gpt-probe.log` |
| 构建 | `npm run build` 退出码 0 | `round2/evidence/round2-build.log` |
| 语法/空白 | 两个改动文件 `node --check` 通过；`git diff --check` 退出码 0 | `round2/evidence/round2-syntax.log`、`round2-diff-check.log` |
| 补丁往返 | `round2/diff-round2.patch` 从 Round 1 基线副本 `patch -p1` 成功，两文件 `cmp` 一致 | `round2/evidence/round2-patch-check.log` |

未重跑全量 215 项与 perf：本轮只改安装器临时目录/状态读取/解包流量上限与锁策略，按 #0068“重跑安装器/冻结与必要定向构建”执行；Round 1 的 `evidence/full-tests.log`、`perf.json` 原样保留，不把旧数字冒充本轮重跑。新增的 Transform 未单独做性能采样，不宣称性能结论。

### 8.3 边界

未提交/推送/部署；未重启当前服务；未开启 `SHIGUANG_AUDIO_ANALYSIS`；未连 `112.74.109.173`、未下载/执行真实发行引擎；未操作 Docker/数据库/正式账户/真实素材；未读取或打印任何密钥/令牌/私钥/P12 口令；未改 `拾光云端后台` 任何文件；未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁；未改 T10/T11 样式、分析算法/schema、前端。

### 8.4 文件

- `round2/diff-round2.patch`：相对 Round 1 交付状态的最小补丁（`server/audio-engine.mjs` + `tests/audio-engine-installer.test.mjs`）。
- `round2/evidence/`：上述 7 份日志（含补丁往返）。
- 复跑：`node --test tests/audio-engine-installer.test.mjs`；`node --test tests/audio-feature-flag.test.mjs`；`node --test <云端>/collab/reviews/T-LOCAL-012/probe-round1.mjs`；`npm run build`；`git diff --check`。

## 九、Round 3（回复 GPT #0071：锁恢复竞态收尾）

Round 2 的三项修复不在本轮返工范围内。本轮只改锁获取/恢复/释放与竞争回归测试，采用 #0071 明确允许的**最保守策略**：运行期不再自动回收任何已存在的锁，死锁维护改为显式人工操作。

### 9.1 竞态根因与本轮决策

Round 2 的回收路径是“读到死 owner → 再读一次核对 token → `rename(lockRoot, stale)` → `rm(stale)`”。`rename` 只能覆盖/移动**当前路径上已有的目录**，没有“目标仍是刚才那个死锁”的条件判断。因此存在下列可达交错：

1. A、B 都读到死 owner；
2. A 完成最后核对后暂停；
3. B 回收死锁并安装自己的活锁；
4. A 继续 `rename(lockRoot, stale)`，把 B 的活锁整体搬走并删除；
5. A 随后也安装成功，跨进程互斥失效。

再读一次 owner、增加 sleep 或重试都不能把 `rename` 变成条件原子操作。本轮直接删除自动回收分支：

- `#peekLockBusy`：`lstat` 到锁路径即返回 busy（不再按 owner pid 判断）。
- `#acquireLock`：仍先在私有 creating 目录写完整 owner，再原子 `rename` 抢锁；任何 `EEXIST/ENOTEMPTY/ENOTDIR/EISDIR` 一律 `ENGINE_BUSY`，不 `rename` 锁目录、不删除锁目录、不产生 `.stale-*`。
- `#releaseLock`：保持“只删除 owner token 与自身一致的锁”，活 owner 不会被其他进程误删。
- 无 owner、owner 不可校验、owner 进程已死、锁路径是文件/链接：全部 fail-closed `ENGINE_BUSY`。

**维护恢复（仅人工，确认无安装/卸载进程后）**：检查 `engines/.audio-install.lock/owner.json` 的 pid，确认该进程不存在且当前没有安装/卸载任务；先把整个锁目录移到 `engines/` 外的备份位置（保留证据），再重新发起安装。不要在进程存活或任务运行中删除锁；服务运行期不会自动做这一步。完整命令与禁止事项见 `round3/maintenance.md`。

### 9.2 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 安装器定向测试 | **19/19 pass，0 fail**；锁测试改为“活锁/死锁均 BUSY、原样保留、人工清理后可安装”，新增“死锁被换入活 owner 后不得 rename/删除”回归 | `round3/evidence/round3-installer-tests.log` |
| 按新契约调整的锁竞态探针 | **1/1 pass，0 fail**；替换后的 `replacement-live-owner` 保留，无 `stale` rename，无 installed 状态 | `round3/evidence/round3-lock-probe.log`、`round3/probe-lock-race-failclosed.mjs` |
| 默认冻结/路由回归 | **3/3 pass，0 fail**；6 路由 503、`net=0 process=0 sql=0` 不变 | `round3/evidence/round3-default-freeze.log` |
| 构建 | `npm run build` 退出码 0（仅既有 503.25kB chunk 提示） | `round3/evidence/round3-build.log` |
| 语法 | `node --check server/audio-engine.mjs` 退出码 0 | `round3/evidence/round3-syntax.log` |
| 补丁往返 | `round3/diff-round3.patch` 从 round2 基线副本 `patch -p1` 成功，两文件 `cmp` 一致 | `round3/evidence/round3-patch-check.log` |

关于 GPT 原 `probe-lock-race.mjs`：它通过拦截 `fs.rename(lockRoot, .stale-*)` 注入交错；round3 已没有该 rename 调用，原注入点不可达，原探针的 `replaced === true` 前置断言不再适用。按 #0071“探针/旧死锁测试按新安全契约调整并保留对活锁的验证”，本目录保留同源的 `probe-lock-race-failclosed.mjs`，保留“替换后的活 owner 必须保留、不得搬移/删除、安装不得成功”的核心断言，未删保护断言。

### 9.3 边界

未提交/推送/部署；未重启当前服务；未开启 `SHIGUANG_AUDIO_ANALYSIS`；未连 `112.74.109.173`、未下载/执行真实发行引擎；未操作 Docker/数据库/正式账户/真实素材；未读取或打印任何密钥/令牌/私钥/P12 口令；未改 `拾光云端后台` 任何文件；未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁；未改 T10/T11 样式、分析算法/schema、前端、临时目录/tar/状态信任链三项已过修复。

### 9.4 文件与复跑

- `round3/diff-round3.patch`：相对 round2 交付状态的最小补丁（`server/audio-engine.mjs` + `tests/audio-engine-installer.test.mjs`）。
- `round3/baseline/`：打补丁前的 round2 基线副本（用于 diff/往返校验）。
- `round3/maintenance.md`：锁残留的人工维护恢复命令与禁止事项。
- `round3/evidence/`：上述 6 份日志。
- 复跑：`node --test tests/audio-engine-installer.test.mjs`；`node --test tests/audio-feature-flag.test.mjs`；`node --test collab/results/T-LOCAL-012/round3/probe-lock-race-failclosed.mjs`；`npm run build`。

## 十、Round 4（回复 GPT #0075：空锁覆盖竞态）

### 10.1 根因与修复

Round 3 的获取路径是 `mkdir(creating) → 写 owner → rename(creating, lockRoot)`。POSIX 的 `rename` 在目标是**已存在的空目录**时不会返回 `EEXIST`，而是静默替换。`install()` 的同步 `#peekLockBusy()` 与异步 `#runInstall()` 里的 `#acquireLock()` 之间存在窗口：若此时出现一个无 owner 的空锁，旧实现会覆盖它并继续下载。这不是“恢复死锁”的问题，而是获取原语本身不排他。

本轮只改锁获取与回归测试：

- `#acquireLock` 改为直接 `mkdir(lockRoot)` **排他**抢锁。`mkdir` 不会覆盖任何已存在路径；`EEXIST/ENOTEMPTY/ENOTDIR/EISDIR` 一律 `ENGINE_BUSY`，原锁（含无 owner/死 owner/文件/链接）原样保留。
- mkdir 成功后用 `writeFile(owner.json, { flag:"wx" })` 写 owner。mkdir 到写 owner 之间有极短无 owner 窗口：此间竞争者只会看到锁存在并 fail-closed BUSY，不会删除/搬走它。
- 写 owner 失败时只调用 `removeEmptyLockDir()` 清理由本进程刚建、且仍无 `owner.json` 的空目录；owner 已存在或目录已被替换则保留。
- `#peekLockBusy`、`#releaseLock`、人工维护恢复策略不变；没有恢复自动回收，没有 `rename(lockRoot, stale)`，没有 `.stale-*`。
- 删除 `creating` 私有目录与 `rename` 获取路径；不再产生 `.audio-install.lock.creating-*`。

### 10.2 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 安装器定向测试 | **20/20 pass，0 fail**（原 19 项 + 新增 mkdir 注入竞态 1 项） | `round4/evidence/round4-installer-tests.log` |
| 按新注入点适配的空锁竞态探针 | **1/1 pass**：注入 `injected=true`、`ENGINE_BUSY`、原锁 inode 不变、`requests=0` | `round4/probe-lock-empty-race.mjs`、`round4/evidence/round4-adapted-lock-probe.log` |
| 默认冻结/路由回归 | **3/3 pass，0 fail**；6 路由 503、`net=0 process=0 sql=0` 不变 | `round4/evidence/round4-default-freeze.log` |
| 构建 | `npm run build` 退出码 0（仅既有 503.25kB chunk 提示） | `round4/evidence/round4-build.log` |
| 语法 | `node --check server/audio-engine.mjs` 退出码 0 | `round4/evidence/round4-syntax.log` |
| 补丁往返 | round3 交付副本 + `diff-round4.patch` 后两文件 `cmp` 一致 | `round4/evidence/round4-patch-check.log` |

### 10.3 关于云端 probe.mjs（本侧未改动）

按 #0075 用当时的云端探针（13:33 版本）原样复跑：

- 修复前 **0/2**（T12 `injected=true, state=installed, requests=1`；T13A `exit=1, unhandled=true`）。
- 修复后、云端更新前再次原样复跑：T13A **通过**（`exit=0, state=spawn-error, unhandled=false`）；T12 的注入点是 `fs.rename(creating, lockRoot)`，Round 4 已删除该 rename，注入点不可达，得到 `injected=false, state=installed, requests=1`，卡在探针自己的 `injected===true` 前置断言上。这里的 `installed` 是“注入未发生、正常安装成功”，不是空锁被覆盖。

GPT 随后在云端把 `probe.mjs` 更新为**同时注入 `fs.mkdir(lockRoot)` 或 `fs.rename(creating, lockRoot)`**（13:37，云端侧改动，本侧未修改）。用更新后的原 probe 复跑：**2/2 pass，0 fail**，T12 注入命中后为 `injected=true, code=ENGINE_BUSY, requests=0`；新增的 `startup-recovery-probe.mjs` 也 **2/2 pass**（ENOENT/EACCES 受控且同 executor 下一任务成功）。证据：`round4/evidence/round4-cloud-probe-after.log`、`collab/results/T-LOCAL-013A/fix-spawn/evidence/spawn-cloud-recovery-probe.log`。

本侧另外保留 `round4/probe-lock-empty-race.mjs`：即使云端探针回到只认 rename 的旧版本，也能用同一时序在 `fs.mkdir` 前注入并断言 `injected=true / ENGINE_BUSY / inode 不变 / 零下载`，1/1 通过。未改云端 probe，未删任何保护断言。

### 10.4 文件与复跑

- `round4/diff-round4.patch`：相对 round3 交付状态的最小补丁，仅 `server/audio-engine.mjs` + `tests/audio-engine-installer.test.mjs`。
- `round4/probe-lock-empty-race.mjs`：适配新注入点的空锁竞态探针。
- `round4/evidence/round4-cloud-probe-after.log`：云端更新后原 probe 的 2/2 实际输出。
- 复跑：`node --test --test-concurrency=1 tests/audio-engine-installer.test.mjs`；`node --test collab/results/T-LOCAL-012/round4/probe-lock-empty-race.mjs`；`node --test tests/audio-feature-flag.test.mjs`；`npm run build`；`cd 拾光云端后台 && node --test collab/reviews/T-AUDIO-HANDOFF-20261023/probe.mjs`。
