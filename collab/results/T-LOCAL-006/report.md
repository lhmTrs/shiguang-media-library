# T-LOCAL-006 交付报告：顶部账户入口与独立登录页

## 1. 现场信息

- 工程：`/Users/luohongming/Desktop/作业/素材管理器`
- 分支：`main`
- HEAD：`2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`（未变）
- 开工 dirty 与交付 dirty 一致，未新增提交：
  - `M scripts/qa.mjs`（仅 T-LOCAL-001 的 `assets|asset-series` 路由补丁 + T-LOCAL-003 单行标题断言）
  - `M server/index.mjs`（既有 cloud-auth 路由）
  - `M src/main.tsx`、`M src/style.css`（既有 002/005 补丁 + 本轮 006）
  - `?? collab/`、`?? server/cloud-auth.mjs`、`?? tests/cloud-auth*.mjs`、`?? src/CloudConnectionSettings.tsx`（005 交付）
  - 本轮新增：`src/cloud-auth.ts`、`src/CloudAccount.tsx`
- 运行时：macOS 15.7.3 / Node v22.7.0 / npm 10.8.2
- 本轮未改 `scripts/qa.mjs`；开工与交付 sha256 均为 `0bbb5f0702ef2811262235c342a0c9f5a5662fe0f06368e7fd86bd743a56a97b`。
- 未修改 `/Users/luohongming/Desktop/作业/拾光云端后台` 任何文件；未提交、未推送、未部署。

## 2. 实现范围

### 2.1 顶部账户入口

- 放在顶栏最右侧，避免在 320/390 挤压导航、项目选择和“添加素材目录”。
- 未登录：图标 + “登录”，可访问名称 `登录`。
- 已登录：显示显示名/用户名，打开账户菜单显示账户与状态，提供“退出登录”。
- 退出后立即更新入口；云端已撤销与“本地已退出、云端撤销未确认”使用不同提示。
- 移动端隐藏文字但保留 `aria-label`；菜单在 320px 内完整可见。

### 2.2 独立登录页

- `#/login` hash 路由，无新增路由库；`history.pushState` / `hashchange` / `popstate` 兼容直达、刷新、后退。
- 登录页与主界面互斥渲染；进入登录页不重置 `view/search/page/root/category` 等 App 状态。
- 成功后回到进入前的主视图，搜索词与页码保留；失败停留登录页。
- 已有有效会话时直达 `#/login` 自动返回主界面，避免循环。
- 密码提交即清空，用户名保留；请求中表单与按钮禁用，防止连点。
- 普通登录页只显示用户名、密码、登录、加载、错误、返回；不展示 CA、私钥、P12 路径或 P12 口令。
- 激活是登录页内的独立次级表单，与普通登录互斥；激活成功自动回主界面。
- 未配置时显示“云端服务尚未就绪”，登录按钮禁用，不引导普通用户填写证书路径。

### 2.3 高级云端设置

- “设置与缓存”中的云端区域改为默认折叠的“高级云端设置（诊断 / 配置）”。
- 保留连接配置（origin、CA、PEM/P12、P12 口令）与脱敏状态摘要。
- 移除原来的登录、激活、退出表单，避免两套重复登录入口；登录/激活/退出统一走顶部入口与登录页。
- 保存配置后通知共享认证状态刷新，登录页无需刷新页面即可识别已配置。

### 2.4 共享认证状态与迟到响应

新增 `src/cloud-auth.ts`：

- 统一 `CloudAuthView` / `LogoutResult` / 错误固定文案。
- 所有状态查询和登录/激活/退出动作带递增代次（epoch）。
- 退出、换账户、离开登录页时使旧代次失效；迟到的旧状态响应不能覆盖较新的登录/退出结果。
- 动作串行；动作失败后只在锁释放后补读一次真实状态。
- 错误文案对 401、429、证书、网络、超时、未配置、非 JSON/未知错误全部固定；未知错误不读取 `message`、不回显路径或异常栈。

## 3. 实际执行的验证

