# T-LOCAL-002 根因说明

## 结论

390/320px 的横向溢出不是整页容器或表格造成的，而是素材工具条 `.content-toolbar` 的第二行控件组被固定为 `max-content` 宽度，永远不收缩、内部也不换行，导致右侧“列表/网格切换 + 显示设置”被推出视口。

## 现场数据（修复前，headless WebKit，临时夹具）

| 视口 | documentElement.scrollWidth | 工具条容器宽 | 控件组宽 | 控件组右边界 |
|---|---|---|---|---|
| 1440 | 1440 | 824 | auto（单行） | 1070 |
| 1280 | 1280 | 664 | auto（单行） | 910 |
| 1024 | 1024 | 774 | auto（单行） | 994 |
| 390 | **428** | 358 | **411.6** | **427.6** |
| 320 | **428** | 288 | **411.6** | **427.6** |

- 390 和 320 的控件组宽度都是 411.6px，与视口无关 → 说明它是 max-content 固有宽度。
- 390 时容器 358px、控件组 411.6px；320 时容器 288px、控件组仍 411.6px。
- 修复前截图：`baseline-default-390.png`、`baseline-default-320.png`（右侧齿轮按钮已出屏）。
- 原始 DOM 记录：`dom-baseline.log`。

## CSS 根因

`src/style.css` 的 `@media (max-width: 600px)` 中：

```css
.content-toolbar > div { flex-shrink: 0; }   /* 旧规则 */
```

`.content-toolbar` 外层虽然有 `flex-wrap: wrap`，但控件组是 `flex-shrink: 0` 的 flex item，其 flex-basis 取 max-content（六个控件 + 排序下拉 + 两处分段按钮 + 间隔 = 411.6px），永远不会拿到一个小于 411.6px 的可用宽度。内部的 `flex-wrap` 因此没有机会生效，只能整体向右溢出。

被挤出的具体元素：`.toolbar-popover`（显示设置，宽 32px）以及其后的布局切换 `.segmented`；在 320px 下更靠左的控件也开始出屏。文档因此产生 428px 的滚动宽度。

## 修复

只在 `≤600px` 生效，桌面尺寸不受影响：

1. `.content-toolbar > div` 允许 `flex-shrink: 1`（结果计数行同样不会撑破）。
2. `.content-toolbar > div:last-child` 改为 `flex: 1 1 auto`，显式 `flex-wrap: wrap`、`justify-content: flex-end`、`row-gap: 8px`，让控件在容器内换行并保持右对齐。
3. 分段按钮和显示设置保持 `flex: 0 0 auto`（图标按钮不被压扁），排序 `select` 允许收缩并 `max-width: 100%`。
4. `≤380px` 时批量栏图标由 32px 收到 28px、文字 `nowrap`，保证“已选 N 项 / 6 个操作 / 取消选择”仍在单行且可点。

修复后 390/320 的工具条变成两行控件区，所有按钮在视口内；桌面 1440/1280/1024 仍是 34px 单行，密度不变。
