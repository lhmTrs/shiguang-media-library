# T13I 注入式协议 harness

本目录是 `T13I-PROTOCOL-HARNESS-20261024` 的**测试代码**，不是产品功能，不接入
`server/`、`src/`、`scripts/`、发行配置或依赖。目标是在不安装、不解包、不运行真实
发行引擎的前提下，用假 `lease / executor / probe` 走通现有产品合同，并把“真实执行
未授权”固定在入口 gate 上。

## 入口

```sh
# API
import { runProtocolHarness } from "./tests/t13i-protocol-harness/harness.mjs";

# 自测（合成 fake + 临时目录）
node --test tests/t13i-protocol-harness/harness.test.mjs

# 12 个 canonical 场景；只写调用方指定的 JSON
node tests/t13i-protocol-harness/run-harness.mjs \
  --out collab/results/T13I-PROTOCOL-HARNESS-20261024/harness.json
```

`runProtocolHarness(scenario, { lease, executor, probe })` 是唯一完整入口。gate 顺序：

1. `mode` 不是 `injected` → `UNAUTHORIZED_REAL_EXECUTION`；
2. `realExecution/realEngine/engine/executorPath` → 同一拒绝；
3. `install.requested/execute/mode=real` → `INSTALL_NOT_AUTHORIZED`；
4. `dataDirBudgetBytes/jobOnlyBudgetBytes/budgetOverride/limits` → `INVALID_REQUEST`；
5. 只接受 `fakes.mjs` 私有品牌构造的假对象，真实 adapter 形状 → `ADAPTER_NOT_FAKE`。

以上都在 `mkdtemp`、adapter 方法调用之前返回；没有环境变量后门，CLI 没有 `--real`。
拒绝结果固定带 `sideEffects.tempDirCreated=false`、`adapterMethodsCalled=0`。

## 完整路径

```text
gate → 合成临时目录/snapshot
     → probeTool 身份（绝对路径 + 非零 sha256 + expectedSha256 匹配）
     → fake probe
     → install 阶段固定 not_executed（不调用 install）
     → fake lease（外层 deadline）
     → descriptor 身份（version/binarySha256/binarySize/generation/路径/platform/arch，
       非零、与 expected 匹配）
     → fake executor.execute（入口 deadline = min(requested, entry+30s)，无 allowance）
     → 产品 normalizeAudioResult（brief-v1）
     → exit/job/own-process-group/stdio 后置断言
     → finally: dispose → lease release → 删除临时目录
```

计时全部用 `createMonotonicClock()`（默认 `performance.now`）；记录 probe、lease
acquire/hold、execute、normalize、dispose、total，`allowanceAddedMs=0`。
`installMs=0` 是“未执行”而不是“安装很快”。

## 合同映射

| 合同 | 本 harness 的执行点 | 产品源码锚点 |
|---|---|---|
| 30s 单入口 + 180s 绝对上限 | `computeExecutorDeadline()`、`timing.executorWallLimitMs` | `server/audio-executor.mjs` `MAX_WALL_MS`、`#run` 的 `hardDeadline` |
| 64MiB FSIZE / CPU 180s / NOFILE 256 | `PROTOCOL_LIMITS` | `server/native/audio-executor-launcher.c` |
| 不追加 term/confirm allowance | `computeExecutorDeadline` 只取 min；`timing.allowanceAddedMs=0` | `audio-executor.mjs` `allowance` 用法 |
| descriptor 非零身份/匹配 | `validateDescriptor()` | `audio-engine.mjs` `#verifyRunDescriptor`、`withRunLease` |
| ffprobe expectedSha256 | `validateProbeTool()` | `audio-probe.mjs` `resolveAudioProbeTool`/`createAudioProbeToolConfig` |
| brief-v1 raw→normalized、warnings/duration/identity | 直接调用产品 `normalizeAudioResult` | `server/audio-result.mjs` `normalizeAudioResult`/`readContext` |
| 退出/job/自有进程组/dispose | `evaluatePostconditions()` + fake 自报 | `audio-executor.mjs` `#run` finally、`dispose` |
| 旧 256MiB 整 dataDir 预算 | `budget.legacyDataDirBudgetApproved=false` | 历史 T13I 资源事实，未批准 |
| 真实执行 fail-closed | 入口 gate | 本 harness，不修改产品 |

## canonical 场景

`normal`、`wrong_identity`、`expected_identity_mismatch`、`timeout`、
`cleanup_failure`、`postcondition_failure`、`noncompliant_output`、`probe_identity_mismatch`、
`raw_error_redaction`、`budget_override_refusal`、`real_execution_refusal`、
`install_refusal`。

## 明确边界（不要当成已通过）

- 所有 postcondition 来自**注入假 adapter 自报**，不是真实 OS 进程/文件描述符观测；
  不能据此宣称真实进程组、内核 IO、堆或 fd 已回收。
- `timeout` 场景只证明 harness 在合成预算内收敛并调用 dispose，不证明真实
  `AudioExecutor` 的 SIGTERM/SIGKILL/组确认时序。
- 没有运行真实 `clang`/`ffprobe`/发行引擎/安装器，没有安装、解包、下载、联网；
  没有真实音频素材、库、凭据、服务器、生产、Docker、数据库。
- 真实 `raw stderr`/原始 exit status 当前产品 API 不返回（`execute()` 只有有界
  stdout Buffer 或固定 error code）。`rawEvidence.available=false` 是**合同缺口**，
  harness 停在注入边界；没有伪造 raw 证据，也没有改产品 API。
- 旧 256MiB 整 dataDir 预算未批准；本 harness 没有引入 job-only/新上限，也没有
  用合成小数据反推真实预算可行。
- 通过本 harness 不等于 T13I 第 3 真实发行引擎协议通过，也不等于整体 READY。
- 不改 `scripts/qa.mjs` 的 T-LOCAL-001 补丁，不提交/推送/部署/启用/重启。

## 为什么不是重复现有测试

现有 `tests/audio-executor.test.mjs`、`tests/audio-probe.test.mjs`、
`tests/audio-result.test.mjs`、`tests/audio-analysis-pipeline.test.mjs` 分别覆盖
产品进程细节、探测解析、归一化和 pipeline 注入；本目录只补**跨层入口 gate +
完整 callable 路径 + 单调计时 + 后置断言 + raw 证据缺口**的合成合同检查，不重跑
旧 27+12，不镜像实现产品逻辑。产品 `normalizeAudioResult` 是直接复用而非复制。
