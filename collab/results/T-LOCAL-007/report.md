# T-LOCAL-007 交付报告（本机自动设备开通 v1）

- 日期：2026-10-22
- 基线：`main` / `2c15663 Import DaVinci Resolve timelines and track per-asset usage`
- 工作区：有既有未提交改动（见下），本轮全部保留；`scripts/qa.mjs` 的 T-LOCAL-001 路由补丁未触碰。
- 边界：未提交、未推送、未部署；未连接正式云端/旧 18443 探针；未创建正式账户；未修改 `拾光云端后台`；未使用真实素材/库/系统信任；未弹窗。

## 1. 本轮实现

### 1.1 内置发行配置（仅公共信息）

- `server/cloud-release-config.mjs`
  - `schemaVersion=1`、`enabled`、`apiOrigin`、`enrollmentOrigin`、`serverCaPem`、`deviceCaPem`。
  - origin 只允许 `https://host[:port]`，拒绝用户信息/路径/查询/hash。
  - CA 只解析 PEM CERTIFICATE，任何 `PRIVATE KEY` 直接拒绝；启用时要求包含 CA 证书。
  - 配置损坏/缺失时安全地保持“未就绪”，不回退到假地址，不崩溃。
- `config/cloud-release.json`：原始仓库默认 `enabled=false`、地址/CA 为空。
- `config/README.md`：字段说明与生成命令。
- `scripts/cloud-release-config.mjs`：只读操作者显式给出的两个 origin 与两个公开 CA 文件；支持 `--check`；输出 0644、拒绝私钥；不扫描 `.runtime`/home 猜证书。

### 1.2 本机开通后端

- `server/device-enrollment.mjs`
  - 独立 RSA-3072（e=65537），Node 内置 `crypto` 生成；SPKI 公钥、SPKI DER SHA-256、`RSA/SHA-256 PKCS#1 v1.5` 持钥签名；末尾无换行，字符串与 `docs/DEVICE-ENROLLMENT-API.md` v1 一致。
  - 设备目录 `0700`，私钥 `0600`，证书/公开 CA `0644`；原子写 + fsync + rename。
  - `pending-enrollment.json` 只存开通码 SHA-256、设备名、公钥哈希；不存明文码；成功后删除。
  - 原码 + 同设备名重试复用原私钥；原钥丢失返回 `DEVICE_KEY_LOST`；已激活设备拒绝重复开通。
  - 兑换：只信任发行 `serverCaPem`，校验证书与主机名，`rejectUnauthorized=true`，不跟重定向，明确 `Content-Length`，请求 ≤16KiB、响应 ≤128KiB，绝对超时；不带 Bearer/客户端证书。
  - 返回证书验证：匹配本机私钥/SPKI、有效期（≤90 天，允许 5 分钟签发端时钟偏差）、非 CA、仅 `clientAuth`、逐级签名并锚定预置 `deviceCaPem`；任何异常都在落盘前拒绝。
  - 未知/异常响应不覆盖已正常使用的设备；`single-flight`；兑换与安装前核对 `CloudAuth.epoch`，退出/切换账户后的迟到响应不会复活会话。
  - `needsActivation=true` 用新证书走原 `/auth/activate`；`false` 用返回用户名 + 输入密码走原 `/auth/login`，不重置密码。激活失败保留 pending 记录以便原码原钥重试。
- `server/index.mjs`
  - 新增 `POST /api/cloud-auth/enroll`，`GET /api/cloud-auth/status` 增加脱敏 `enrollment` 状态。
  - 登录/激活/退出路由先取消进行中的兑换。
  - 支持 `SHIGUANG_CLOUD_RELEASE_CONFIG` 覆盖配置路径（隔离验收用）。
- `server/cloud-auth.mjs`
  - 增加开通固定错误码/文案；错误边界允许 403/409/413/503，仍不透传云端原文/路径/密钥。

