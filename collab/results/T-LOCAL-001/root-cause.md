# T-LOCAL-001 根因说明

## 结论（一句话）

**不是刷新逻辑坏了，是验收用例的接口匹配过期**：前端在"系列分组"模式下列表请求走 `/api/asset-series`，而用例只拦截 `**/api/assets?*`，所以 `assetRequests` 永远是 0，断言 `toBeGreaterThan(assetsBefore)` 必然失败。

## 证据链

1. **复现**：`node scripts/qa.mjs --only-webkit` → 失败在 `scripts/qa.mjs:230`
   ```
   expect(received).toBeGreaterThan(expected)
   Expected: > 0    Received: 0
   ```
2. **插桩**（把 qa.mjs 复制到临时副本，仅加请求日志，不动仓库）：
   ```
   [DEBUG] rootsBefore=1 assetsBefore=0 rootRequests=2 assetRequests=0 revision=1
   ```
   → 页面渲染了 5 行（前置断言通过），但 `assetRequests` 为 0，说明**列表请求没有命中这条路由**。
3. **页面实际请求**（去重统计）：
   ```
   3 /api/roots
   3 /api/jobs
   2 /api/stats
   2 /api/asset-series      ← 列表请求走这里
   1 /api/tags/revision
   1 /api/tags/facets
   1 /api/projects/usage-counts
   ```
   **完全没有 `/api/assets`**。
4. **前端依据**：`src/main.tsx:801`
   ```js
   (params.get("series") === "1" ? "/asset-series?" : "/assets?") + params
   ```
   即：系列分组模式开启时列表走 `/api/asset-series`；该模式是当前默认，因此用例的路由不再匹配。

## 为什么它"从 10/16 起一直红"

上一次通过的验收记录是 **2026-10-16 19:06**；`4288e8c`（10-16 20:37，引入按根的两级目录分类）之后的提交都在 main 里，而验收从未再变绿 —— 与"系列分组"相关的前端改动正是 `d227355`（10-21 10:29，Improve media search, series grouping and pagination UX）引入的。用例没有随接口变化更新，因此红灯被"沿用"到了今天。

## 最小修复

只改**路由匹配**，不改任何断言、不加固定等待、不跳过测试：

```diff
-      await polling.route("**/api/assets?*", async route => {
+      // 列表请求有两类：普通模式 /api/assets?…、系列分组模式 /api/asset-series?…
+      // 只拦前者会让"自动刷新"用例在系列模式下永远数到 0（本轮 T-LOCAL-001 的根因）。
+      await polling.route(/\/api\/(?:assets|asset-series)\?/, async route => {
         assetRequests++;
         if (holdAssets) await assetsGate;
         await route.continue();
       });
```

`assetRequests` 的语义保持"列表请求次数"，两条路径都真实发出请求，因此 `holdAssets` 门控、`assetRequests > before`、以及后续"静默刷新不显示蒙层/内联提示"的断言全部保持原意。

## 修复后的状态

- 原失败用例（`qa.mjs:230`）**已通过**（断言推进到 `qa.mjs:338`）。
- **新暴露**：`qa.mjs:338` `Compact toolbar overflows at 390`（390px 窄屏 `document.documentElement.scrollWidth > innerWidth`）。
  这是**另一个问题**（布局溢出），且此前被 230 的失败遮住，不在本工单范围。建议另开 T-LOCAL-002。
