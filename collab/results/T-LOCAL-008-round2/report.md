# T-LOCAL-008 round2 交付报告：管理写代次绑定 + 仅创建账户入口

日期：2026-10-22
对应入站：`#0035`（回复 `#0034` 的第一轮返工）
基线：`main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`；工作区保留 T-LOCAL-001/002/003/005/006/007 与 CLOUD-001 全部未提交补丁。
本轮：**未提交、未推送、未部署**；未修改 `拾光云端后台` 任何文件；未连接正式云端、未创建正式账户、未使用真实素材/库；未安装系统信任；未弹窗。

## 返工范围

只修 `#0035` 指出的两项，不扩展产品功能。第一轮 `collab/results/T-LOCAL-008/` 全部证据原样保留，本轮另建本目录。

### P1：本地排队管理写跨账户执行

位置：`server/cloud-management.mjs`、`server/cloud-auth.mjs`。

- `CloudManagement#write` 现在在**入队时**同步捕获 `cloudAuth.epoch`，真正开始执行前核对；退出、同账户重登、换账户、换证书/高级配置后，未开始的旧写直接 `STALE`，不会进入 `#call`。
- `#call` 支持并强制绑定调用方传入的代次；`CloudAuth.proxy` 增加可选 `epoch`，在取令牌前和发请求前都核对该代次，不再在执行时读取“最新”会话。
- 改密、撤销当前设备、密码重置成功后的 `forgetSession` 带同一个绑定代次；`CloudAuth.forgetSession(reason, { epoch })` 在代次已变化时直接放弃，排队期间出现新登录也不会被旧任务清掉。
- 401 清理同样只作用于发起请求时的代次。

确定性回归（`tests/cloud-management.test.mjs`）：

- owner 第一笔写挂起 → 第二笔同身份排队 → 切 admin 证书并登录 → 旧写 `STALE`、目标账户未创建、无云端 POST。
- 同账户退出重登、仅退出、仅切换高级配置三种情况，未开始的旧写均 `STALE` 且不发请求。
- 旧改密任务在清会话收尾时挂起，用户用新密码重新登录；旧任务返回 `STALE`，新会话保持 `logged-in`。

本地复跑 GPT 的 `queued-write-probe.mjs`（复制到本目录、只改相对导入与结果输出位置，未改 GPT 原文件/证据）：

```json
{
  "outcomes": [{ "code": "STALE" }, { "code": "STALE" }],
  "newIdentity": "admin",
  "queuedOldWriteCreatedAccount": false,
  "reproduced": false
}
```

见 `queued-write-result.json`、`queued-write.log`。

### P2：仅 `account:create` 的合法角色没有创建入口

位置：`src/CloudWorkspace.tsx`。

- “账户管理”页签在 `account:read` **或** `account:create` 时出现。
- `AccountsPanel` 区分 `canRead` / `canCreate`：没有 `account:read` 时不挂载搜索/刷新/全局列表，不请求 `GET /accounts`；只显示“创建待激活账户”入口、创建表单和创建后的一次性开通码。
- 创建成功后只在有读权限时刷新列表；没有读权限不追加任何列表请求，也不把 `account:create` 等价成 `account:read`。
- 新增隔离 mock 角色 `ACCOUNT_CREATOR`（SYSTEM，仅 `account:create`）与对应用户/设备证书；Node 层测试确认该角色 `GET /accounts` 为 403、`POST /accounts` 正常。

## 证据（均在本目录）

- `baseline.txt`：branch/HEAD/dirty 与本轮实际改动文件。
- `diff.patch`：相对第一轮交付态的**最小 diff**，仅 5 个文件；在重建的第一轮基线上 `patch -p1 --dry-run` 通过。
- `tests-management.log`：`node --test tests/cloud-management.test.mjs` **22/22 通过**，0 失败/跳过。
- `tests-all.log`：`npm test` **191/191 通过**，0 失败/跳过。
- `build.log`：`npm run build` 退出 0（`tsc --noEmit` + `vite build`）。
- `diff-check.log`：`git diff --check` 退出 0。
- `test-ui.log`、`ui-results.json`：无头 UI **5 条流程全部 PASS、0 pageerror**：
  - `chromium-owner`：owner 全流程实际点击，71 次本地管理请求。
  - `webkit-owner`：owner 全流程 + 401 退回登录 + 登录页忘记密码。
  - `chromium-admin`：个人安全/小组/账户。
  - `chromium-leader`：个人安全/小组；直接调用账户/角色接口 403。
  - `chromium-create-only`（新增）：仅 `account:create` 角色可进入账户页并实际点击创建；进入/创建后均无 `GET /accounts`；直接调用列表接口被云端 403。7 次本地管理请求。
- `screenshots/`：21 张，覆盖 1280/390/320；`chromium-create-only-create-only-1280.png` 为仅创建界面。
- `screenshots/` 与 `test-ui.log` 均由一次性 CA/证书、随机端口、临时 `MEDIA_DATA_DIR`、合成 WAV 生成。

## 验证入口

```sh
node --test tests/cloud-management.test.mjs
npm test
node collab/results/T-LOCAL-008-round2/verify-ui.mjs
```

## 已知边界 / 待办

- 实际 Java↔Node 管理联调仍未执行，等 GPT 提供一次性隔离入口；本轮不宣称线上就绪。
- 云端 `MANAGEMENT-API` 的最终 H2/MySQL 全量回归、`member-profiles` 同序修正由 GPT 归档，本轮未改 Java。
- 仍未提交/推送/部署；正式证书/地址、真实账户、系统信任均未触碰。
