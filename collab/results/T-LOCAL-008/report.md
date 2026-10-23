# T-LOCAL-008 交付报告：账户、小组与授权管理工作区

日期：2026-10-22
基线：`main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`（工作区含既有未提交 T-LOCAL-001/002/003/005/006/007 与 CLOUD-001 补丁）
本轮：**未提交、未推送、未部署**；未修改 `拾光云端后台` 任何文件；未连接正式云端、未创建正式账户、未使用真实素材/库；未安装系统信任；未弹窗。

## 交付范围

按 `拾光云端后台/collab/specs/T-LOCAL-008.md`、`docs/MANAGEMENT-API.md` 与既有 AUTH/GROUP/AUTHORIZATION/DEVICE-ENROLLMENT 契约，实现本地 Node 固定白名单适配 + 独立管理工作区：

1. **个人安全**：本人资料、我的设备（标识当前设备、确认撤销）、修改密码（成功清本地会话）。
2. **小组与成员**：我的组/管理模式、创建组（初始组长精确候选）、改名、添加/移除/退出、负责人交接、停用/恢复；`NEEDS_LEADER`/`DISABLED` 明确展示；版本冲突提示重读。
3. **账户管理**：`account:read` 才能进入；分页/搜索/状态过滤；按权限创建 PENDING、一次性开通码显示/撤销、停用/启用、owner 密码重置码（需 owner 本人密码确认）；紧急封禁负责人的二次确认。
4. **角色与授权**：owner 权限目录、角色、影响预览、权限更新（expectedVersion）、创建自定义角色、账户授权查看/授予/撤销；保留身份不参与分配。
5. **审计**：owner 只读分页脱敏摘要。
6. **忘记密码**：独立登录页新增重置入口（重置码 + 新密码），由 Node 以 mTLS、无 Bearer 调 `/auth/reset-password`，成功清旧会话回登录，不自动登录、不重置设备。

## 安全边界实现

- 新增 `server/cloud-management.mjs`：固定方法 + 固定路径模板 + 参数/DTO 白名单；浏览器不能提交 origin、任意路径、HTTP 头或云端 JWT。
- `server/cloud-auth.mjs` 新增受控 `proxy()`（仅供白名单模块）与 `forgetSession()`；沿用原 single-flight 刷新、超时/响应上限/固定文案/代次隔离，没有复制 TLS 栈。
- 401：清本地会话；迟到成功响应在代次变化后丢弃（并发 401/STALE 统一收敛为需重新登录）。403 由前端重读能力；409 原样提示人工重读，不静默覆盖。
- 一次性开通码/重置码只在当前组件内存展示，点击复制才写入剪贴板，不写 localStorage/sessionStorage/URL/普通文件/日志；关闭/切页/离开即清。
- 密码/码提交后立即清空输入；Node 错误边界只回固定公开码。
- DTO 逐字段收敛：账户、设备、小组、成员、角色/授权、审计、候选；响应中云 JWT、刷新令牌、密码哈希、私钥、路径不会进入浏览器。

## 主要文件

新增：
- `server/cloud-management.mjs`
- `src/CloudWorkspace.tsx`
- `tests/cloud-management-mock.mjs`
- `tests/cloud-management.test.mjs`
- `collab/results/T-LOCAL-008/verify-ui.mjs`

修改：
- `server/cloud-auth.mjs`（proxy / forgetSession）
- `server/index.mjs`（`/api/cloud-management/*` 固定路由与错误边界）
- `src/cloud-auth.ts`（resetPassword、启动时本地会话竞态重试一次、错误文案）
- `src/CloudAccount.tsx`（账户菜单入口、忘记密码重置表单）
- `src/main.tsx`（`#/account` 工作区路由；无 body 的 DELETE 也携带本机会话令牌）
- `src/style.css`（工作区样式，桌面/13 寸/390/320 响应式）

既有 T-LOCAL-007 及更早补丁原样保留；`scripts/qa.mjs` 的 T-LOCAL-001 路由补丁未触碰。

## 证据（均在本目录）

- `baseline.txt`：branch/HEAD/dirty/拟改文件。
- `diff.patch`：当前工作区相对 HEAD 的完整未提交增量（含保留的 007 补丁；008 新增段见上述文件）。
- `tests-management.log`：`node --test tests/cloud-management.test.mjs` **18/18 通过**，0 失败/跳过。
- `tests-all.log`：`npm test` **187/187 通过**，0 失败/跳过。
- `build.log`：`npm run build` 退出 0（tsc --noEmit + vite build）。
- `diff-check.log`：`git diff --check` 退出 0。
- `test-ui.log`、`ui-results.json`：无头 UI 四条流程全部 PASS、0 pageerror、0 console 失败：
  - `chromium-owner`（Chrome）：owner 全流程实际点击——撤销备用设备、管理模式、改名、409 版本冲突后重读、添加成员、交接负责人、账户搜索、签发开通码、签发重置码、创建待激活账户、角色影响预览/更新权限/创建自定义角色、审计；71 次本地管理请求。
  - `webkit-owner`（WebKit）：owner 全流程 + 撤销云端会话后的 401 退回登录 + 登录页“忘记密码”表单与固定错误、输入清空；19 次本地管理请求。
  - `chromium-admin`：仅个人安全/小组/账户页签；页签不渲染不是安全边界，直接调用 `/api/cloud-management/accounts` 仍被云端 403。
  - `chromium-leader`：仅个人安全/小组；直接调用账户/角色接口 403。
- `screenshots/`：17 张，1280/390/320 三种宽度，均检查页面横向溢出 ≤1px；覆盖个人安全、小组、账户（含一次性码）、角色、审计、登录页重置。
- 复现：`node collab/results/T-LOCAL-008/verify-ui.mjs`（一次性 CA/证书、随机端口、临时 `MEDIA_DATA_DIR`、合成 WAV）。

## 已知边界 / 待办

- T-CLOUD-006 的 Java 实现由 GPT 本轮并行进行，本目录的账户分页/候选/成员资料/授权列表/审计/密码重置按 `MANAGEMENT-API.md` 固定契约用隔离 mock 验证；**实际 Java↔Node 管理联调尚未执行**，等 GPT 提供隔离入口后验收。未宣称线上就绪。
- 未做：MFA、第二个 owner、组物理删除、内容共享/标签/项目同步、公开注册、正式证书续期；均不在本工单。
- Node 适配不缓存云端账户清单；写请求不自动重试；超时后要求重读现状（界面提供刷新，非自动重放）。
- 冻结的 `diff.patch` 是当前工作区增量，包含历史未提交补丁；评审应以实际文件 + 本报告“主要文件”为准。
