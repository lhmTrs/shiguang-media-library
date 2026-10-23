# T-LOCAL-012 安装器实现与接口说明

- 工单：`拾光云端后台/collab/specs/T-LOCAL-012.md`（只读）
- 回复：GPT `#0066`；回复编号 `#0067`
- 本地工程：`素材管理器`，基线 HEAD `2c15663` + 既有 T-LOCAL-006～011 未提交改动（全部保留）
- 本文件只描述本轮安装器改动；未改云端、分析算法、表结构、前端、默认开关。

## 一、改动文件

| 文件 | 改动 |
|---|---|
| `server/audio-engine.mjs` | 重写安装器：固定发布描述、严格 TLS、有界下载、超时/取消、tar-stream 白名单解包、跨进程锁、指针式提交、固定错误码。 |
| `server/index.mjs` | 安装接口要求 `confirm:true`；新增 `POST /api/audio-engine/cancel`；安装/取消/卸载错误统一映射固定码；默认关闭时仍全部 503。 |
| `package.json` / `package-lock.json` | 新增直接依赖 `tar-stream@2.2.0`（原本已是 better-sqlite3 的传递依赖，锁文件已固定）。 |
| `.gitignore` | 精确放行 `!server/audio-engine-ca.pem`，保留 `*.pem` 全局忽略。 |
| `tests/audio-engine-installer.test.mjs` | 新增 13 项定向测试（TLS/下载/取消/恶意归档/链接/锁/提交失败/CA）。 |
| `tests/audio-engine-fixtures.mjs` | 一次性 TLS、回环 HTTPS、合成 tar.gz 夹具。 |
| `tests/audio-feature-flag.test.mjs` | 默认关闭路由从 5 条扩到 6 条（含 cancel）；显式开启后验证缺 confirm 为 400。 |
| `collab/results/T-LOCAL-012/perf.mjs` | 可复跑的隔离冷/热/状态外呼性能证据。 |

未改动：`server/audio-analysis.mjs`、`server/audio-feature.mjs`、`scripts/qa.mjs` 的 T-LOCAL-001 补丁、T10/T11 前端与样式、`拾光云端后台` 任何文件。

## 二、发布信任与 CA

- 生产固定描述在 `server/audio-engine.mjs` 的 `ENGINE_RELEASE`：
  - 版本 `1.0.0`，平台 `darwin` / `arm64`
  - URL `https://112.74.109.173/downloads/audio-engine-v1-macos-arm64.tar.gz`
  - 大小 `120156053`，SHA256 `61911f96c26a5cda6aae214fcde622d952729d48475754902d42905bedc7413e`
  - 归档上限 `130 MiB`，展开上限 `256 MiB`，条目上限 `8`
- 生产路径不读取 `AUDIO_ENGINE_URL` / `AUDIO_ENGINE_SHA256` / 浏览器参数 / 任意 HTTP 路径。
- `server/audio-engine-ca.pem` 是公开证书材料（非私钥）；`.gitignore` 只精确放行该文件，`git check-ignore` 已确认不再忽略，分享包 `server` 白名单会包含它。
- 测试通过构造器注入 `release` / `ca` / `platform` / `arch` / 超时 / `diskFreeBytes`，不暴露到 HTTP。

## 三、磁盘布局与提交

```text
<dataDir>/engines/audio/current.json                 # 当前版本指针，原子 rename 切换
<dataDir>/engines/audio/versions/<version>-<hash12>/audio-analyze
<dataDir>/engines/audio/versions/<version>-<hash12>/.installed.json
<dataDir>/engines/.tmp/job-*/                        # 下载与 staging，0700
<dataDir>/engines/.audio-install.lock/owner.json     # 跨进程锁
```

- 安装：下载 → 长度/hash → gzip/tar 白名单解包 → 校验普通文件 → 写入新版本目录 → 写 `.installed.json` → 写临时指针 → `rename` 成 `current.json`。
- 提交前旧 `current.json` 与旧版本目录始终保留；提交失败只删除尚未切换的新版本目录，不改旧指针。
- `status` 只读 `current.json` + 版本目录 + `.installed.json`，并要求 `lstat` 均为非符号链接普通文件/目录；版本号来自安装标记，不从 URL/请求参数取。
- 兼容旧平铺安装（`engines/audio/audio-analyze` + `.installed.json`），但只有在标记 hash 与当前固定发布一致时才报告已安装。

## 四、接口

