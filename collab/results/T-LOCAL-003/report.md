# T-LOCAL-003 交付报告（未提交）

## 基线（本轮开工时）

- 仓库：`/Users/luohongming/Desktop/作业/素材管理器`
- 分支 / HEAD：`main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`
- dirty：
  - `M scripts/qa.mjs`（T-LOCAL-001 的 `assets|asset-series` 路由补丁，未提交）
  - `M server/index.mjs`
  - `M src/style.css`
  - `?? server/cloud-auth.mjs`
  - `?? tests/cloud-auth-mock.mjs`
  - `?? tests/cloud-auth.test.mjs`
  - `?? collab/`
- `scripts/qa.mjs` 开工 sha256：`55fb8bdd5fbce66e13d11d8a8a21227d13037873c2571da89eca5037e4bd2ea0`
- `scripts/qa.mjs` 完工 sha256：`0bbb5f0702ef2811262235c342a0c9f5a5662fe0f06368e7fd86bd743a56a97b`

## 改了什么

只改 `scripts/qa.mjs` 第 426 行这一处旧文案断言：

```diff
-    await expect(page.getByRole("heading", { name: "文件夹", exact: true })).toBeVisible();
+    await expect(page.getByRole("heading", { name: "分类管理", exact: true })).toBeVisible();
```

- 依据：`src/FolderBrowser.tsx:108` 的标题是 `<h1>分类管理</h1>`。
- 可见性断言保留，426 行之后的点击/筛选/响应式/预览操作全部保留。
- T-LOCAL-001 的 `scripts/qa.mjs` 路由补丁（`/\/api\/(?:assets|asset-series)\?/`）完整保留；未改 CSS、认证、后端或数据。
- 相对本轮开工状态的最小 hunk 见 `diff.patch`（仅一行）；`git diff --check` 退出 0。

## 执行与结果

命令（无头 WebKit、脚本自建临时 `MEDIA_DATA_DIR`、`MEDIA_SKIP_IMPORT=1`）：

```sh
node scripts/qa.mjs --only-webkit
```

- 时间：2026-10-22 12:58:25 – 12:59:01
- 退出码：**1**（未通过，不能宣称整套 QA 通过）
- 完整日志：`qa-webkit.log`
- **第 426 行断言已通过**（否则不会执行到 431）；失败发生在 **`scripts/qa.mjs:431`**：

```text
locator.click: Timeout 30000ms exceeded.
waiting for getByRole('region', { name: '真实文件夹浏览', exact: true }).getByRole('button', { name: /^快速/ })
```

## 新暴露失败：第三级文件夹断言与两级分类模型冲突（未修，按工单停止扩大）

- 失败时页面：面包屑为 `音效 测试 / 转场 / 呼啸`，`.folder-children` 为空；页面按钮中不存在 `快速`。
- 页面证据：`failure-431.png`、`dom-failure-431.json`（含失败时 DOM 与全部 `/api/folder-browser` 响应）。
- 根因：分类视图只支持主类/子类两级。`server/folder-browser.mjs:86`
  在 `classification=1` 且目录深度 ≥ 2 时明确返回 `children: []`。
  实测 API `directory=转场/呼啸&classification=1` 返回空 `children`；
  `directory=转场` 返回 `["呼啸"]`。测试夹具却预先建了 `音效 测试/转场/呼啸/快速`，第 429–435 行仍按三级目录点击/断言。
- 这是第 426 行之后原本就未执行到的既有用例漂移，不是本次一行标题修改造成的功能回归；本次工单只授权修 426 行，故**未改 429–435 行，也未改产品逻辑**。

## 未完成 / 需要新授权

- 完整 `qa.mjs` 未通过，停在 431；431 之后（含 1440/1280/1024/390/320 文件夹页截图、预览、旧分类视图等）本轮未执行。
- 需要 GPT 决定：是否把 429–435 行按“两级分类”契约另开最小修正（例如把第三级夹具/点击改为两级内可验证行为），还是调整工单边界。未获授权前不扩大修改。

## 回退

只有一个 hunk：把 `diff.patch` 中 `分类管理` 改回 `文件夹` 即回到本轮开工状态。

## 边界

- 未提交、未推送、未部署。
- 未修改 `/Users/luohongming/Desktop/作业/拾光云端后台` 任何文件。
- 未连接正式云端/真实账户/真实 MySQL；未扫描、移动或删除真实素材。
- 无头浏览器、临时夹具与 QA 服务已清理；未弹窗。
