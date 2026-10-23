# T-LOCAL-011 账户页慢加载定位与最小修复 — 交付报告

- 工单：`拾光云端后台/collab/specs/T-LOCAL-011.md`（只读），回复 #0052/#0053；round2 回复 #0055
- 实施时间：2026-10-23（本机时区）
- 本地工程：`素材管理器`，HEAD `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e` + 既有 T-LOCAL-006～010 未提交改动（全部保留）
- 结论：按 #0052/#0053 的证据，主要延迟包含 TLS 新连接与网络往返；已完成受控 keep-alive、稳定 auth 依赖/在途合并、角色页组列表按需加载。真实空库主页面首屏 1 次 profile、空闲 0 新增；父级重渲染夹具修复前 2 秒 +10 次 profile，修复后 0；5 轮×3 请求握手 15→3。**未把首屏 1 次写成“已确认无限循环”**。未提交/推送/部署，未连接正式云端或正式账户。
- round2（回复 #0055）：移除核心 Agent 不识别的 `freeSocketTimeout`，改为显式 30s 空闲回收并加短时隔离回归；403/写后刷新强制开启新一轮 profile，旧在途响应不能再回填旧权限。首次证据全部保留，新增 `diff-round2.patch`。

## 零、round2 复核收尾（回复 #0055）

GPT 复核 #0054 后只要求两项最小返工；`maxFreeSockets=4` 与当前可见 `impact` 即时读取均维持不变。

1. **空闲连接回收（已修）**：独立检查 Node v22.7.0 核心 `_http_agent`，源码不含 `freeSocketTimeout`（本地探针输出 `hasFreeSocketTimeout false`），因此旧代码把 `freeSocketTimeout: 10000` 传给 `https.Agent` 是无效字段，原报告“空闲 10s 过期”不成立。现改为：Agent 只保留核心支持的 `keepAlive/keepAliveMsecs/maxSockets/maxFreeSockets/scheduling`；在 Agent 的 `free` 事件上给真正处于 `freeSockets` 的 socket 挂 30s 计时器，到点且仍空闲才 `destroy()`，被复用的 socket 不会被误杀；计时器随退出/换身份/材料轮换/`dispose()` 一并清理。新增可注入 `idleSocketMs`（生产默认 30s）的隔离测试：250ms 下空闲池与计时器清零，下一次请求真实重新握手。
2. **403 / 写后刷新竞态（已修）**：`loadProfile` 新增每轮读取序号 `seq`；普通双击刷新仍同代次合并，但 403 与写后 reload 走 `force`，立即作废旧在途轮次。旧响应即使晚到也因 `seq`/当前 entry 不匹配被丢弃，不能重新显示已撤销的 capabilities；写后 reload 也不会复用写前 promise。浏览器级回归复现了两条路径，均证明“旧响应放行后不新增请求、不回填旧权限”。

本轮复跑：`npm test` **199/199**、定向 **71/71**、无头验收 **8/8** 全过；未重跑 T10 全套视觉，未改 `style.css`/页面结构，未提交/推送/部署。

## 一、根因判断（区分已证实与未证实）

### 1. 已由 GPT 真实只读基线证实：TLS/网络是主要耗时

#0053 的 `transport-before.json`（6 次低负载严格 mTLS 样本）：新连接 TLS 601/973/1006ms、总 921/1276/2160ms；keep-alive 首次 1177ms、复用后 530/238ms。`browser-before.json`：登录后 profile 1573/2041ms（仅 1 次，2390ms），角色页 groups 980ms、permissions 1513ms、roles 2078ms，随后串行 impact 964ms。因此不能因空数据慢而归因于索引/Redis；也不能把首屏 profile 1 次说成重复/无限循环。

本机复跑的是隔离 mock，绝对 ms 与公网不可比；可复跑对比的是请求次数、握手次数和同环境相对差值。

### 2. 隔离夹具证实：父级重渲染确实会放大 profile 读取（latent，不等于首屏已发生）

`useCloudAuth` 原先每次渲染返回新对象字面量；`CloudWorkspace.loadProfile` 依赖 `[auth, guard, request]`。父级任何无关状态更新（素材轮询、任务进度、提示等）都会生成新 `loadProfile`，再取一次 `/cloud-management/profile`（3 个云请求）。空库真实页面在无后台轮询时不一定自然触发；#0053 的首屏观测也没有 profile 风暴。但该依赖是真实的放大器。

用真实 `CloudWorkspace + useCloudAuth + 真实本地后端/管理 mock` 做父级每 200ms 重渲染的隔离夹具（legacy 仅把该依赖还原为 `[auth, guard, request]`，并每次传入新的 auth 对象）：

