# T-LOCAL-009 正式云端发行连接接入 — 交付报告

- 工单：`拾光云端后台/collab/specs/T-LOCAL-009.md`（只读）
- 实施时间：2026-10-22 21:34–21:37（本机时区）
- 本地工程基线：`素材管理器` HEAD `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`，工作区原有的云端模块改动全部保留
- 结论：本机发行配置已接入正式公开地址与公开根 CA，`--check`、定向测试、构建均通过；未提交/推送/部署，未做正式登录，未读取或使用任何设备私钥。

## 改动文件

| 文件 | 变化 |
| --- | --- |
| `config/cloud-release.json` | 由 `scripts/cloud-release-config.mjs` 生成：`enabled=true`、`apiOrigin=https://112.74.109.173:8443`、`enrollmentOrigin=https://112.74.109.173:8444`、两个 CA 字段均为云端公开根证书 |
| `config/README.md` | 更新“原始仓库默认关闭”的表述；新增“正式发行配置（2026-10-22，T-LOCAL-009）”一节，记录地址、CA 指纹、非设备身份、owner 首配入口与缺口 |
| `tests/cloud-release.test.mjs` | 新增 2 个定向用例：正式配置结构与 CA 指纹/无私钥；无设备身份时就绪但未登录、不创建 `cloud-device/` |
| `collab/results/T-LOCAL-009/**` | 本报告、`diff.patch`、变更前备份、生成/校验/测试/构建日志、补丁校验 |

`diff.patch` 共 136 行，含上述 3 个文件；`patch -p1 --dry-run` 与实打均退出 0，应用后与当前文件 `diff` 为 0 行。

## 执行的命令与结果

| 命令 | 退出码 | 关键结果 | 日志 |
| --- | --- | --- | --- |
| `node scripts/cloud-release-config.mjs --api-origin …8443 --enrollment-origin …8444 --server-ca <公开root-ca.pem> --device-ca <同一文件> --force` | 0 | 4037 bytes，`enabled=true`，`containsPrivateKey=false` | `evidence/01-generate.log` |
| `node scripts/cloud-release-config.mjs --check` | 0 | `enabled=true`、`usable=true`、`errors=[]`、地址正确 | `evidence/02-check.log` |
| 配置内容独立核对（Node `X509Certificate`） | 0 | 两个 CA 指纹均为 `66:5A:…:CF:46`，为同一 CA，`ca=true`，无私有材料引用 | `evidence/03-config-inspection.log` |
| `node --test tests/cloud-release.test.mjs` | 0 | **2 passed / 0 failed** | `evidence/04-tests-release.log` |
| `node --test tests/cloud-auth.test.mjs tests/cloud-management.test.mjs` | 0 | **41 passed / 0 failed**（含连接拒绝归类、未登录/未配置固定错误码） | `evidence/05-tests-cloud-auth-management.log` |
| `node --test tests/device-enrollment.test.mjs` | 0 | **22 passed / 0 failed** | `evidence/07-tests-enrollment.log` |
| `npm run build` | 0 | `tsc --noEmit` + `vite build` 成功 | `evidence/06-build.log` |
| 补丁 dry-run/实打/复核 | 0 | 3 文件全部匹配，重建 0 差异 | `evidence/10-patch-check.log` |

配置 SHA-256：`449eff358c2d64a40745505c8b4cfbc7b2d3bacf910249b298ef6184d9beebf1`。
公开根 CA 指纹：`66:5A:D3:0D:94:FE:BF:20:49:E0:65:31:91:A7:95:F2:87:DE:96:70:9A:3D:AB:4D:00:80:DC:55:53:BA:CF:46`。

## 边界与未做事项

- 未提交、未推送、未部署；未改云端任何源码/迁移/配置/CA/部署单元；未操作 `112.74.109.173`。
- 未启动或重启用户常驻服务；测试只使用临时 `MEDIA_DATA_DIR` 与既有本机 mock，无头、不弹窗。
- 未做正式密码登录，未索取密码，未兑换任何生产开通码，未创建正式账户。
- 未读取/复制/打包 `.runtime` 下 offline/server/owner-device 材料、备份或口令；未连接真实 MySQL/素材库。
- 未改 `scripts/qa.mjs` 的 T-LOCAL-001 补丁；未安装软件。
- 公开 CA 只进入 `config/cloud-release.json`，不安装为系统信任；未关闭证书或主机名校验。

## 无身份与云端不可达

- 新用例直接加载发行配置，只初始化 `CloudAuth` 与 `DeviceEnrollment`：状态为 `ready=true`、`activated=false`、`configured=false`、`username=null`，`CloudAuth` 为 `unconfigured`、`hasClientCertificate=false`，且未生成 `cloud-device/`；未伪装已登录。
- 发行配置只参与开通/认证，启动路径不依赖云端网络；既有 `cloud-auth` 用例覆盖“连接拒绝归类为 network”和“未登录/未配置固定错误码”，本轮 41/41 通过。未额外启动常驻服务做浏览器验收。

## owner 首配说明（需 GPT 与用户另行处理）

- 现有受控入口：前端“云端连接设置”高级表单。最小字段为：云端地址（`https://112.74.109.173:8443`）、云端 CA 路径、设备证书路径（PEM）与设备私钥路径（PEM），或改填 P12 路径 + 本机保存的 P12 口令；二选一。
- 公开 CA ≠ 设备证书；发行配置不包含 owner 私钥、P12、口令、开通码、JWT 或默认账户。
- 未读取 owner-device 导出内容，因此无法确认其 PEM/P12 是否包含签发它的中间 CA。如果导出只有叶证书而没有中间链，当前表单没有单独的“中间证书链”字段，这是一个具体缺口；应在 GPT/用户受控配置时确认，不能用放宽校验或后门绕过。
- 正式登录仍由用户本人在后续验收时输入密码。
