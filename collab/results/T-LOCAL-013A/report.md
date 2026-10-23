# T-LOCAL-013A：Mac 执行器可行性与测试原型

- 日期：2026-10-23
- 工单：回复 GPT `#0072`，按 `拾光云端后台/collab/specs/T-LOCAL-013A.md` 与 `T-LOCAL-013-DRAFT.md`（只读）实施
- 状态：隔离原型完成；初版 **21/21**，按 GPT `#0075` 修复启动失败后 **23/23**（见 §11）；未接 `server/index`、未接分析 API/schema/前端、未启用开关、未运行真实发行引擎
- 环境：macOS Darwin 24.6.0 / arm64 / Node v22.7.0 / Apple clang 17.0.0（现有 Command Line Tools）
- 一键复跑：`node collab/results/T-LOCAL-013A/run-tests.mjs`

## 1. 结论先说

本轮拿到的可执行证据：

1. **进程执行边界**：`shell:false`、固定 argv、最小 env、独立进程组、有界 stdout/stderr、wall deadline、AbortSignal 取消、TERM→KILL、等待 close 后回收整组、单运行租约。九类要求均有实际测试（见 §3）。
2. **Mac OS 限制**：CPU / FSIZE / NOFILE 三项用 `setrlimit` launcher 实测有效；`RLIMIT_AS` 不作为硬内存限制、`RLIMIT_NPROC` 未做 fork 压力验证（见 §5）。
3. **网络**：没有 OS 网络隔离。合成子进程能连本机回环端口；因此本原型只证明“最小 env + 进程回收”，**不宣称沙箱**，也不把“可信引擎无主动联网”写成隔离已完成（见 §6）。
4. **协议**：brief 只用合成 JSON 验证字段/边界；合法 `0`、负 dBFS、`null` BPM、未知字段、坏 JSON、超量输出都有明确结果。未运行真实发行引擎，不宣称 BPM/调性准确（见 §7）。

本轮不替代 T12：T12 的锁收尾见 `collab/results/T-LOCAL-012/report.md` 第九节与 `round3/`。

## 2. 原型设计

### 2.1 `LocalExecutor`

文件：`executor.mjs`。

`run({ command, args, timeoutMs, stdoutLimitBytes, stderrLimitBytes, signal, onSpawn })`：

- 校验 `command` 必须是绝对路径、`args` 必须是字符串数组；`spawn(..., { shell:false, detached:true, stdio:["ignore","pipe","pipe"] })`，stdin 关闭。
- 每个任务在 `dataDir/executor-jobs/executor-job-<pid>-<token>/` 下建 `0700` 私有 `work/home/tmp`；`cwd=work`。
- env 只给白名单：`PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`）、`LANG/LC_ALL=C`、`BLAS/OMP/MKL/OPENBLAS/VECLIB` 线程数 `1`；`HOME/TMPDIR/TMP/TEMP` 指向本任务私有目录。父进程的 API key、代理、JWT、`PYTHONPATH`、`DYLD_*` 不进入子进程。
- stdout/stderr 分别计数，只保留到上限的字节；超限立即 `TERM` 进程组，最终结果为 `stdout-limit` / `stderr-limit`。
- wall deadline 到点后 `TERM` 整组，`graceMs`（默认 150ms）后仍在则 `KILL`；取消走同一路径；结果分别 `timeout` / `cancelled`。
- 只以 `close` 为结束点，不把 `exit` 当结束；close 后检查进程组，仍有残留则 `KILL`，轮询 `/usr/bin/pgrep -g <pgid>` 直到组清空，记录 `groupReaped` / `leftoverPids`。
- 结果包含 `state / exitCode / exitSignal / durationMs / cancelToCloseMs / stdoutBytes / stderrBytes / outputLimit / rssMaxKb / rssSamples / groupReaped / leftoverPids / pid`，stdout/stderr 只返回有界快照。
- 单运行租约：`dataDir/.audio-executor.lock`，`open(..., "wx", 0600)` 原子创建；已存在一律 `EXECUTION_BUSY`，不按时间/pid 自动回收（与 T12 锁策略一致）；释放前核对 token，避免误删别人的租约。崩溃残留需人工维护，不在运行期盲删。
- 所有 `finally` 清理：timer、流、进程组、任务临时目录、租约。同进程可继续下一任务。

### 2.2 合成夹具

- `fixtures/child.mjs`：`success / zero-values / nonzero / timeout / cancel / stdout-limit / stderr-limit / grandchild / sleep / env / connect / nofile / fsize / cpu`。全部为小型 Node 合成程序，不读真实素材、不连公网。
- `fixtures/rlimit-launcher.c`：exec 前设置 `RLIMIT_CPU / RLIMIT_FSIZE / RLIMIT_NOFILE`；仅在现有 CLT 可用时编译到 `build/`，不装依赖、不触发安装提示。
- `fixtures/rss-of.c`：实验用 `libproc` 读取指定 pid 的 resident size，仅用于短采样；不是生产依赖。