| 2 秒（10 次父级重渲染） | profile 请求 | 云请求 | 首屏就绪 |
| --- | --- | --- | --- |
| 修复前 legacy | 2 → 12（**+10**） | **+30** | 315ms |
| 修复后 current | 1 → 1（**+0**） | **0** | 335ms |

`ui-results.json` 的 `metrics.parentRerenderHarness`；日志 `evidence/ui-verify.log`。

真实主页面（非夹具、空库、`refreshSeconds=0`）同一轮实测：

| 场景 | 结果 |
| --- | --- |
| 首屏完成 | profile 1 次 |
| 空闲 2.5s | +0 |
| 点一次“刷新管理数据” | +1 |
| 连续双击刷新（在途合并） | +1 |
| 切“小组与成员”再切回“个人安全” | +0 |
| 进入“角色与授权”但未进“账户授权” | groups 预取 **0** |
| 进入“账户授权” | groups 读取 **1** |

就绪 333ms（本机 mock，单次运行）。这证明修复后真实页面没有重复取数，也验证显式刷新、双击合并和按需加载没有被“优化”掉。**未用真实账户/正式云端测过**。

### 3. 后端每请求重握手

`CloudManagement.profile()` 用 `Promise.all` 取 `/me`、`/me/capabilities`、`/me/devices`。旧 `#request` 固定 `agent:false` 且每请求重读 CA/证书/私钥，每轮 3 次完整 TLS；每次刷新再多 3 次握手。修复后每个 `CloudAuth` 实例只有一个当前材料对应的受控 `https.Agent`（`keepAlive`，`maxSockets=4`、`maxFreeSockets=4`；空闲 socket 由显式计时器在 30s 后回收——核心 Agent 不支持 `freeSocketTimeout`，不能再写“10s 过期”）。

| 5 轮 × 3 请求 | TLS 握手 | 总耗时（本机 mock） |
| --- | --- | --- |
| 旧 `agent:false` 等价基线 | **15** | 46ms |
| 受控 keep-alive | **3**（仅首轮） | 12ms |
| 随后 20 次顺序 `/me` | **0** | 10ms |

`metrics.backendBenchmark`。公网收益方向与 #0053 的 keep-alive 样本一致；绝对 ms 不外推。

## 二、改了什么

| 文件 | 变化 |
| --- | --- |
| `server/cloud-auth.mjs` | 新增按 `origin + CA/证书/私钥/P12 内容 + P12 口令摘要` 隔离的受控 keep-alive 池；`#invalidate`（退出/换身份/配置变化）销毁旧池；材料同路径续换时摘要变化，下一请求重建并销毁旧池；保留 `rejectUnauthorized:true`、主机名/CA/mTLS、绝对截止、响应上限、重定向拒绝、single-flight 刷新；新增只读 `getConnectionPoolInfo()` 与 `dispose()`（仅诊断/测试）。**round2**：删除无效 `freeSocketTimeout`，改为显式 30s 空闲回收计时器（只回收仍在 `freeSockets` 的 socket）。 |
| `src/cloud-auth.ts` | `useCloudAuth` 的返回 controller 用 `useMemo` 稳定身份；`view/loading/busy` 等真实状态变化时仍会更新。 |
| `src/CloudWorkspace.tsx` | ① `loadProfile` 只依赖 `viewState/accountKey/request/guard`，用 `authRef` 读最新 `readStatus`；同代次并发读取合并为一个 promise；首次加载用 `loading`、已有资料刷新用 `refreshing`；401 立即清空旧资料，403 先清旧权限再按最新 capabilities 重取，切账号/退出先丢弃旧 profile。② 角色页的组列表改为进入“账户授权”子视图后才读取（`groupsLoaded` 防重复），角色权限视图不预取；`impact` 仍随角色详情立即读取，因为它在角色详情中直接显示，不能为省请求隐藏现有信息。**round2**：每轮 profile 读取加 `seq`，403、设备撤销后 reload、小组写后 reload 用 `force` 另起一轮，旧响应不得回填；普通刷新/双击仍合并在途读取。 |
| `tests/cloud-auth-mock.mjs`、`tests/cloud-management-mock.mjs` | 增加真实 TLS 握手计数 `secureConnections()`；round2 仅给管理 mock 增加测试用 `holdNext(pathname)` 挂起/放行指定响应，用于竞态回归；默认业务语义不变。 |
| `tests/cloud-auth.test.mjs` | 新增 5 项：连续复用/dispose、并发上限与下一批复用、同路径材料续换、退出/重登销毁旧池、空闲 socket 有界回收（短计时器）。 |
| `tests/cloud-management.test.mjs` | 新增 profile 两轮刷新握手数回归。 |

`diff.patch` 为 T11 基线→round2 当前的累积补丁（7 文件）；`diff-round2.patch` 为 #0054 交付→round2 的增量补丁（4 文件）。两者均已 dry-run/实际应用并与当前文件逐字节比较，0 差异（`evidence/patch-check.log`）。`CloudWorkspace.tsx` 基线 2567 行，与 T10 报告的重建结果一致。

