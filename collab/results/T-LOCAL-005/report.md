# T-LOCAL-005 交付报告：本地云端连接与认证设置入口

日期：2026-10-22 13:35（Asia/Shanghai）
负责人：DeepSeek
状态：本地实现与隔离验收完成；未提交、未推送、未部署、未连接正式云端。

## 1. 基线、范围与文件重叠

- 分支：`main`
- HEAD：`2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`
- 既有 dirty（开工时）：
  - `M scripts/qa.mjs`（T-LOCAL-001 路由匹配补丁，保留未动）
  - `M server/index.mjs`（既有 cloud-auth 路由）
  - `M src/style.css`（既有 T-LOCAL-002 窄屏补丁）
  - `?? collab/`、`?? server/cloud-auth.mjs`、`?? tests/cloud-auth-mock.mjs`、`?? tests/cloud-auth.test.mjs`
- 本轮新增：
  - `src/CloudConnectionSettings.tsx`（新组件）
  - `collab/results/T-LOCAL-005/`（本报告、diff、日志、截图、验收脚本）
- 本轮修改：
  - `src/main.tsx`：设置页挂载组件；`api()` 失败时保留 `code/kind/status/retryAfterMs` 供云认证错误分类。
  - `src/style.css`：只新增 `.cloud-*` 样式块，未改既有 T-LOCAL-002 样式。
- 未改 `scripts/qa.mjs`、`server/cloud-auth.mjs`、`tests/cloud-auth*.mjs`，未改 `拾光云端后台` 任何文件。
- 证据：`baseline.txt`、`final-status.txt`、`qa-patch-unchanged.patch`、`diff.patch`、`git diff --check`。

## 2. 实现内容

1. 在“设置与缓存”弹窗中新增独立“云端连接”区域，不重写导航或前端框架。
2. 复用既有本地 API，未新增云端接口：
   - `GET /api/cloud-auth/status`
   - `POST /api/cloud-auth/config`
   - `POST /api/cloud-auth/activate`
   - `POST /api/cloud-auth/login`
   - `POST /api/cloud-auth/logout`
3. 配置项：HTTPS origin、CA 路径、PEM 证书/私钥路径、P12 路径与 P12 口令。
   - 本机证书路径只写不回显；保存成功后清空路径输入。
   - P12 口令、登录密码、激活码在提交时**立即**离开表单内存，不等待响应；不写 localStorage/sessionStorage、不拼查询串。
   - 状态只显示：`originHost`、是否保存 CA、是否保存设备证书、账户显示名/用户名、会话期限。
4. 明确区分：
   - `未配置` / `已保存，未连接` / `已连接` / `需重新登录` / `限流冷却` / `证书错误` / `云端不可达`。
   - “保存连接配置”与“登录/激活成功”使用不同提示，避免把保存当连接成功。
   - 退出时区分“云端会话已撤销”与“本地已退出，云端撤销未确认”。
5. 错误处理：
   - 复用后端固定公开文案；前端按 `kind/status/code` 映射证书、401、429、离线、未配置等，不显示原始响应、异常栈或路径。
   - 429 显示 `retryAfterMs` 换算后的秒数。
6. 防连点：`lock` ref + `busy` 状态，请求期间所有动作按钮禁用；错误后静默补读状态，保持冷却/登录态真实。
7. 默认不自动登录、不后台轮询、不发请求风暴；原本地素材管理不受影响。
8. 未做角色/小组/上传/标签同步页面，未改云端业务契约。

## 3. 测试与证据

所有测试均使用临时 `MEDIA_DATA_DIR`、`MEDIA_SKIP_IMPORT=1`、合成资料/一次性 mTLS mock；无头、无弹窗、未扫描或移动真实素材。

| 项目 | 结果 | 证据 |
|---|---|---|
| `npm run build`（tsc + vite） | 通过 | `build.log` |
| `npm test` 全量 | 147/147 通过，0 失败/跳过 | `tests-all.log` |
| 认证专项 `node --test tests/cloud-auth.test.mjs` | 19/19 通过 | `tests-auth.log` |
| 现行浏览器验收 `npm run test:browser` | Chromium passed、WebKit passed | `test-browser.log` |
| T-LOCAL-005 隔离 UI 验收 | Chromium PASS、WebKit PASS | `verify.log`、`results.json` |
| `git diff --check` | 通过 | 本报告生成时执行 |