### 2.3 brief 解析夹具

文件：`brief.mjs`。只抽取 `bpm/key/loud/energy/fit/seg`，未知字段忽略并给 warning；数值范围与类型显式校验；合法 `0`、负 dBFS、`null` BPM 原样保留；`bpm=0` 视为无效而不是“已测 0”；超过 64 KiB 为 `OUTPUT_LIMIT`。这是**合成协议夹具**，不是真实引擎协议验收。

## 3. 测试结果

一键命令：`node collab/results/T-LOCAL-013A/run-tests.mjs`
总日志：`evidence/all-tests.log`（**21 tests / 21 pass / 0 fail / 0 skipped**，约 5.4s）

| 要求/类别 | 测试 | 结果 | 关键断言 |
|---|---|---|---|
| success | `success：固定 argv/shell:false/最小 env...` | pass | exit 0、close、brief 解析、临时目录/租约清理 |
| nonzero | `nonzero：退出码透传...` | pass | 退出码 7、stderr 有界保留 |
| timeout | `timeout：wall deadline 杀进程组...` | pass | state=timeout、组清空、RSS 采样 |
| cancel | `cancel：AbortSignal...` | pass | state=cancelled、cancel→close 计时、组清空 |
| stdout-limit | `stdout-limit：有界缓冲...` | pass | 超 4KiB 即杀组、返回缓冲 ≤ 上限 |
| stderr-limit | `stderr-limit：stderr 有界...` | pass | 同上，stderr |
| grandchild-cleanup | `grandchild-cleanup：孙进程...` | pass | 记录孙 PID，close 后 `kill(pid,0)` 不存在，`leftoverPids=[]` |
| env-scrub | `env-scrub：不继承哨兵...` | pass | 11 个哨兵均 false；PATH/HOME/TMPDIR/线程数符合白名单 |
| lock-release | `lock-release：活跃执行期间...` | pass | 第二个 run `EXECUTION_BUSY`；取消后租约释放，下一任务 success |
| shell:false | `shell:false：参数中的 shell 元字符...` | pass | `; echo injected` 按字面输出；相对命令 `INVALID_SPEC` |
| 连续任务 | `同进程连续任务...` | pass | timeout 清理后立即 success |
| 网络缺口 | `网络隔离缺口...` | pass（缺口证据） | 未设 OS 隔离时子进程连本机回环成功 |
| Mac CPU 限制 | `Mac RLIMIT_CPU...` | pass | `SIGXCPU`，约 1s 软限制 |
| Mac FSIZE 限制 | `Mac RLIMIT_FSIZE...` | pass | 文件恰好 65536B 后 `EFBIG` |
| Mac NOFILE 限制 | `Mac RLIMIT_NOFILE...` | pass | 打开约 1004 个 fd 后 `EMFILE` |
| brief 边界 | `brief.test.mjs` 6 项 | pass | 0/负值/null/未知字段/坏 JSON/超 64KiB |

分项日志：`evidence/executor-tests.log`、`evidence/launcher-tests.log`、`evidence/brief-tests.log`、`evidence/all-tests.log`。

说明：`executor-tests.log` 是加入 shell:false 用例前的 11 项快照；最终 21 项以 `all-tests.log` 为准（executor 12 + launcher 3 + brief 6）。

## 4. 正常/取消耗时与 RSS 短采样

命令：`node collab/results/T-LOCAL-013A/benchmark.mjs`
结果：`evidence/timing.json`、`evidence/timing.log`

| 场景 | 样本 | 指标 | min | median | max | RSS 短采样 |
|---|---:|---|---:|---:|---:|---:|
| 成功启动→close | 8 | duration | 48ms | 50ms | 55ms | 太快，50ms 采样未命中（null） |
| 取消→close | 5 | cancelToClose | 1ms | 1ms | 1ms | ~41.6MB |
| timeout(500ms)→close | 3 | duration | 505ms | 505ms | 506ms | ~41.1MB |

说明：这些数字只是合成 Node 子进程的本机行为，**不代表** 120MB 发行引擎的冷启动/分析耗时；RSS 是 `libproc` 短采样软监督，不能保证瞬时硬上限，也不是 `RLIMIT_AS`。

## 5. Mac 资源限制实测与边界

launcher 证据：`evidence/build.log`、`evidence/launcher-tests.log`。

