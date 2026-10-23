# T-LOCAL-CLOUD-001 交付报告（第一阶段：隔离 mock）

## 1. 基线

| 项 | 值 |
|---|---|
| 本地工程 | `/Users/luohongming/Desktop/作业/素材管理器` |
| 分支 / HEAD | `main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e` |
| 开工时工作区 | 含未提交的 T-LOCAL-001 补丁（`scripts/qa.mjs`，1 处路由匹配）+ 未跟踪的 `collab/`；本轮**未触碰**该补丁 |
| 运行时 | macOS 15.7.3 / Node v22.7.0 / OpenSSL 3.3.1（仅测试内生成一次性证书） |
| 契约 | `拾光云端后台/docs/AUTH-API.md`（认证契约 v1） |
| 工单 | `拾光云端后台/collab/specs/T-LOCAL-CLOUD-001.md` |
| 提交状态 | **未提交、未推送**（遵守工单：不提交/不部署/不联调） |

## 2. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/cloud-auth.mjs` | 新增（约 470 行） | 云端认证适配：mTLS 客户端、激活/登录/me/退出、single-flight 刷新、状态机、脱敏状态 |
| `server/index.mjs` | 修改（+14 行） | 实例化 `CloudAuth`；挂 5 个 `/api/cloud-auth/*` 路由；该组专用错误处理（只回脱敏码） |
| `tests/cloud-auth-mock.mjs` | 新增（测试夹具） | 隔离 HTTPS + 双向 TLS mock：一次性 CA/服务端/客户端证书，login/activate/refresh/logout/me 语义、轮换与重放撤销、429、响应丢失 |
| `tests/cloud-auth.test.mjs` | 新增（10 个用例） | 见第 4 节 |

**没有**改动：扫描/标签/项目数据、`scripts/qa.mjs`（T-LOCAL-001 补丁原样保留）、前端任何文件、云端任何文件。

## 3. 设计要点（对照工单“必须实现”）

1. **只走本地后端**：浏览器只访问 `/api/cloud-auth/*`，返回体只有脱敏状态；令牌、私钥、P12 口令不出进程。
2. **严格 TLS**：`rejectUnauthorized: true` 固定，`ca` 必填，不跟随重定向（未启用 followRedirect），`origin` 非 `https:` 直接拒绝，不回退 HTTP。
3. **凭据存储**：沿用项目现有 `SecretStore`（AES-256-GCM + `<dataDir>/secrets-master.key`，文件 0600，**不弹系统钥匙串**）。
   - 刷新令牌：`app_secrets` 的 `cloud.refreshToken`（密文）；
   - P12 口令：`app_secrets` 的 `cloud.p12Pass`；
   - access token：**只在内存**，不落盘；
   - 非敏感状态：`<dataDir>/cloud-auth-state.json`（0600，只有状态/用户名/设备号/到期时间）。
4. **刷新语义**：single-flight（并发只发一次）；刷新前先落盘 `refreshing=true`；超时/响应丢失/5xx → 需重新登录且**不重试旧令牌**；401 → 清凭据；429 → 保留凭据、记录 `retry-after`、不自动轰炸；证书/连不上（请求未被消费）→ 保留凭据并标记 `cert-error`/`cloud-unreachable`。
5. **退出**：返回 `{ localLoggedOut: true, cloudRevoked: bool }`，云端不可达时**如实区分**。
6. **账户切换**：换 origin / 换设备证书 / 换 CA → 清空旧会话与刷新令牌，不复用队列。
7. **本地接口保护**：沿用全局 Host/Origin 校验 + 本机会话 cookie/`X-Local-Token`（写操作无 token → 403）。

## 4. 验收执行

命令：`node --test tests/cloud-auth.test.mjs`（结果见 `tests-auth.log`）→ **10/10 通过**；全量 `npm test` → **138/138 通过**（`tests-all.log`）。

| 用例 | 覆盖的工单要求 |
|---|---|
| 配置必须 HTTPS、证书文件必须存在 | 适配器配置校验 |
| 登录 → me → 退出；状态与存储不含令牌 | 响应脱敏、加密存储、退出清理 |
| 激活（一次性凭证） | activate 语义 |
| 到期后 5 个并发调用只发 1 次刷新 | single-flight |
| 刷新响应丢失 → needs-login，且不再重试 | 响应丢失、禁止无限重试 |
| 重启可续；上次刷新中断 → 需重新登录 | 崩溃恢复 |
| 401 撤权 → 清凭据停止重试 | 会话撤销 |
| 429 → 保留凭据、暴露 retry-after，恢复后可用 | 限流 |
| 错误 CA / 不受信客户端证书必须失败 | TLS 不得关闭校验 |
| 换设备证书 → 不复用前一账户凭据 | 账户切换 |

**HTTP 层验证**（临时实例 + 临时数据目录，日志见 `http-check.log`）：
- `GET /api/cloud-auth/status` 返回体**无** `accessToken/refreshToken/certPath/caPath/keyPath/p12Path/password`；
- 未配置时登录 → `400 {"code":"config"}`；`http://` 地址 → `400 {"error":"云端地址必须使用 HTTPS"}`；
- 写请求缺 `X-Local-Token` → `403`；
- 服务端日志中 `Bearer|refreshToken|PRIVATE|password` 命中 **0** 行；
- 数据目录只出现 `cloud-auth-state.json`（非敏感），密文在 SQLite 的 `app_secrets`。

## 5. 未通过项 / 未验证项（如实列出）

1. **前端入口未做**（工单第 10 行允许拆分）：当前只有后端与本地 API，没有“设置页里的连接/激活/登录/退出”界面。
   原因：前端窄屏布局正处于 T-LOCAL-002 未修状态（`qa.mjs:338` 390px 溢出），此刻加 UI 会扩大冲突面。
   **建议**：等 T-LOCAL-002 修完，再单独下发“本地设置页云端认证入口”工单（可并入本工单第二阶段）。
2. **未联调正式云端**：按工单要求，不使用 18443 探针、不接触真实账户、不运行云端 CLI；所有验证都跑在一次性证书的 mock 上。
3. **设备列表 / 改密**未接入（工单允许先不做；适配层方法可扩展）。
4. **未跑浏览器 UI 验收**：本轮无 UI 变更。
5. `getState()` 会暴露 `originHost`（仅主机名，不含路径/端口以外的凭据）；如需更严格可去掉。

## 6. 回退方式（#0011 后修正）

**不要**在已有新改动的脏工作区执行 `git checkout/reset`（会覆盖他人工作）。回退按已审补丁反向应用：

```bash
cd /Users/luohongming/Desktop/作业/素材管理器
patch -R -p1 < collab/results/T-LOCAL-CLOUD-001/diff-round2.patch
```

`scripts/qa.mjs` 的 T-LOCAL-001 补丁不受影响，请勿一并回退。第 2 轮修复详见同目录 `report-round2.md`。

## 7. 风险与说明

- `server/cloud-auth.mjs` 在启动时只读配置/状态，不发任何网络请求；未配置云端时行为与之前完全一致。
- 证书/私钥路径只存在于本地配置与会话内存；**从不返回给前端**，也不写入日志。
- mock 是测试夹具，不含任何真实密钥；证书在临时目录生成并在用例结束时删除。