所有 `/api` 路由先经过现有 Host、Origin、本机 session、`x-local-token` 校验；功能关闭（`SHIGUANG_AUDIO_ANALYSIS != "1"`）时返回 `503` + `{ code: "AUDIO_FEATURE_DISABLED" }`，不创建实例、不联网、不建表、不 spawn。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/audio-engine/status` | 返回 `{ installed, version, path:null, size, job, expected }`；不发外部请求、不建表、不 spawn。 |
| POST | `/api/audio-engine/install` | body 必须 `{ "confirm": true }`；否则 400 `ENGINE_CONFIRM_REQUIRED`。成功返回当前 job（可能在 downloading）。 |
| POST | `/api/audio-engine/cancel` | 取消当前任务；等待网络/流/临时目录/锁清理完成后返回。空闲时返回当前 status。 |
| DELETE | `/api/audio-engine` | 卸载；安装/取消/卸载进行中返回 409 `ENGINE_BUSY`。 |
| GET | `/api/assets/:id/audio` | 保持原样，默认关闭时 503。 |
| POST | `/api/assets/:id/analyze-audio` | 保持原样，默认关闭时 503。 |

状态机 job state：`queued` → `downloading` → `verifying` → `extracting` → `installing` → `installed`，失败为 `error`，取消为 `cancelled`。job 字段含 `id`、`state`、`bytes`、`total`、`progress`、`error {code,message}`，不含本地路径/令牌/原始异常。

固定错误码：

| code | HTTP（同步错误） | 含义 |
|---|---|---|
| `ENGINE_CONFIRM_REQUIRED` | 400 | 缺少 `confirm:true` |
| `UNSUPPORTED_PLATFORM` | 409 | 非 darwin-arm64，且不联网 |
| `ENGINE_BUSY` | 409 | 进程内/跨进程锁忙 |
| `ENGINE_DISK_SPACE_LOW` | 507（若同步抛出；当前流程为 job error） | 余量小于 2×归档 + 64MiB 预留 |
| `ENGINE_HTTP_STATUS` | job error | 非 200/重定向/非 HTTPS |
| `ENGINE_CONTENT_ENCODING` | job error | 非 identity 压缩编码 |
| `ENGINE_LENGTH_MISMATCH` | job error | 缺失/异常 Content-Length 或实际字节不符 |
| `ENGINE_HASH_MISMATCH` | job error | SHA256 不符 |
| `ENGINE_TIMEOUT` | job error | 空闲 30s 或总截止 10min |
| `ENGINE_CANCELLED` | job error | 已取消 |
| `ENGINE_TLS_FAILED` | job error | 固定 CA/主机名校验失败 |
| `ENGINE_DOWNLOAD_FAILED` | job error | 连接中断/响应中断 |
| `ENGINE_WRITE_FAILED` | job error | 临时文件写入失败 |
| `ENGINE_ARCHIVE_INVALID` | job error | gzip/tar 结构无效、缺少白名单文件 |
| `ENGINE_ARCHIVE_UNSAFE` | job error | 链接/设备/FIFO/绝对路径/`..`/重复/PAX 异常/非白名单 |
| `ENGINE_ARCHIVE_TOO_LARGE` | job error | 条目数或展开字节超限 |
| `ENGINE_UNSAFE_TARGET` | job error | 安装根/版本/临时目录是符号链接 |
| `ENGINE_COMMIT_FAILED` | job error | 新版本目录/指针提交失败（旧版保留） |
| `ENGINE_INSTALL_FAILED` | job error | 未分类失败（不返回原始异常） |

## 五、下载、解包与并发细节

- `https.request` 固定 `ca`、`rejectUnauthorized:true`，单个 keep-alive Agent（`maxSockets=1`、`maxFreeSockets=1`）；不跟随 3xx。
- 必须存在且精确等于发布大小的 `Content-Length`；拒绝 `transfer-encoding` 与任何非 identity `content-encoding`；按实际收到的 chunk 累计，超过期望立即失败。
- 空闲超时默认 30s、总截止 10min；失败/取消/中断都会 `destroy` 请求、响应和写流，删除本次临时目录。
- 临时目录 `0700`，归档与标记 `0600`；安装前检查 `statfs` 可用空间 ≥ `2 × 120156053 + 64MiB`。
- `tar-stream` 解包，白名单只允许普通文件 `audio-analyze`；拒绝 symlink/hardlink/设备/FIFO/目录/绝对路径/`..`/`.`/反斜杠/空段/超长名/重复目标；PAX 只允许 `path` 与当前名一致、`size` 一致及少数元数据键，`linkpath` 与未知扩展直接拒绝。
- 校验与解包使用同一组 `validateEntryName` + `validatePax` + 白名单约束；解包后再 `lstat` 确认普通文件，`chmod 0755`。
- 安装/卸载共用一个跨进程锁目录（`mkdir` 原子创建 + `owner.json` pid/token）；锁主进程仍存活则 `ENGINE_BUSY`，确认 pid 已死才把锁目录 rename 成 `.stale-*` 后清理，不做无条件删锁。
- 取消在下载阶段直接 abort；解包阶段销毁 gunzip/tar 流；提交前再次检查取消。取消等待 `#runInstall` 的 finally（删临时目录、释放锁）后才把状态置为 `cancelled`，之后才允许下一任务。

## 六、复跑

```bash
cd 素材管理器
node --test tests/audio-engine-installer.test.mjs
node --test tests/audio-feature-flag.test.mjs
node --test tests/cloud-auth.test.mjs tests/cloud-release.test.mjs
npm test
npm run build
git diff --check
node collab/results/T-LOCAL-012/perf.mjs
```

## 七、已知限制

- 只支持 darwin-arm64 单一版本；没有动态签名更新平台，符合工单“当前单版本固定 hash”范围。
- 只接受 gzip 压缩的 tar（`.tar.gz`），不接受 zip/裸 tar；当前发布包格式即此。
- 提交阶段（版本目录 rename + 指针 rename + marker 写入）是短临界区；取消请求若恰在此窗口到达，会等提交完成后返回已安装，而不是回滚。下载/校验/解包阶段可取消。
- 隔离测试使用回环 TLS 与合成小归档，绝对毫秒数不代表公网 120MB 正式安装 SLA；未下载真实引擎、未连生产。
- 公开 CA 文件是公开证书材料；本轮未实现 CA 轮换/多 CA 信任链。
