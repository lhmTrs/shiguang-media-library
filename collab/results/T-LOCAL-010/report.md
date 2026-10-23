# T-LOCAL-010 云端账户管理界面改版 — 交付报告

- 工单：`拾光云端后台/collab/specs/T-LOCAL-010.md`（只读）
- 实施时间：2026-10-22 21:57–22:10（本机时区）
- 本地工程基线：`素材管理器` HEAD `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`；工作区原有未提交改动全部保留
- 结论：角色与授权、账户管理、小组与成员、个人安全、审计已统一为紧凑管理工作台；构建与定向无头 UI 验收通过，未提交/推送/部署，未连接正式云端或真实库

## 改动文件

| 文件 | 变化 |
| --- | --- |
| `src/CloudWorkspace.tsx` | 重排五个管理页的标题工具栏、主从布局、信息行与空状态；角色页新增“角色权限 / 账户授权”子视图、权限语义分组、保存/撤销、账户授权搜索与明细；只改展示与前端交互，不改接口、鉴权、能力判断和一次性码语义 |
| `src/style.css` | 重写 `.cw-*` 命名空间样式：紧凑间距、细分隔线、统一行高与控件尺寸、浅/深主题 token、1280/390 响应式；不改主题生成文件 |
| `collab/results/T-LOCAL-010/**` | 本报告、`diff.patch`、改版前后截图、`verify-ui.mjs`、`before-capture.mjs`、构建/交互/补丁日志、`ui-results.json` |

`diff.patch` 只含上述 2 个源码文件和 `verify-ui.mjs`，共 3068 行（+2003 / −811）。为得到 T10 的“最小 diff”，先用 HEAD + 既有 T-LOCAL-008 / round2 补丁重建改版前基线（`CloudWorkspace.tsx` 2211 行、`style.css` 4314 行），再与当前文件比较；`patch -p1` dry-run 与实际应用均退出 0，重建文件与当前文件 `diff` 为 0。

## 设计与实现

- **统一工作台层级**：每个主区域使用“页标题 + 一句摘要 + 右侧操作”的紧凑工具栏，页签下直接进入内容；主区域用单一边框工作台和细分隔线，不再把页面切成浮动大卡片。
- **角色与授权**：适度宽左侧角色列表 + 右侧权限详情；权限按现有 code 前缀语义分为账户/小组/媒体/角色/审计/系统组，保留 `scopeType`、`builtIn`、`customAssignable` 过滤与保留身份规则；保存前显示版本和受影响授权，新增“撤销更改”，版本冲突仍提示重读且不自动覆盖。
- **账户授权**：独立子视图，进入后按空条件读取一次；搜索框与按钮对齐，左侧账户结果、右侧当前授权与新增授权；未选账户、无匹配、无授权均有简短空状态；保留一次性码、危险操作确认与 GROUP 角色必须选小组的校验。
- **账户/小组/审计**：统一信息行密度、状态标记、右侧操作列与分页位置；搜索栏、状态筛选、创建入口按页标题工具栏对齐。
- **个人安全**：本人资料与设备在同一主面板按分隔线排列，改密表单收窄到侧栏；撤销设备仍二次确认。
- **主题与可访问性**：颜色改用既有 `var(--c-...)` token（原来的 `#fff`、`#fdecec` 等硬编码已移除），浅色/深色均可用；交互控件保留原生 button/input/select、焦点样式和键盘操作，图标按钮补 `title` 与可访问名称。
- **响应式**：`1280×800` 下主从两栏可用；`390×844` 下主从纵排、筛选/表单单列、长文本换行；页面与面板横向溢出实测均为 0。

## 行为不回归

- 未改 `server/`、云端工程、发行 CA/地址、认证状态机、后台接口或数据库。
- 仍只按真实 capabilities 显示页签与操作；仅 `account:create` 的账户页仍不请求全局列表。
- 一次性开通码/重置码仍只在内存显示、可复制、可关闭；关闭后离开 DOM。
- 停用/启用账户、停用/恢复小组、撤销设备仍保留现有确认；409 版本冲突、403、429、401 处理路径未改。
- 未改 `scripts/qa.mjs` 的 T-LOCAL-001 补丁（工作区仍是原有 1 处路由匹配改动）。

## 执行的命令与结果

| 命令 | 退出码 | 关键结果 | 日志 |
| --- | --- | --- | --- |
| `npm run build` | 0 | `tsc --noEmit` + `vite build` 通过；仅有既有 >500 kB chunk 提示 | `evidence/build.log` |
| `node collab/results/T-LOCAL-010/verify-ui.mjs` | 0 | **50 项检查 / 0 失败，18 张改版后截图**；覆盖五页、角色空/有数据、账户授权、保存/撤销、危险操作取消/确认、浅/深主题、1920/1280/390、横向溢出与文本/按钮重叠 | `evidence/ui-verify.log`、`ui-results.json` |
| `git diff --no-index` 生成 T10 diff | 0 | 仅 2 个源码文件 + 验收脚本 | `diff.patch` |
| `patch -p1 --dry-run` / 实际应用 | 0 | 3 个文件全部匹配，重建后 0 差异 | `evidence/patch-dry-run.log`、`evidence/patch-apply.log` |

- 构建产物：`dist/assets/index-BPz3YXVL.css` 188.82 kB、`dist/assets/index-Dps8QQDR.js` 502.50 kB。
- 源码 SHA-256：`CloudWorkspace.tsx` `eb54e5b1776d7e3c39635167e2b7ff37f072bc69b9715b3cfb72c5e7eb174c97`；`style.css` `dbbffb30e13df9bc688112b7d2e2e79c5295a1a2558348fc6e17595a5a07022b`；`diff.patch` `4587637741fbef5f317f7aab4da80af23c9912201b7c8222d0c34c94ba78205c`。
- 溢出实测：`1280` 与 `390` 下五页均为 `document=0 / body=0 / panel=0`；`ui-results.json` 记录每次检查。

## 截图

改版前（同一基线代码、同一 mock 流程）：

- `screenshots/before/roles-1920x1080-before.png`
- `screenshots/before/roles-1280x800-before.png`
- `screenshots/before/roles-390x844-before.png`
- `screenshots/before/accounts-1280x800-before.png`
- `screenshots/before/security-1280x800-before.png`

改版后（18 张，均在 `screenshots/`）：

- 角色：`roles-data-1920x1080`、`roles-data-1280x800`、`roles-data-390x844`
- 角色空状态：`roles-empty-1920x1080`、`roles-empty-1280x800`、`roles-empty-390x844`
- 深色主题：`roles-dark-1280x800`、`security-dark-1280x800`
- 账户授权：`roles-auth-1920x1080`、`roles-auth-1280x800`、`roles-auth-390x844`、`roles-auth-member-1280x800`
- 账户管理：`accounts-1280x800`、`accounts-390x844`
- 其他：`groups-1280x800`、`security-1280x800`、`security-390x844`、`audit-1280x800`

## 未测与边界

- 未连接正式云端 `112.74.109.173`，未读取正式库/真实素材，未输入正式密码，未操作正式账户、服务或 Docker。
- 未使用真实设备证书、私钥、P12 或口令；全部 UI 验收使用临时 `MEDIA_DATA_DIR` 与既有 `tests/cloud-management-mock.mjs`。
- 本轮只做 Chromium 无头验收，未复跑 WebKit/Firefox；未做触屏真机与真实 13 寸屏色彩校准。
- 未跑全量后端测试（按规格不重复）；未提交、未推送、未部署、未重启用户常驻服务。
- `npm run build` 的 >500 kB chunk 提示为既有打包体积提示，不是本次改动引入的失败。