| 限制 | 设置 | 实测 | 结论 |
|---|---|---|---|
| `RLIMIT_CPU` | soft=1s, hard=2s | 子进程约 1.26s 收到 `SIGXCPU`，executor 归为 `resource-limit` | 可用；软限制先到，硬限制兜底 |
| `RLIMIT_FSIZE` | 65536B | 写满 65536B 后 `EFBIG`，文件未超限 | 可用 |
| `RLIMIT_NOFILE` | 1016 | 子进程打开约 1004 个 fd 后 `EMFILE` | 可用；具体阈值受 Node/运行时基线 fd 影响，生产需按引擎实测 |
| `RLIMIT_NPROC` | 未设置/未压测 | — | **未验证**；按工单要求不做大量 fork 压力，不把 BSD 行为当已证 |
| `RLIMIT_AS` | 未使用 | — | **不作为硬内存隔离**；macOS 上不能把 Linux 的 `RLIMIT_AS` 语义搬过来。生产只能把 RSS 当软监督，超限需明确 `RESOURCE_LIMIT`，不能宣称硬保障 |
| 网络隔离 | 未设置 | 子进程连本机回环成功 | **没有 OS 网络隔离**；见 §6 |

`RLIMIT_CPU` 是 CPU 秒数而非 wall clock；wall deadline 仍由 Node timer 负责，两者互补。若生产要求“无 launcher 不得运行”，需在启动前检查 launcher 可用，否则 `EXECUTION_UNAVAILABLE`。

## 6. 网络隔离缺口（必须如实记录）

测试启动一个仅绑定 `127.0.0.1` 的临时 TCP server，合成子进程 `net.connect` 成功，输出 `{"connected":true}`。

因此：

- 本原型**不是**恶意二进制沙箱，没有 OS 层禁止联网；
- “引擎代码没有 http 调用 / 只读快照”只是可信引擎的设计约束，不等于 OS 强制隔离；
- 若下一阶段要声明网络隔离，必须另行做平台可行性验证（例如 sandbox/Network Extension 等），并验证“只对自建回环端口的连接被拒绝”，不能只靠代码审查或改 hosts；
- 本轮未对公网发探针，未访问生产。

## 7. brief 合成协议行为

| 输入 | 结果 |
|---|---|
| `bpm:null` | 保留 null，不写 0 |
| `bpm:0` / 负数 / 字符串 | `INVALID_OUTPUT`（0 不代表“已测”） |
| `loud.peak:0`、`energy.min:0`、`std:0` | 原样保留 0 |
| `loud.rms:-14.25`、`energy.min:-60` | 保留负 dBFS，不截断为 0 |
| 未知顶层字段 | 忽略并给 warning，不失败 |
| 坏 JSON / 数组 / 无已知字段 | `INVALID_OUTPUT` |
| 超过 64 KiB | `OUTPUT_LIMIT` |
| `seg` 非数字或 >1000 项 | `INVALID_OUTPUT` |

仍未验证：真实发行引擎的实际 brief 字段、合法范围、坏 JSON/超量输出行为；必须等有可追溯发布二进制并用合成音频验收后再固化协议，不能拿本轮夹具当实物协议。

## 8. 下一项正式落地的最小文件清单与未验证项

正式落地（另发工单后）建议最小改动：

1. `server/audio-executor.mjs`：从本原型收敛，命令/参数改为发布描述白名单，接入可信 descriptor（version/binary sha/generation），保留 env 白名单、进程组、输出上限、deadline、取消、租约。
2. `server/audio-engine.mjs`：只读导出可信 descriptor（binaryPath/version/sha），不向网页回传路径；与安装器锁/租约的关系需明确（分析租约 vs 安装锁，避免两套锁互相绕过）。
3. `server/audio-analysis.mjs`：任务状态机、快照、队列、取消/超时映射；默认开关仍关闭。
4. `tests/audio-executor.test.mjs`：把本目录 9 类 + Mac launcher 测试收敛为仓库测试；launcher 构建脚本只走现有 CLT，不装依赖。
5. 启动前检查：launcher 可用、binary 摘要匹配、平台/版本匹配；不满足返回 `EXECUTION_UNAVAILABLE`，不偷偷无约束运行。

未验证/待决策：

- 真实 120MB 发行引擎的冷启动、CPU/RSS、brief 协议、超时/取消行为；
- 网络强隔离方案与平台可行性；
- `RLIMIT_NPROC`、`RLIMIT_AS` 的硬保障；
- 队列/快照/DB schema/API/前端（不属于 T13A）；
- 与 T12 安装锁/运行租约的最终合并方式（本轮未改 T12 文件）；
- 生产环境是否允许随包分发 launcher 二进制，及其签名/公证/可追溯构建。

## 9. 复跑

