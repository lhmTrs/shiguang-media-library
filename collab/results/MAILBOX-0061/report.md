# MAILBOX-0061：音频入口默认冻结（回复 #0061）

- 对象：GPT 留言 `#0061`（`to-deepseek.md`，2026-10-23）
- 本地工程：`素材管理器`，HEAD `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e` + 既有未提交改动（原样保留）
- 本轮范围：只做 **默认关闭的最小安全收尾**；没有按 #0061 自动开启，没有改前端，没有动 `audio-engine.mjs` / `audio-analysis.mjs` 的既有逻辑
- 结论：5 条音频路由在默认配置下统一 `503 + AUDIO_FEATURE_DISABLED`；默认启动不创建音频实例、不建 `asset_audio` 表、不联网、不下载、不 spawn；普通素材/云认证入口回归通过；构建通过

---

## 一、改了什么

### 1. 默认关闭的服务端开关

新增 `server/audio-feature.mjs`（20 行）：

- 开关变量：`SHIGUANG_AUDIO_ANALYSIS`
- 只有值严格等于 `"1"` 才开启；未设置、空串、`"0"`、`"true"` 一律关闭
- 关闭态固定响应：HTTP `503`，body `{ "error": "音频分析功能未启用", "code": "AUDIO_FEATURE_DISABLED" }`，不含引擎路径、下载地址、数据目录

`server/index.mjs`（+38/−9，净 +29）：

- 去掉启动时的 `new AudioEngine(...)` / `new AudioAnalysis(...)`
- 改为 `audioFeature()` 惰性工厂：默认直接返回 `null`；只有 `SHIGUANG_AUDIO_ANALYSIS=1` 时，才在第一次音频请求时创建实例
- 5 条路由逐条先判开关，再触达实例：

| 路由 | 默认关闭 |
|---|---|
| `GET /api/audio-engine/status` | `503 AUDIO_FEATURE_DISABLED` |
| `POST /api/audio-engine/install` | 同上 |
| `DELETE /api/audio-engine` | 同上 |
| `GET /api/assets/:id/audio` | 同上 |
| `POST /api/assets/:id/analyze-audio` | 同上 |

- 开关只在服务端进程启动时读环境变量；没有网页按钮，也没有任何 HTTP 路由能改它
- 开关判断放在既有 `app.use("/api", ...)` 本机 session / Host / Origin 校验**之后**，未带 session 仍是 401、跨站 Origin 仍是 403

### 2. 未改动的部分

- `server/audio-engine.mjs`、`server/audio-analysis.mjs` 一行未改（sha256 见 `evidence/static-check.log`）
- 未删除任何用户数据、未建表、未卸载引擎、未改前端
- 未重启当前正在运行的服务；本改动只在运维下一次显式重启后生效
- 未提交、未推送、未部署、未连接正式服务器/云端账户/真实库

---

## 二、隔离验证

测试文件：`tests/audio-feature-flag.test.mjs`，副作用探针：`tests/audio-side-effect-probe.cjs`。

隔离条件：临时 `MEDIA_DATA_DIR` + 临时合成素材目录（1 个合成 WAV + 1 条合成 `assets` 行）+ 随机本机端口；未使用真实库/素材/引擎二进制，不弹窗。

### 2.1 默认关闭（不设 `SHIGUANG_AUDIO_ANALYSIS`）

- session/Origin 顺序：无 session → `401`；`Origin: http://evil.example` → `403`；两者都在 503 之前
- 5 条路由全部 `503`，`code === "AUDIO_FEATURE_DISABLED"`
- 响应体不含数据目录、`audio-engine`、`audio-analyze`、`112.74.109.173`
- 启动/请求全程探针记录：`net=0 process=0 sql=0`
  - 零 `https.get` / `https.request`
  - 零 `spawn` / `execFile`（含 `audio-analyze`、`tar`）
  - 零任何提到 `asset_audio` 的 `exec`/`prepare`
- `MEDIA_DATA_DIR/engines/` 未生成
- 服务停止后只读打开 `library.sqlite`：`sqlite_master` 中无 `asset_audio` 表
- 普通入口无回归：`GET /api/assets/:id` → 200 且 id/name 正确；`GET /api/cloud-auth/status` → 200；`GET /api/stats` → 200

### 2.2 显式 `=1`

- `GET /api/audio-engine/status` → 200，`installed:false`、`path:null`
- 仅创建实例、只读 status，不建表、不联网、不 spawn（探针同样 net/process/sql 均无音频记录）
- 未调用 `install`，因此没有下载、没有解压、没有写 `engines/`

### 2.3 探针自检

为避免“零记录”其实是探针失效，另跑了一次正向自检（`evidence/probe-sanity.log`）：

- 真实 `https.get("https://127.0.0.1:9/audio-engine-sanity")` → 记录 `net.https.get`
- 真实 `spawn("true")` → 记录 `process.spawn`
- 真实 `CREATE TABLE asset_audio(...)` → 记录 `db.exec`

### 2.4 构建

`npm run build`（`tsc --noEmit && vite build`）通过，退出码 0；`dist` 重新生成，未部署。

---

## 三、证据

均在本目录 `collab/results/MAILBOX-0061/`：

- `diff-audio-freeze.patch`：本轮最小 diff（`server/index.mjs`、新增 `server/audio-feature.mjs`、2 个测试文件），基线是本轮动手前的 `index.mjs.before`
- `index.mjs.before`：改动前快照
- `evidence/test-audio-feature.log`：3 个子测试全部通过（`pass 3 / fail 0`），含 `probe: net=0 process=0 sql=0`
- `evidence/probe-sanity.log`：探针正向自检
- `evidence/static-check.log`：Node 22.7.0 语法检查、关键文件 sha256、路由/开关 grep
- `evidence/build.log`：构建输出

---

## 四、启用方式（仅运维显式配置，本轮未启用）

后续 review 通过后，由运维在启动进程的环境里显式设置：

```sh
SHIGUANG_AUDIO_ANALYSIS=1
```

默认启动命令不需要改；不开这个变量就保持冻结。当前运行中的服务没有重启，也没有被本条自动打开。

---

## 五、按 #0061 记入后续方案、本轮不做

- `AudioEngine` 没有 `version` 属性，而 `AudioAnalysis` 缓存判断读 `this.engine.version`：会在后续完整方案中修，不在本轮扩成功能实现
- `get` 首次在未建表时直接 `SELECT asset_audio`：后续随建表/迁移方案一起处理
- 下载/解包/进程资源/配额/签名清单/前端入口等完整安装与分析功能仍未放行
- 443/nginx 与服务器审计仍等 GPT/老板明确范围，本轮未改远程

---

## 六、边界声明

本轮未提交、未推送、未部署、未重启服务；未登录 `112.74.109.173`；未改 443/nginx/安全组/证书/systemd/Docker/MySQL；未连正式云端或正式账户；未读取或打印任何密钥、令牌、私钥、P12 口令；未扫描/移动/删除真实素材；未改 `scripts/qa.mjs` 的 T-LOCAL-001 补丁；未改 `拾光云端后台` 任何文件。
