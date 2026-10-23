# T-LOCAL-007 第二轮返工报告（两项 P1 + 一项 P2）

- 日期：2026-10-22
- 基线：`main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`
- 对应：GPT `#0028` / `collab/reviews/T-LOCAL-007/review.md`
- 第一轮证据：`collab/results/T-LOCAL-007/` **原样保留，未覆盖**；本轮全部证据在 `collab/results/T-LOCAL-007-round2/`。
- 工作区：保留 007 第一轮及更早的全部未提交改动；本轮只改 4 个文件（`server/cloud-auth.mjs`、`server/device-enrollment.mjs`、`server/index.mjs`、`tests/device-enrollment.test.mjs`）。`scripts/qa.mjs` 的 T-LOCAL-001 路由补丁未触碰。
- 边界：未提交、未推送、未部署；未连接正式云端/旧 18443 探针；未创建正式账户；未修改 `拾光云端后台` 任何文件；未使用真实素材/库/系统信任；未弹窗。UI 验收使用临时 `MEDIA_DATA_DIR`、合成 WAV 与一次性 HTTPS/mTLS mock。

## 1. 对照 review 的修复

### P1：configure 返回后的取消隔离

**修复**
- `server/cloud-auth.mjs` 新增组合操作身份：`beginOperation` / `endOperation` / `abortOperation` / `#assertOperation`（约 183–212 行）。
- 外部 `configure`、`activate`、`login`、`logout` 会撤销当前 operation；开通内部调用通过 `{ operation }` 传入同一身份，因此内部 `epoch` 变化不会误伤自己。
- `configure`、`#configure`、`#activate`、`#login`、`#applySession`、`#refreshProfile` 在关键 await 前后核对 operation；`cancel()` 通过 `abortOperation` 撤销身份并中止进行中的认证请求。
- `server/device-enrollment.mjs`：`enroll` 创建 operation；`#runEnroll` 在兑换后、安装后、configure 返回后、激活/登录返回后、最终元数据构造后与落盘后都调用 `#assertActive`；登录/激活失败只有在身份仍有效时才作为 `sessionError` 提交，否则一律 `STALE`。
- `server/index.mjs` 的 `/api/cloud-auth/config` 先 `deviceEnrollment.cancel()`，高级配置切换也会使旧开通失效。

**确定性测试**（无 sleep）
- `configure` 返回后 gate：cancel + logout 后放行，旧开通必须 `STALE`，最终 `logged-out`，元数据不得变成 activated。
- gate 期间切换到另一份高级配置：旧开通不得写登录态，新配置保留。
- 登录返回后 gate：cancel + logout 后放行，不得提交成功元数据。
- 最终元数据提交窗口：通过注入时钟在第 3 次 clock 调用（最终 metadata 构造）同步 cancel + logout，`activated=true` 不得落盘。

### P1：未激活时改设备名/换码覆盖唯一恢复密钥

**修复**（`server/device-enrollment.mjs` `#ensurePendingKey`，约 558 行起）
- 先确保设备目录存在，再读 journal；journal 解析失败、schema/字段不合法一律 `DEVICE_PENDING_INVALID`，不生成新钥匙。
- journal 存在但与本次 `codeHash` / `deviceName` 不一致：`DEVICE_PENDING_IDENTITY_MISMATCH`（409），在生成密钥前拒绝，key/cert/config/journal 全不改动。
- journal 存在且身份一致：只从原 `device-key.pem` 恢复；缺失或公钥哈希不匹配一律 `DEVICE_KEY_LOST`，不覆盖。
- journal 缺失但已存在 key/cert/metadata：说明上次写到一半或记录损坏，`DEVICE_PENDING_INVALID` fail closed，保留原文件，不自动删除/覆盖。
- 不新增任何自动清理旧记录的路径；成功后才删除 pending。

**确定性测试**
- 首次用短密码得到 `activationPending=true`；改设备名、换开通码均被 409 拒绝，失败前后 key/cert/config/pending 字节内容完全一致；原码原名重试成功且兑换请求数仍为 2。
- pending 写成非法 JSON、以及删除 pending 但保留 key，都 fail closed，key/cert/config 不变；人工恢复原 journal 后原码原名仍成功。
- 真实子进程重启：父进程留下 pending 身份后，子进程重新打开同一 `MEDIA_DATA_DIR`，用原码原名完成激活；私钥字节不变，pending 删除，metadata activated=true。

### P2：逐级签名不等于完整证书链验证

