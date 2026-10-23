# T-LOCAL-001 交付报告

## 现场信息（#0003 要求的第一步）

| 项 | 值 |
|---|---|
| 工程 | `/Users/luohongming/Desktop/作业/素材管理器`（本地前端 + 本地后端） |
| 分支 / HEAD | `main` / `2c15663a3b9b606f96220c0c3e26c5b7e3684c2e`（= `origin/main`） |
| 开工时工作区 | 干净（`git status` 无输出） |
| 复现命令 | `cd /Users/luohongming/Desktop/作业/素材管理器 && node scripts/qa.mjs --only-webkit` |
| 运行时 | macOS 15.7.3 / Node v22.7.0 / npm 10.8.2 / Playwright(webkit, 项目内) |
| 失败日志 | 修复前：仓库内无留存（本轮现场生成）；修复后：`collab/results/T-LOCAL-001/tests.log` |
| 是否有他人同时在改相关文件 | 无。`scripts/qa.mjs` 最后修改 **2026-10-16 19:15**，此后未变；`src/main.tsx` 12:27、`server/index.mjs` 13:07 均早于本回合，工作区干净 |

## 改动

- 文件：`scripts/qa.mjs`（**仅 1 处**路由匹配）
- 基线：`2c15663`；结果：**未提交**（按 #0003 规则 5，未获授权不提交/推送）
- 补丁：`collab/results/T-LOCAL-001/diff.patch`
- 未新增依赖、未改业务代码、未改断言、未加固定等待、未跳过任何测试

## 复现与验证

- 修复前：`qa.mjs:230` 失败（`assetRequests` 恒为 0）
- 修复后：同一条用例通过；断言推进到 `qa.mjs:338`
- 完整验收日志：`collab/results/T-LOCAL-001/tests.log`（`node scripts/qa.mjs --only-webkit`，退出码 1 —— 因 338 的**另一个**问题，见下）

## 未通过项（不在本工单范围）

`qa.mjs:338`：`Compact toolbar overflows at 390`

- 位置：`scripts/qa.mjs` 的响应式循环 `for (const width of [1440, 1280, 1024, 390, 320])`
- 断言：`document.documentElement.scrollWidth <= innerWidth`
- 事实：1440 / 1280 / 1024 通过，**390 失败**
- 判断：与本工单的刷新逻辑**无关**（本轮只改了测试路由匹配），且此前被 230 的失败遮蔽
- 建议：另开 **T-LOCAL-002**，范围 = 390/320 窄屏布局溢出定位与最小修复；需要我在授权后接。

## 回退方式

```bash
git checkout -- scripts/qa.mjs     # 仅回退本工单的 1 处改动
rm -rf collab/results/T-LOCAL-001  # 如需丢弃交付物
```

## 风险与说明

- 该修复只让用例"看见"真实的列表请求，不改被测行为；若将来再新增列表接口（如 `/api/search`），同样需要在用例路由里补上。
- 本轮未启动会弹窗/动真实素材的测试；全部使用临时数据目录与 headless webkit。