所有测试均使用临时 `MEDIA_DATA_DIR`、一次性 mTLS mock、合成 WAV；无头 Chromium/WebKit；未使用真实账户、真实库或真实素材；未弹窗。

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run build` | 退出 0（tsc + vite） | `build.log` |
| `npm test` | **147/147 通过**，0 失败/跳过 | `tests-all.log` |
| `node --test tests/cloud-auth.test.mjs` | **19/19 通过**，0 失败/跳过 | `tests-auth.log` |
| `npm run test:browser` | Chromium/WebKit 均 `passed:true`，各 11 项 | `test-browser.log` |
| `node collab/results/T-LOCAL-006/verify.mjs` | **PASS chrome / PASS webkit**，0 错误 | `verify.log`、`results.json` |
| `git diff --check` | 退出 0 | 本报告 |

### 3.1 006 隔离验收覆盖（verify.mjs）

- 未配置：顶部入口 → 独立登录页 → “云端服务尚未就绪”、登录禁用、无证书字段 → 返回后本地浏览状态仍在。
- 高级设置配置 PEM（真实一次性 mTLS）→ 登录页启用。
- 浏览器后退回主视图；刷新登录页仍停留；`#/login` 直达后“返回素材库”正常。
- 401 错误密码：停留登录页、密码清空、用户名保留。
- 429：固定“请求过于频繁，请 2 秒后重试”。
- 证书文件丢失：固定文案，不含临时目录。
- 网络拒绝：固定文案，不含 `127.0.0.1`。
- 非 JSON 500（HTML 含路径）：固定“云端认证操作失败，请稍后重试”，不含路径/原始异常。
- 防连点：延迟真实登录响应，期间只发出 1 次请求，用户名/密码/按钮禁用。
- 成功登录：回到主视图，`tone` 搜索词与第 2 页均保留；顶部显示“账户：爱丽丝”。
- 登录后刷新：只从后端恢复脱敏账户状态。
- 已有会话直达 `#/login`：自动回主界面，无循环。
- 正常退出：提示“已退出，云端会话已撤销”，顶部恢复“登录”。
- 迟到状态：菜单打开时挂起旧“已登录”状态，退出完成后再放行；入口仍保持“登录”，菜单不重开。
- 激活：切换客户端 B，登录页次级入口 → 独立激活表单；错误凭证 401 固定文案且清空；正确激活后回主界面，顶部显示“卡罗尔”。
- 1280/390/320：登录页、加载态、账户菜单、顶栏截图；检查文档无横向溢出、控件边界、顶栏按钮中心 `elementFromPoint` 可点击。
- 脱敏：真实认证响应、status 接口、DOM、`localStorage`/`sessionStorage` 均不含密码、访问/刷新令牌、证书路径或 P12 口令；URL 不含用户名/密码/激活码。

截图：`screenshots/`，Chromium 与 WebKit 各 7 张：
`*-login-1280/390/320.png`、`*-login-loading-390.png`、`*-main-logged-in-1280.png`、`*-account-menu-390/320.png`。

## 4. 与 T-LOCAL-005 的关系

- 005 的认证适配、SecretStore、刷新/错误边界、单飞与测试证据全部原样保留，未覆盖 `collab/results/T-LOCAL-005/`。
- 005 的“设置内登录/激活”布局已被 006 替代；005 的 `verify.mjs` 使用旧设置页定位，**不再作为当前入口的验收脚本运行**，其历史证据保留。
- 006 的 `verify.mjs` 继承 005 的安全覆盖（401/429/证书/离线/未知/防连点/凭据不回显/迟到状态/多宽度），并按新入口重写定位，未弱化断言。

## 5. 未完成 / 明确边界

1. **产品打包的内置云端地址、公有 CA 与自动设备登记尚未提供**；当前未配置时只显示“云端服务尚未就绪”，没有伪造已部署服务，也没有硬编码旧 18443 探针或共用私钥。
2. 未接正式云端、未创建正式账户、未信任正式证书、未运行云端 CLI、未做真实 Java/Node 联调。
3. 小组/角色/上传/标签同步页面未做，也不在本工单范围。
4. 未提交、未推送、未部署；`scripts/qa.mjs` 的 T-LOCAL-001 补丁与 002/003/005 改动均未动。
5. 旧 `scripts/qa.mjs` 426 行之后的历史用例仍未执行/未判通过；本轮不改变该结论。

## 6. 最小 diff 与回退

- 006 相对 005 交付态的最小 diff：`collab/results/T-LOCAL-006/diff.patch`
  - `src/main.tsx`：58+/3-
  - `src/style.css`：199+/1-
  - `src/CloudConnectionSettings.tsx`：60+/330-
  - `src/cloud-auth.ts`：251+（新增）
  - `src/CloudAccount.tsx`：379+（新增）
- 校验：在“HEAD + T-LOCAL-005 diff”的临时基线上 `patch -p1 --dry-run` 全部通过；`git diff --check` 通过。
- 回退：反向应用 `diff.patch` 即可恢复到 005 交付态；不涉及数据迁移、数据库结构或真实文件。
