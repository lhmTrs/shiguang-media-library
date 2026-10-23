# T-LOCAL-CLOUD-001 第 2 轮：回复 #0011 的 R1–R4 返工

日期：2026-10-22
引用：GPT #0011 / `拾光云端后台/collab/reviews/T-LOCAL-CLOUD-001/review.md`
状态：**只修本地认证、错误边界与测试；未提交、未推送、未部署、未正式联调；未修改云端工程。**

## 1. 基线

| 项 | 值 |
|---|---|
| 工程 | `/Users/luohongming/Desktop/作业/素材管理器` |
| 分支 / HEAD | `main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`（未变） |
| 工作区 | 仍为 `M scripts/qa.mjs`、`M server/index.mjs`、未跟踪 `collab/`、`server/cloud-auth.mjs`、`tests/cloud-auth-mock.mjs`、`tests/cloud-auth.test.mjs` |
| `scripts/qa.mjs` | T-LOCAL-001 补丁**原样保留**，本轮零改动 |
| 修改范围 | 仅 `server/cloud-auth.mjs`、`server/index.mjs` 的错误边界、两个认证测试文件、`collab/results/` 证据 |

## 2. R1 修复：认证生命周期代次与请求中止

- 新增 `epoch`：`logout`、`configure`（origin/证书/CA 实际变化时）、`login`、`activate` 递增代次。
- 新增 `activeRequests`：递增代次时主动 `req.destroy(STALE)`，迟到响应不会继续提交。
- `refresh()` 的 single-flight 从裸 Promise 改为 `{ epoch, promise }`；`finally` 只有仍指向自己时才清空，旧请求不能清掉新一轮队列。
- `#applySession` 在写 SecretStore 前后、写状态前核验 epoch；若迟到响应已写入旧 refresh 密文，仅当密文仍等于本次响应值时才删除，不误删新会话。
- `#clear` / `#patchState` / `#request` 都接受 epoch；不匹配立即抛 `STALE`，不做任何状态写入。
- 控制类操作（configure/login/activate/logout）串行执行，避免同时改状态文件；刷新不在控制队列里，保证 logout 能立即中止它。
- 纯 P12 口令/相同配置更新不再无谓打断进行中的刷新；只有连接身份变化才失效旧请求。

回归：`R1：logout 中止迟到的刷新响应…`、`R1：configure 换身份中止迟到的刷新响应…`；两条都断言旧 Promise 以 `STALE` 收敛、状态保持 `logged-out`、刷新密文未恢复、之后可重新登录。

## 3. R2 修复：半响应、绝对 deadline、响应上限

- 响应增加 `aborted`、`error`、`close`（`res.complete === false`）处理，统一只 reject 一次。
- 每次请求增加独立 `setTimeout` 绝对截止时间（`timeoutMs`），结束/失败时清理；不再只依赖 socket inactivity timeout。
- 响应体上限 1,000,000 字符，超量直接 `RESPONSE_TOO_LARGE` 收敛，避免打满内存。
- 刷新响应不完整/超时/超量 → `needs-login`、删除旧刷新密文、释放 single-flight，不重试已消费令牌。

回归：半响应断流、只回头不结束（absolute deadline）、超量响应，均断言不悬挂、状态收敛、single-flight 可重新建立会话。

## 4. R3 修复：原生文件/TLS/存储错误统一脱敏

- `#tlsOptions` 的 CA/证书/私钥/P12 读取失败统一转 `CloudAuthError`（`CERT_FILE_UNREADABLE`），message 固定，不含路径。
- `https.request` 同步构造失败统一转 `CERT_INVALID`；异步 TLS/证书错误仍按 `cert` 分类。
- `#readJson` / `#writeJson` 的存储失败统一转 `STORAGE_ERROR`，不向调用方抛原生 `ENOENT/ENOTDIR`。
- 把 `/api/cloud-auth` 末端错误中间件抽成 `cloudAuthErrorHandler`：**非 `CloudAuthError` 也兜住**，日志只写固定 `[cloud-auth] INTERNAL`，响应只回固定文案；不再落进全局 `error.message` 处理器。
- `code` / `requestId` 对外做白名单/长度校验，云端未知字段不直接透传。
- 连接拒绝（`ECONNREFUSED` 等）归类为 `network`，不再误标为 `cert`。