### 1.3 用户入口

- `src/cloud-auth.ts`：`enroll()` 动作、`EnrollmentStatus`、固定错误文案、epoch 语义沿用。
- `src/CloudAccount.tsx`：独立登录页保留用户名/密码；首次无证书时自动进入“开通本机”，只需开通码 + 账户密码 + 可选设备名；提交即清空密码/开通码；失败固定文案；成功后自动回主界面。高级设置保留。

### 1.4 分享白名单

- `scripts/package.mjs`：加入 `config/cloud-release.json`、`config/README.md`、`scripts/cloud-release-config.mjs`；显式排除 `config/` 下其它文件、设备目录/待开通记录，并扫描内容拒绝 PRIVATE KEY。

## 2. 可执行证据

| 证据 | 路径 | 结果 |
| --- | --- | --- |
| 源码 diff | `collab/results/T-LOCAL-007/diff.patch` | 含本轮新文件与既有补丁，未含截图 |
| 构建 | `collab/results/T-LOCAL-007/build.log` | `tsc --noEmit && vite build` 退出 0 |
| 专项测试 | `collab/results/T-LOCAL-007/tests-enroll.log` | 11/11 通过 |
| 全量测试 | `collab/results/T-LOCAL-007/tests-all.log` | 158/158 通过 |
| UI 验收 | `collab/results/T-LOCAL-007/test-ui.log`、`ui-results.json` | Chromium/WebKit 均 passed，无 pageerror |
| 截图 | `collab/results/T-LOCAL-007/screenshots/` | 22 张：开通页/主界面/账户菜单/登录页 × 1280/390/320 × 2 浏览器 |
| 分享白名单检查 | `collab/results/T-LOCAL-007/package-check.log` | 158 个分享文件，含 3 个新配置/脚本，0 私钥、0 设备目录 |
| 复现脚本 | `collab/results/T-LOCAL-007/verify-ui.mjs` | 真实本地服务 + 一次性 HTTPS/mTLS mock + 临时库/合成 WAV |

测试覆盖：首次 PENDING 开通→激活→登录、已激活账户登录不重置密码、响应丢失同码原钥恢复、换钥匙 401、错误 429/503/401、错 CA/主机名、重定向、超大/半响应、超时、single-flight、退出后迟到响应、目录不可写、证书过期、错误 device CA。真实持钥签名与 TLS 链验证，未 stub 签名/未跳过 TLS 校验。

## 3. 未完成 / 需 GPT 或老板决定

1. 正式发行配置：两个正式 HTTPS origin 与公开 CA 尚未提供，仓库保持 `enabled=false`；未宣称“开箱可用”。
2. 实际 Java ↔ Node 隔离联调：需 GPT 提供一次性隔离入口；本轮只用 Node mock，未连 112.74.109.173/18443。
3. 生产部署/正式 CA/公共信任安装/证书续期不在本轮范围。
4. 未执行完整 `npm run package`（避免在仓库 `releases/` 生成产物）；已按 allowlist 收集检查。若需端到端打包验收，可另在临时副本执行。
5. 时间偏差策略：允许签发端 5 分钟 notBefore 偏差（避免慢机器上刚签发证书被误判过期）；过期仍严格按本机时间。请 GPT 复核是否接受。

## 4. 回退方式

- 代码回退：删除/还原本轮文件（`server/device-enrollment.mjs`、`server/cloud-release-config.mjs`、`scripts/cloud-release-config.mjs`、`config/*`、两个新测试文件；还原 `server/index.mjs`、`server/cloud-auth.mjs`、`src/cloud-auth.ts`、`src/CloudAccount.tsx`、`scripts/package.mjs`）。
- 运行时：删除本机数据目录下 `cloud-device/` 与 `cloud-auth.json` 即清除设备材料/连接配置；不删除设备不会影响本地素材功能。
- `dist/` 为生成物，重新 `npm run build` 即可。
