# T-LOCAL-013D round2：context 纯数据边界返工

2026-10-23，回复 GPT #0092（对应云端 `collab/reviews/T-LOCAL-013D/review-round1.md`、
`probe-round1.mjs`）。仅修 `validateContext` 的局部数据读取边界，未改其它层、
未改 GPT probe、未删除任何保护断言；round1 产物全部保留。

## 1. 问题与修复

| # | round1 反例 | 修复 |
|---|---|---|
| P2-a | 恰好 8 键的普通对象中某字段是 getter，直接解构会执行 getter，抛出的原始异常带 `/private/synthetic/context-secret`，不返回固定结构 | 新增 `ownDataValues(object, expected)`：用 `Reflect.ownKeys` 确认恰好允许的自有字符串键，再逐个 `Object.getOwnPropertyDescriptor` 读取；只有**自有 data descriptor** 才取值。访问器（无论是否 enumerable、是否返回合法值）一律拒绝，getter 永不执行 |
| P2-b | `parameters.brief` 访问器走同一路径 | `parameters` 也经 `ownDataValues(parameters, ["brief"])` 读取，且要求 `brief === true`；访问器同样拒绝且不执行 |
| P2-c | `isPlainObject` / `Reflect.ownKeys` / 反射 trap 自身抛错会外泄 | `validateContext` 整体 `try/catch`，任何反射异常（撤销 Proxy、`ownKeys`/`getPrototypeOf`/`getOwnPropertyDescriptor` trap 抛错、trap 返回非法键、descriptor 对象的 `value` getter 抛错）统一收敛为 `{ok:false}`，两个导出函数返回固定 `INVALID_CONTEXT` |

实现要点：

- 字段值只进入本地 `Object.create(null)` 值表，不保留 context/parameters 引用；
  `parameters` 快照仍固定为新的 `Object.freeze({ brief: true })`。
- 顶层 8 键、符号键、未知键、缺失键、非枚举额外键的既有拒绝策略不变；
  合法 data descriptor 的普通/冻结/null-prototype context 行为不变。
- 没有新增全局猴补、没有新依赖、没有扩展到其它模块。

## 2. 改动文件

- `server/audio-result.mjs`：`validateContext` 拆为 try/catch 外壳 + `readContext`，
  新增 `ownDataValues`，删除只被旧路径使用的 `hasExactKeys`。
- `tests/audio-result.test.mjs`：新增 4 项回归（33 → 37 项）：
  1. 8 个顶层字段逐个改为“返回合法值”的 getter：两个函数都必须
     `INVALID_CONTEXT`、getter 计数 0、失败结构仅 `code/message/ok`、无 `/private/`；
  2. `parameters.brief` 的抛错 getter 与返回合法值 getter：同样拒绝且不执行；
  3. 反射异常：撤销 Proxy、`ownKeys` 抛错/返回非键、`getPrototypeOf` 抛错、
     `getOwnPropertyDescriptor` 抛错、descriptor 的 `value` getter 抛错，
     两个函数均不抛、固定 `INVALID_CONTEXT`、无原始 message 泄露；
  4. 合法纯数据回归：冻结 context、null-prototype context 与普通 context
     指纹一致，normalize 成功。
- `collab/results/T-LOCAL-013D/round2/`：本报告、最小 diff、本地对抗探针、
  原始日志、hash。

`bpm:0`、无法识别调性、空 `seg`、BOM 策略均未改动（#0092 明确本轮可接受）。

## 3. 证据（全部为合成数据，纯内存）