### 3.1 UI 验收覆盖

`verify.mjs` 使用真实本机 HTTPS/mTLS mock（一次性 CA、证书、临时 P12）与两套临时本地服务，逐项断言：

- 未配置：状态、登录/激活禁用、空保存只显示安全配置错误。
- 配置保存：PEM 保存成功；路径输入清空；界面不出现临时目录；状态为“已保存，未连接”。
- 激活：错误激活码 401 → 固定文案；激活码/密码提交即清空；正确凭证激活并登录。
- 刷新页面：只恢复脱敏状态与账户名，不恢复密码/令牌；localStorage/sessionStorage 无密码/令牌。
- 退出：真实 mock 会话撤销，状态回“已保存，未连接”。
- P12：用临时客户端 P12 + 临时口令保存并真实登录；P12 口令输入在保存后为空，界面不回显路径/口令。PEM→P12 时清掉旧 PEM，P12→PEM 时清掉旧 P12，并直接读取临时 `cloud-auth.json` 断言切换结果，配置文件中无口令。
- 登录：错误密码 401；正确密码登录；状态/账户摘要正确。
- 防连点：延迟真实登录响应，期间“登录中…”与保存/退出按钮均禁用；只发出 1 次登录请求。
- 429：`Retry-After`/`retryAfterMs` 映射为“请 2 秒后重试”。
- 证书失败：即使注入含临时路径的原始错误，界面只显示固定证书文案，不出现路径。
- 离线：网络类错误只显示固定“无法连接云端服务”，不出现原始 `ECONNREFUSED` 或地址。
- 本地已退出/云端撤销未确认：单独提示，不误报为已撤销。
- 1280/390/320：表单、错误、加载状态均检查页面与区域无横向溢出、控件在视口内；截图见 `screenshots/`（每浏览器 10 张）。
- 网络与 DOM 脱敏：真实云认证响应、状态接口、页面 DOM 均不含 `accessToken`、`refreshToken`、密码、P12 口令、临时路径或证书路径；URL 不含密码/激活码。

### 3.2 截图

- Chromium/WebKit：`form-1280/390/320`、`error-390/320`、`loading-390`、`logout-unconfirmed-320`、`final-1280/390/320`。
- 未查看：无（已人工抽查 Chromium 1280/390/320、error、loading、logout 与 WebKit 320）。

## 4. 未完成项与限制

- 未连接正式云端、未创建正式账户、未信任正式证书、未运行云端初始化/部署命令。
- 429、证书失败、离线、本地退出远端未确认的 UI 状态使用隔离 mock/受控响应验证；真实后端的 429/证书/网络语义已由既有 `cloud-auth.test.mjs` 与 GPT 的 Java 隔离联调覆盖。这不是生产验收。
- P12 真实往返使用一次性 mock 客户端证书生成的临时 P12；未使用真实设备 P12。
- 自适应只验证到 320px；未验证 320px 以下或移动端软键盘。
- 未做认证 UI 之外的账号/设备管理页、角色/小组/上传/标签同步页面。
- 提交/推送/部署/正式联调均需老板与 GPT 明确授权，本次未执行。

## 5. 回退方式

1. 删除 `src/CloudConnectionSettings.tsx`。
2. 撤销 `src/main.tsx` 的 import、`api()` 错误字段、设置页挂载三处 hunk。
3. 删除 `src/style.css` 的 `.cloud-*` 样式块（约 1988 行起）。
4. `npm run build` 重建 `dist/`。
5. 无数据库迁移、无写入真实配置、无前端持久化状态需要清理；既有 `server/cloud-auth.mjs` 与 `tests/cloud-auth*` 保持原样。

最小产品 diff：`diff.patch`（706 行，含新组件全文；反向 apply 校验通过）。