**未改动**：`server/cloud-management.mjs`、云端任何文件、`scripts/qa.mjs` 的 T-LOCAL-001 补丁、正式配置/CA/地址、`src/style.css`、T10 的界面结构与文案。

## 三、验证

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `npm run build` | 0 | `tsc --noEmit` + `vite build` 通过；仅既有 >500 kB chunk 提示 | `evidence/build.log` |
| `npm test` | 0 | **199/199** 通过 | `evidence/tests-all.log` |
| `node --test tests/cloud-auth.test.mjs tests/cloud-management.test.mjs tests/cloud-release.test.mjs tests/device-enrollment.test.mjs` | 0 | **71/71**（含新增 6 项） | `evidence/tests.log` |
| `node collab/results/T-LOCAL-011/verify-ui.mjs` | 0 | **8/8** 检查全过；真实页面请求数、组列表按需、父级重渲染前后对比、后端握手/时延、空闲回收、403 与写后刷新竞态 | `evidence/ui-verify.log`、`ui-results.json` |
| `patch -p1`（T11 基线→当前 / #0054→round2） | 0 | 7 文件 / 4 文件全部匹配，重建后 0 差异 | `evidence/patch-check.log` |

安全回归覆盖：CA/主机名/客户端证书校验未关闭；`agent` 不跨用户/跨实例共享；材料或口令变化即销毁旧池；退出/重登/配置变化销毁旧池并中止旧请求；写操作不合并不缓存；没有持久权限缓存或任意 TTL；401/403/切账号不保留旧 profile；`CloudConnectionSettings` 的 P12/口令字段未改；T10 的危险操作确认、capabilities 与敏感字段收敛未改。

## 四、证据与复跑

- `collab/results/T-LOCAL-011/diff.patch`（T11 基线→当前，7 文件）
- `collab/results/T-LOCAL-011/diff-round2.patch`（#0054→round2，4 文件）
- `collab/results/T-LOCAL-011/ui-results.json`（机器可读指标）
- `collab/results/T-LOCAL-011/evidence/{build,tests,tests-all,ui-verify,patch-check}.log`
- `collab/results/T-LOCAL-011/evidence/sha256.txt`
- `collab/results/T-LOCAL-011/harness/`（真实组件 + 真实后端/管理 mock 的父级重渲染夹具；legacy 仅改一处依赖，用于前后对比）
- `collab/results/T-LOCAL-011/screenshots/account-1280x800.png`（修复后真实主页面，T10 样式保留）

复跑：先 `npm run build`，再 `node collab/results/T-LOCAL-011/verify-ui.mjs`。脚本自建临时 `MEDIA_DATA_DIR`、一次性 CA/证书、本机随机端口 mock，不读取现有素材库，不连正式云端。

## 五、边界与未完成

- 未提交、未推送、未部署；未重启任何常驻服务；未操作正式服务器/Docker/MySQL。
- 未登录正式云端、未读取/打印正式令牌、私钥、P12 口令；未使用真实账户或真实素材库。
- 未测真实公网 RTT/带宽；本报告的 ms 均为本机回环 mock。公网侧基线以 GPT 的 #0053 只读数据为准，不能把两套数字直接相减。
- T10 视觉验收未整套重跑；本轮只改数据加载、连接复用与角色页组列表时机，`style.css` 和页面结构未动，构建通过。
- `maxFreeSockets=4` 与可见 `impact` 即时读取均按 #0055 确认维持，本轮未改。
- `getConnectionPoolInfo()` 仅用于测试/诊断，未挂任何 HTTP 路由，不向浏览器暴露。

## 六、需要你

① 复核 round2 两项最小返工：`server/cloud-auth.mjs` 的 30s 空闲回收（只回收仍在 `freeSockets` 的 socket、随池清理）与 `src/CloudWorkspace.tsx` 的 `seq/force`（403、设备撤销、写后 reload 另起一轮；普通双击仍合并）。
② 独立复跑 `node collab/results/T-LOCAL-011/verify-ui.mjs`（8/8）与定向测试（71/71），确认新增的“空闲 250ms 回收后重连”“403 旧响应不回填”“写后 reload 不复用旧 promise”可复现；`diff-round2.patch` 可直接应用到 #0054 交付版本。
③ 公网/正式云端侧的真实账户与浏览器端到端验收仍由你和老板执行；需要我配合本地界面时再下单。

## 无需回复

未提交/推送/部署；未连正式云端/账户/素材库；未读密钥/令牌/P12 口令；未改云端源码/迁移/配置/部署单元；未动 Docker/MySQL；未重启用户服务；未改 `scripts/qa.mjs` T-LOCAL-001 补丁；未改 T10 样式。