| 检查 | 结果 | 日志 |
|---|---|---|
| GPT `probe-round1.mjs`（未改） | **2/2 pass**，0 fail/skip | `evidence/round2-gpt-probe.log` |
| 定向 `node --test tests/audio-result.test.mjs` | **37/37 pass**，0 fail/skip（约 75ms） | `evidence/round2-result-tests.log` |
| 默认冻结 `node --test tests/audio-feature-flag.test.mjs` | **3/3 pass**（约 6.57s），`SHIGUANG_AUDIO_ANALYSIS` 仍默认关闭 | `evidence/round2-freeze.log` |
| `node --check` ×4 + `git diff --check` | 全部 exit 0 | `evidence/round2-syntax.log` |
| `npm run build` | exit 0（仅既有 503.25kB chunk 警告） | `evidence/round2-build.log` |
| 本地对抗探针 | **35 个检查全通过**：所有访问器/反射反例固定失败且 getter 0 次执行，合法纯数据指纹一致 | `evidence/round2-local-probe.log` |

本地探针 `probe-round2.mjs` 与定向测试互补：探针覆盖撤销 Proxy、四类反射 trap、
descriptor 的 `value` getter、8 个顶层字段与 `parameters.brief` 的访问器、
null-prototype/冻结合法回归，并断言两个导出函数都不抛异常、结果不含
`/private/` 片段。

## 4. 最小 diff 与 hash

`diff-round2.patch` 相对 round1 终态（由 round1 `diff.patch` 还原并核对
SHA256 一致）仅两文件、4 个 hunk，+176/−15 行。已验证：对 round1 文件
`git apply --check` 通过，应用后两文件与当前工作区 `cmp` 完全一致。

当前 SHA256：

```
69bf6eb9e419194ff7b46446de41322e38003a95f2808460811e0172f5c65f0f  server/audio-result.mjs
ace8ff7e89d7f0929d09dc2153ff47a5b64c085c9eef12bef1de3e1919d57cb2  tests/audio-result.test.mjs
ec33d6b9690525176c7e4453357e6a080fcc0be43000e2b4d2dc83dbfee4e609  round2/diff-round2.patch
6d9d5b02c279a23a6b25da94bd77988b93d46c5f4762aaeb56dbf57b3a217f54  round2/probe-round2.mjs
747c4b5532a3567a861fd600895bdd8be2e0c511f122adf93e22ac0106d49fe4  benchmark.mjs
```

round1 两文件 hash（`1c014fd9…b42a` / `2eef9c64…c776`）保持为历史基线，
round1 的 `diff.patch`、`logs/`、`report.md`、`results.json` 未改动。

## 5. 纯解析基准（合成 JSON，非真实分析性能）

`node collab/results/T-LOCAL-013D/benchmark.mjs`，Node v22.7.0 / darwin-arm64，
7 轮；`evidence/round2-benchmark.log`：

| 场景 | 输入字节 | 输出字节 | 中位 ms/次 | 均值 ms/次 | 最大 ms/次 | 次/秒 |
|---|---:|---:|---:|---:|---:|---:|
| 小 JSON normalize | 179 | 753 | 0.004478 | 0.004520 | 0.004754 | 221,242 |
| 近 64 KiB normalize（1000 seg 点 + pad） | 65,536 | 5,547 | 0.059999 | 0.060617 | 0.064079 | 16,497 |
| fingerprint（context-only） | — | 478 | 0.002218 | 0.002221 | 0.002259 | 450,276 |

与 round1 差异属同机抖动；本轮新增仅为 context 键/描述符读取（8 个字段），
不在热路径增加 IO 或哈希。该基准只测解析/规范化/指纹，不含引擎、磁盘、网络，
不是真实音频分析性能。

## 6. 边界声明

- 未提交、未推送、未部署、未重启服务；未开启 `SHIGUANG_AUDIO_ANALYSIS`。
- 未接 index/Library/队列/快照/schema/HTTP/前端；未修改安装器/执行器/发行配置；
  模块仍未被生产代码 import。
- 未运行发行引擎/真实音频，未访问真实素材库/账号/服务器，未操作 Docker/数据库。
- 未新增依赖；未改 `拾光云端后台` 任何文件（仅只读运行其 probe）；未动
  `scripts/qa.mjs` 的 T-LOCAL-001 补丁。
- `brief-v1` 仍是合成协议标记，未经真实发行二进制协议验收；指纹仍只描述调用者
  声明，不证明文件已 hash、缓存命中或已持久化。
