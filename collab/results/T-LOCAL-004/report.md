# T-LOCAL-004 交付报告：现行分类浏览器验收入口核对

日期：2026-10-22 13:10（Asia/Shanghai）
结论：**现行入口 `npm run test:browser` 在无头 Chromium 与 WebKit 下均通过，退出码 0；本轮未改任何源码、测试或产品逻辑。**

## 1. 基线

- 分支：`main`
- HEAD：`2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`
- 工作区状态（运行前后一致，未新增改动）：
  - `M scripts/qa.mjs`（仅 T-LOCAL-001 路由补丁；sha256 `0bbb5f0702ef2811262235c342a0c9f5a5662fe0f06368e7fd86bd743a56a97b`，运行前后相同）
  - `M server/index.mjs`
  - `M src/style.css`
  - `?? collab/`
  - `?? server/cloud-auth.mjs`
  - `?? tests/cloud-auth-mock.mjs`
  - `?? tests/cloud-auth.test.mjs`
- 未改 `scripts/qa.mjs` 第 426 行标题修正及第 429 行以后任何历史断言；未运行旧 `scripts/qa.mjs` 全套。
- 未修改 `拾光云端后台` 任何文件；未提交、未推送、未部署。

## 2. 契约与入口核对

- `DIRECTORY_CLASSIFICATION.md`：新版只展示主类/子类两级，选择子类包含其全部深层素材，不生成第三级；待确认由真实路径派生；身份为 `root_id + 主类 + 子类`；旧分类写接口返回 410；浏览器偏好不能切回旧视图。
- `package.json`：`"test:browser": "node scripts/qa-directory-classification.mjs --webkit"`。
- `scripts/qa-directory-classification.mjs`：
  - 自建 `mkdtemp` 临时目录、`ffmpeg` 合成 440Hz/0.6s WAV、临时 SQLite；
  - `Library(..., { directoryClassification: true })` 建立两个根（音乐库 / 音效库）；
  - 以 `NODE_ENV=production`、临时 `MEDIA_DATA_DIR`、`MEDIA_SKIP_IMPORT=1`、`MEDIA_NO_WATCH=1`、端口 4591 启动隔离服务；
  - 无头 Chromium + WebKit，`headless: true`；结束 `finally` 中杀服务并删除临时目录；
  - 不读取、不移动、不删除真实素材，不使用真实账户/云端，不弹窗。

## 3. 执行命令与结果

```sh
cd /Users/luohongming/Desktop/作业/素材管理器
npm run test:browser
```

- 实际执行：`node scripts/qa-directory-classification.mjs --webkit`
- 时间：2026-10-22 13:09:54 – 13:10:09
- **退出码：0**
- 结果：
  - Chromium：`passed: true`，11 项检查全通过
  - WebKit：`passed: true`，11 项检查全通过
- 结果 JSON：`results.json`
- 完整 stdout/stderr：`browser-run.log`
- 截图：`chrome-*.png`、`webkit-*.png`，共 22 张（两浏览器 × inspector 6 档 + classification 5 档）

## 4. 工单要求项与实测对应

| 工单要求 | 脚本中的实测 | 结果 |
|---|---|---|
| 两级封顶 | 进入 `音乐库_B` 显示 3 项；点 `B / C` 显示 2 项；随后 `.folder-children button` 数为 **0**，不出现第三级 | 通过 |
| 深层素材仍显示 | `B/C/D/deep.wav` 在 `B`（3 项）与 `B/C`（2 项）列表均出现；截图 `webkit-classification-390.png` 可见 `deep.wav` | 通过 |
| 跨根隔离/重名 | 两库都有 `B`；筛选项显示 `音乐库_B`、`音效库_B`；选 `音乐库_B` 为 3 项；唯一分类 `独有` 1 项；清空后 11 项；`/api/categories` 原始值为未加前缀的 `B` 且带各自 `rootId` | 通过 |
| 待确认位置派生 | 初始 `.asset-row` 11 项，其中待确认 4 项（每根 `loose.wav` + `待确认/inbox.wav`） | 通过 |
| 待确认移动 | 编辑框无“人工确认”复选框、无“编辑主分类”；`loose.wav` 移入 `音乐库/B/C/D` 后 `category=B, sub=C, review=0`，标签保留；列表变 3 项 | 通过 |
| 撤销 | 调 `/operations/:id/undo` 后刷新，待确认恢复 4 项 | 通过 |
| 旧视图禁用 | 预置 `localStorage.shiguang.categoryView=legacy` 后仍无“旧分类视图”按钮；`POST /api/categories` 返回 **410** | 通过 |
| 宽窄屏 | 1440/1280/1024/390/320 五档：`.app` 存在、`documentElement.scrollWidth <= innerWidth + 1`；分类页与详情面板分别截图 | 通过 |
| 标签/备注 | 详情草稿开关保留；编辑素材备注与标签保存成功；移动后标签仍在 | 通过 |

补充：脚本还覆盖详情面板拖拽/键盘调宽、滚轮不带动素材库滚动、搜索筛选、素材详情与播放器布局；均随套件通过。

## 5. 改动与边界

- **源码/测试改动：无。** `git status --porcelain` 运行前后一致；`scripts/qa.mjs` 哈希未变。
- 本轮只新增交付证据目录 `collab/results/T-LOCAL-004/`（本报告、日志、结果 JSON、截图）。
- 未提交、未推送、未部署；未运行云端 CLI；未连接正式云端/真实账户/真实 MySQL；未触碰真实素材目录；未弹窗。
- 证据中不含 cookie、令牌、私钥或真实素材路径；截图来自一次性合成素材与临时库。

## 6. 未覆盖/后续

- 旧 `scripts/qa.mjs` 第 429 行以后的历史用例本轮未执行，仍非通过；按工单未改、未迁移。
- 旧 QA 中仍可能适用的播放器、项目、静默刷新等场景，是否另立现版测试工单由 GPT 依覆盖差距决定。
- 本套件通过只代表上述现行入口与夹具范围，不等同于生产/正式云端验收。