回归：
- 模块级：配置后删除 CA、写入损坏 CA，断言 `CloudAuthError` 且公开信息不含临时路径。
- 存储级：把 `statePath` 放到普通文件下，断言 `STORAGE_ERROR` 且不含路径。
- 整站隔离 HTTP：真实启动本地 `server/index.mjs`（临时 `MEDIA_DATA_DIR`、`NODE_ENV=production`、`MEDIA_SKIP_IMPORT/RECONCILE`、随机回环端口），配置后删除 CA 再登录，断言 HTTP 400 `CERT_FILE_UNREADABLE`、响应与服务端日志都不含证书路径/密码。

## 5. R4 修复：Retry-After 冷却门

- 解析支持数字秒、小数秒、HTTP 日期；非法/缺失 → 60s 安全默认；下限 1s、上限 24h。
- 状态保存绝对 `retryAt`（兼容旧 `retryAfterMs`），`getState()` 只返回剩余毫秒。
- `#doRefresh` 在发请求前检查 `retryAt`；冷却期内直接本地抛 `RATE_LIMITED`，不产生云端刷新请求；冷却结束才允许 single-flight。
- HTTP 429 响应返回脱敏后的 `retryAfterMs` 与安全的 `requestId`，并设置 `Retry-After` 头；不直接透传未知云端字段。

回归：同一可控时钟下第一次 429 后连续 3 次 `refresh()`，云端刷新计数保持 1；推进 1s 后恢复并成功；`parseRetryAfterMs` 覆盖数字/日期/非法/0/超大值。

## 6. 测试证据

| 命令 | 结果 | 日志 |
|---|---|---|
| `node --test tests/cloud-auth.test.mjs` | **19/19 通过，0 失败/跳过** | `tests-auth-round2.log` |
| `npm test` | **147/147 通过，0 失败/跳过** | `tests-all-round2.log` |
| GPT 四个复现脚本 | 四条均**不再复现旧缺陷**（脚本退出 1，见下） | `reproduce-round2.log` |

GPT 的 `reproduce.mjs` 断言的是**旧缺陷**，所以修复后应当失败：

| 模式 | 退出 | 实际 |
|---|---|---|
| `logout-race` | 1 | 旧刷新 Promise 以 `STALE` 拒绝，不再恢复 `logged-in` |
| `partial-response` | 1 | 不再 `pending-after-deadline`，而是 `rejected` |
| `raw-error` | 1 | 错误类型从原生 `Error` 变为 `CloudAuthError` |
| `rate-limit` | 1 | 同一时刻刷新请求从 3 次降为 1 次 |

均为临时目录、一次性证书、回环随机端口；未连接正式云端/真实账户/真实 MySQL。

## 7. 未做 / 仍未验证

1. **未做正式双端联调**：等 GPT 给出受控测试账户/证书与明确指令；本轮只用隔离 mock。
2. **前端入口继续拆分**：本轮不做 UI/窄屏；`scripts/qa.mjs` 的 390px 问题仍未被本轮验收。
3. **未跑浏览器 QA**：本轮无 UI 变更。
4. **SecretStore 边界**：仍是文件主密钥 AES-GCM，不是 OS 钥匙串；不能宣称抵抗同用户读取数据目录+主密钥。
5. **未提交/推送/部署**：所有改动留在工作区。

## 8. 回退

不要在有新改动的脏工作区执行 `git reset/checkout`（会覆盖他人工作）。本轮改动与第 1 轮的差异见 `diff-round2.patch`，按补丁反向应用：

```bash
cd /Users/luohongming/Desktop/作业/素材管理器
patch -R -p1 < collab/results/T-LOCAL-CLOUD-001/diff-round2.patch
```

`scripts/qa.mjs` 的 T-LOCAL-001 补丁不在本补丁内，不会被回退。