```bash
cd /Users/luohongming/Desktop/作业/素材管理器

# 一键（自动尝试编译 launcher/rss 辅助，再跑 21 项）
node collab/results/T-LOCAL-013A/run-tests.mjs

# 分项
node --test collab/results/T-LOCAL-013A/tests/executor.test.mjs
node --test collab/results/T-LOCAL-013A/tests/launcher.test.mjs
node --test collab/results/T-LOCAL-013A/tests/brief.test.mjs

# 短基准
node collab/results/T-LOCAL-013A/benchmark.mjs
```

全部使用临时目录/合成子进程/本机回环，不接触真实库、真实素材、发行引擎、正式服务器。

## 10. 边界

未提交/推送/部署；未启动/重启常驻服务；未开启 `SHIGUANG_AUDIO_ANALYSIS`；未接 `server/index`、Library、schema、前端；未下载/运行 120MB 发行引擎；未分析真实素材；未访问 112.74.109.173、Docker、数据库、正式账户；未安装全局软件或改 Mac/服务器策略；未读取/打印任何密钥、令牌、私钥、P12 口令；未改 `拾光云端后台` 任何文件；未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁。

本目录产物：`executor.mjs`、`brief.mjs`、`fixtures/`、`tests/`、`run-tests.mjs`、`benchmark.mjs`、`build/`（本机编译产物）、`evidence/`。

## 11. 启动失败修复（回复 GPT #0075）

### 11.1 根因

原 `run()` 在 `spawn()` 后先检查 `child.pid`，再注册 `error/close` 监听。ENOENT/EACCES 的 `error` 是下一个 tick 异步发出的；pid 检查在监听器存在之前就抛 `SPAWN_FAILED`，`run()` 的 `finally` 清理后把错误抛给调用方，但随后到达的 `error` 事件没有监听器，Node 以未处理事件终止宿主进程（云端探针实测 `exit=1, unhandled=true`）。`onSpawn` 回调在监听器注册前执行，回调抛错也有同样的未处理事件风险。

### 11.2 修复

只改 `executor.mjs` 的启动/失败路径与必要测试：

- `spawn()` 之后**立即**注册 `close` 与 `error`；`error` 只记录 `spawnError`，`closePromise` 只在 `close` 时 resolve，失败路径也真正等到 close。
- 不再在 pid 缺失时同步抛错；`close` 后按 `spawn-error` 归一为受控结果，`finally` 照常清理进程组、任务目录与租约。
- `onSpawn` 移到监听器/超时/输出处理之后执行；回调抛错走受控失败：`requestTermination("on-spawn-failed")` → 等 close → 抛固定码 `SPAWN_CALLBACK_FAILED`，`finally` 清理租约/临时目录，不留后台进程。
- pid 无效时 `requestTermination` 只记录原因、不做 `kill(-undefined)`；RSS 采样与 stdout/stderr 处理对失败 spawn 做空值/pid 防护。
- 结果字段 `pid` 在 spawn 失败时为 `null`（原来可能是 `undefined`）。

### 11.3 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| T13A 全量 | **23/23 pass，0 fail，0 skipped**（原 21 项 + ENOENT/EACCES/失败后下一任务 1 项 + onSpawn 回调异常 1 项） | `fix-spawn/evidence/spawn-full-tests.log` |
| 云端 `probe.mjs`（云端已更新，本侧未改） | 2/2 pass；T13A 用例 `exit=0, state=spawn-error, unhandled=false` | `collab/results/T-LOCAL-012/round4/evidence/round4-cloud-probe-after.log` |
| 云端 `startup-recovery-probe.mjs`（本侧未改） | **2/2 pass**；ENOENT/EACCES 均受控，且同一 executor 下一任务 `success`、租约/任务目录清空 | `fix-spawn/evidence/spawn-cloud-recovery-probe.log` |
| 语法 | `node --check collab/results/T-LOCAL-013A/executor.mjs` 退出码 0 | `fix-spawn/evidence/spawn-syntax.log` |
| 构建 | `npm run build` 退出码 0 | `fix-spawn/evidence/spawn-build.log` |
| 补丁往返 | 修复前基线 + `diff-spawn.patch` 后两文件 `cmp` 一致 | `fix-spawn/evidence/spawn-patch-check.log` |

新增测试断言：ENOENT 与非可执行文件（EACCES）均返回 `spawn-error`、租约释放、任务目录清空、同进程下一任务成功；`onSpawn` 抛错返回 `SPAWN_CALLBACK_FAILED`、租约释放、下一任务成功。

### 11.4 文件与复跑

- `fix-spawn/diff-spawn.patch`：相对修复前交付状态的最小补丁，仅 `executor.mjs` + `tests/executor.test.mjs`。
- `fix-spawn/baseline/`：修复前文件副本，用于 diff/往返校验。
- 复跑：`node collab/results/T-LOCAL-013A/run-tests.mjs`；或 `node --test collab/results/T-LOCAL-013A/tests/executor.test.mjs`。
