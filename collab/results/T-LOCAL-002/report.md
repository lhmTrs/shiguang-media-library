# T-LOCAL-002 交付报告（本地窄屏工具栏溢出修复）

日期：2026-10-22
工程：`/Users/luohongming/Desktop/作业/素材管理器`
对应留言：#0014（T-LOCAL-002）

## 1. 开工现场（#0014 ① 要求）

- 分支：`main`
- HEAD：`2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`（未变）
- 开工 dirty：
  - `M scripts/qa.mjs`（T-LOCAL-001 的 1 处路由匹配，**全程未动**）
  - `M server/index.mjs`、`?? server/cloud-auth.mjs`、`?? tests/cloud-auth*.mjs`（T-LOCAL-CLOUD-001，**全程未动**）
  - `?? collab/`（交付目录）
- 本轮拟改文件：`src/style.css`（唯一源码改动）
- 重叠：与上述 QA/认证改动 **零文件重叠**；未修改云端工程、未修改 `scripts/qa.mjs`、未 reset/stash/checkout 任何已有改动。

## 2. 根因与修复

详见 `root-cause.md`。

一句话：`.content-toolbar` 的控件组在 `≤600px` 继承了旧规则 `flex-shrink: 0`，宽度恒为 max-content 411.6px，内部无法换行；390px 容器只有 358px、320px 只有 288px，于是右侧布局切换和“显示设置”按钮被推出视口，`documentElement.scrollWidth` 变成 428px。

修复只在 `src/style.css`：

1. `≤600px`：控件组允许收缩，`flex: 1 1 auto` + `flex-wrap: wrap` + 右对齐；排序 `select` 可收缩；分段按钮/显示设置不压扁。
2. `≤380px`：批量栏图标 28px、文字不折行，保证“已选 N 项 + 6 个操作 + 取消选择”单行可点。

桌面端（1440/1280/1024）规则未改动，工具条仍是 34px 单行。

最小 diff：`diff.patch`（13 行新增、1 行修改，仅 `src/style.css`）。

## 3. 验证结果

### 3.1 构建

```sh
npm run build
# exit 0；dist/assets/index-DfoF4OWW.css、index-DHSJRQZA.js
```

日志：`build-final.log`。

### 3.2 单元测试

```sh
npm test
# tests 147 / pass 147 / fail 0 / skipped 0
```

日志：`unit-final.log`。

### 3.3 原工单浏览器复现与回归

```sh
node scripts/qa.mjs --only-webkit
```

- 修复前：`AssertionError: Compact toolbar overflows at 390`（`qa.mjs:338`），日志 `qa-baseline.log`。
- 修复后：已越过 `qa.mjs:336–344` 的全部断点（1440/1280/1024/390/320），在 **`qa.mjs:426`** 因既有文案漂移中止：该行仍期待 `heading "文件夹"`，而 `src/FolderBrowser.tsx` 自 `4288e8c` 起标题为“分类管理”。这与本工单无关，未修改该断言，也未扩大范围。
- 因此：**目标用例通过，但完整 qa.mjs 套件仍非全绿**；426 行之后的用例本轮未执行，不宣称整套通过。

日志：`qa-final.log`。

### 3.4 窄屏定向探针（可复跑）

```sh
node collab/results/T-LOCAL-002/probe.mjs
# AUDITS=40  FAILURES=0
```

临时 `MEDIA_DATA_DIR` + 合成素材 + headless WebKit，不碰真实素材/真实库。每个宽度/状态断言：

- `documentElement.scrollWidth <= innerWidth`
- 工具条控件均在视口内（left ≥ 0、right ≤ innerWidth）
- 控件中心 `elementFromPoint` 命中自身或其子元素（可点击）
- 控件两两不重叠
- 详情/批量栏/筛选面板/高级筛选均在视口内，详情内部无横向滚动

覆盖状态（每个状态 × 1440/1280/1024/390/320）：

| 状态 | 说明 |
|---|---|
| `default` | 默认列表 |
| `search-tags` | 长中文搜索“风声 测试 环境 自然” + “环境/自然”多标签条件 |
| `batch-bar` | 选中 2 项后的批量操作栏 |
| `details-open` / `details-closed` | 详情面板开 / 关 |
| `advanced-filters` | “更多筛选”展开（目录/格式/时长/仅收藏/日期） |
| `tag-menu-open` | 标签筛选面板展开 |
| `category-menu-open` | 分类筛选菜单展开 |

修复后实测：默认状态 390/320 的 `scrollWidth` 分别为 390/320；工具条容器 358/288；所有控件右边界 ≤ 374/304。桌面 1440/1280/1024 工具条高度保持 34px。

DOM 明细：`dom-audit.json`；失败清单：`dom-audit-failures.json`（空数组）。

## 4. 证据索引

- 根因：`root-cause.md`
- 最小 diff：`diff.patch`
- 修复前 DOM/截图：`dom-baseline.log`、`baseline-default-{1440,1280,1024,390,320}.png`
  - 基线截图用 HEAD 版 `src/style.css` 构建的 CSS 通过 Playwright 请求拦截拍摄，未改工作区。
- 修复后截图（8 状态 × 5 宽度 = 40 张；加 5 张基线共 45 张）：`default-*`、`search-tags-*`、`batch-bar-*`、`details-open-*`、`details-closed-*`、`advanced-filters-*`、`tag-menu-open-*`、`category-menu-open-*`
- 探针脚本：`probe.mjs`
- 构建/测试日志：`build-final.log`、`unit-final.log`、`qa-baseline.log`、`qa-final.log`、`probe.log`

## 5. 未完成 / 未验证（如实）

1. 完整 `qa.mjs --only-webkit` 在 426 行被既有 `"文件夹"` 文案断言挡住，未全绿；本工单目标段（336–344）已通过，426 之后未跑。未改该断言以免扩大范围。
2. 未做认证 UI / 登录入口 / 小组 / 云端接入；未改后端接口与认证代码。
3. 未提交、未推送、未部署；`scripts/qa.mjs` 的 T-LOCAL-001 补丁与 T-LOCAL-CLOUD-001 改动原样保留。
4. 未使用真实账户、正式云端、真实 MySQL 或真实素材；未弹窗；临时夹具与服务已清理。
5. `SecretStore`、限流、并发认证等不在本轮范围，未重复验证。

## 6. 逐文件回退

只有 `src/style.css`：

```sh
cd /Users/luohongming/Desktop/作业/素材管理器
git apply -R collab/results/T-LOCAL-002/diff.patch
npm run build   # 还原 dist
```

`dist/` 是构建产物（git 忽略），不改源码即可由 `npm run build` 重建。