**修复**（`server/device-enrollment.mjs` 约 259–345 行）
- 新增最小 DER 读取，仅用于读取 `basicConstraints` 与 `keyUsage` 扩展（Node `X509Certificate` 不暴露 pathLen/keyUsage）。
- `verifyEnrolledCertificate` 现在检查：
  - 叶子：私钥/SPKI 匹配、非 CA、`clientAuth` 且无 `serverAuth`、keyUsage（若存在）含 digitalSignature、有效期严格 ≤90 天（不再 +1 天）；5 分钟仅作为 notBefore 签发端时钟偏差。
  - 路径顺序与逐级签名；重复证书拒绝。
  - 链上每张中间证书的有效期、`basicConstraints CA:TRUE`、keyUsage 的 keyCertSign（若扩展存在）、pathLen（按非 self-issued 的 CA 数计算）。
  - 预置 `deviceCaPem` 作为信任锚；锚不在返回链时也校验其 CA/keyCertSign/pathLen 约束。
- 不关闭 TLS 校验、不安装系统信任、不调用系统 `openssl verify`（验证逻辑自包含）。

**测试**
- 有效根（pathlen:1）→ 中间（CA:TRUE）→ clientAuth 叶子：通过；返回链带根也通过。
- 过期中间 CA：拒绝 `CERT_EXPIRED`（同一夹具 openssl verify 也拒绝）。
- 中间 CA:FALSE、缺 keyCertSign、pathLen 超限、叶子 serverAuth、叶子 91 天、错误信任锚：均拒绝。
- 叶子与私钥不匹配：`CERT_KEY_MISMATCH`。

## 2. 可执行证据

| 证据 | 路径 | 结果 |
| --- | --- | --- |
| 本轮最小 diff | `collab/results/T-LOCAL-007-round2/diff.patch` | 仅 4 个文件；在“HEAD + 第一轮 diff”重建树上 `patch -p1 --dry-run` 通过 |
| 全量测试 | `collab/results/T-LOCAL-007-round2/tests-all.log` | **166/166**，0 失败/跳过，退出 0 |
| 开通专项 | `collab/results/T-LOCAL-007-round2/tests-enroll.log` | **19/19**，0 失败/跳过，退出 0 |
| 认证回归 | `collab/results/T-LOCAL-007-round2/tests-auth.log` | **19/19**，0 失败/跳过，退出 0 |
| 构建 | `collab/results/T-LOCAL-007-round2/build.log` | `tsc --noEmit && vite build` 退出 0 |
| 无头 UI | `collab/results/T-LOCAL-007-round2/test-ui.log`、`ui-results.json`、`screenshots/` | Chromium/WebKit 均 `passed:true`，0 pageerror，各 11 张（共 22 张） |
| GPT 反例脚本 | `collab/results/T-LOCAL-007-round2/gpt-reproduce.log` | 三项 `reproduced:false`；脚本退出 1 表示缺陷未复现，不是验收通过 |
| 工作区状态 | `collab/results/T-LOCAL-007-round2/status.txt` | HEAD/脏文件清单；`git diff --check` 通过 |

复现命令：

```bash
cd /Users/luohongming/Desktop/作业/素材管理器
npm run build
npm test
node --test tests/device-enrollment.test.mjs
node --test tests/cloud-auth.test.mjs
node collab/results/T-LOCAL-007-round2/verify-ui.mjs
cd /Users/luohongming/Desktop/作业/拾光云端后台
node collab/reviews/T-LOCAL-007/reproduce.mjs   # 期望退出 1：三个缺陷均未复现
```

## 3. 未做 / 仍需 GPT 或老板

1. 未提交、未推送、未部署；提交/正式联调仍需老板明确授权。
2. 正式 `apiOrigin`/`enrollmentOrigin` 与两张公开 CA 仍未签发；仓库配置保持 `enabled=false`/空值，不伪造正式服务已就绪。
3. 真实 Java ↔ Node 一次性隔离联调仍等 GPT 在返工通过后提供入口；本轮只使用 Node 一次性 mock，不访问线上服务器。
4. 按 #0028 的答复：5 分钟 notBefore 安装预检容差保留；Node 真实 TLS 不放宽；证书有效期按 90 天严格校验，不再额外放宽 1 天。
5. 文件开头私钥注释已改为“绝不发送云端或浏览器”；实际实现仍不把私钥发送给云端或浏览器。
6. 未重跑旧 `qa.mjs` 426 行以后历史用例；既有 T-LOCAL-001/002/003/005/006、CLOUD-001 补丁原样保留。
