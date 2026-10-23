# T-LOCAL-013D 交付报告：音频结果规范化与版本指纹

- 日期：2026-10-23
- 回复：`#0090`（工单 `T-LOCAL-013D`）
- 工程：`/Users/luohongming/Desktop/作业/素材管理器`
- 规格：`/Users/luohongming/Desktop/作业/拾光云端后台/collab/specs/T-LOCAL-013D.md`（只读）
- 结论：**本地纯函数实现与隔离测试完成，待 GPT 独立审查/反例/性能验证**；未提交、未推送、未部署、未连接正式服务器/账户、未运行发行引擎/真实音频、未接生产执行链。

## 1. 修改范围

只新增本地文件，没有修改任何既有源码/测试/配置：

| 文件 | 说明 |
|---|---|
| `server/audio-result.mjs` | 新增纯函数模块（529 行）：`normalizeAudioResult`、`createAudioResultFingerprint` |
| `tests/audio-result.test.mjs` | 新增 33 项定向测试（665 行），全部合成 JSON/Buffer |
| `collab/results/T-LOCAL-013D/` | 本报告、结果 JSON、最小 diff、基准、原始日志、源码/证据 hash |

未改 `server/index.mjs`、`Library`、`audio-engine.mjs`、安装器、T13B 队列/快照、旧 `audio-analysis.mjs`、schema/迁移/数据库、HTTP/前端、发行配置或依赖；未 import 任何 collab 原型到 server；未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁。模块没有被任何生产代码 import，默认关闭状态不变。

## 2. 接口与返回结构

```js
normalizeAudioResult(raw, context)
createAudioResultFingerprint(context)
```

- 两者都是**纯函数**：无文件/网络/子进程/DDL 副作用；只 import `node:crypto`。
- 成功判别结构（深度冻结）：

```js
{
  ok: true,
  schemaVersion: 1,
  protocol: "brief-v1",
  value: { bpm, key, loud, energy, fit, seg },
  warnings: ["BPM_UNAVAILABLE" | "KEY_UNRECOGNIZED" | "UNKNOWN_FIELDS_IGNORED"],
  provenance: {
    kind, sourceSha256, sourceSize, durationSec,
    engineVersion, engineBinarySha256, engineGeneration,
    parameters: { brief: true }
  },
  fingerprint: "<64 lowercase hex>"
}
```

- 失败判别结构固定，只有固定 code + 固定短 message，**不回显输入、字段名、路径或原始异常**：

```js
{ ok: false, code: "<固定码>", message: "<固定文案>" }
```

- `createAudioResultFingerprint` 成功时返回 `{ok, schemaVersion, protocol, fingerprint, provenance}`；失败同样是 `INVALID_CONTEXT`。
- 出口对象/数组全部 `Object.freeze`（含 `warnings`、`provenance.parameters`、`seg.energyChangeSec`）；不保留调用方 `context` 或 Buffer 的可变引用。

## 3. 字段来源、单位与 null 语义

`value` 始终包含以下固定字段；缺失测量输出 `null`（不使用 `Number(x) || null`），合法 `0`、`-0`、正 peak、负 dBFS 原样保留。

| 输出字段 | 来源 | 单位/范围 | null 语义 |
|---|---|---|---|
| `bpm` | `raw.bpm` | BPM，`(0,400]` | 缺失/null/`0`（`0` 另加 `BPM_UNAVAILABLE`） |
| `key.tonic` | `raw.key.best` 的根音 | 音名 `A–G` + 可选 `#`/`b` | 缺失/null/无法识别 |
| `key.mode` | `raw.key.best` 的 mode | `major`/`minor`（`maj`/`min` 归一） | 缺失/null/无法识别 |
| `key.keyScore` | `raw.key.r` | 无量纲 `[0,1]`；不称概率/置信度 | 缺失/null |
| `key.recognized` | 由 `best` 派生 | boolean | `false` 表示 unknown/无法识别 |
| `loud.peakDbfs` | `raw.loud.peak` | dBFS，`[-200,50]` | 缺失/null |
| `loud.rmsDbfs` | `raw.loud.rms` | dBFS，`[-200,50]` | 缺失/null |
| `energy.minDbfs` | `raw.energy.min` | dBFS，`[-200,50]` | 缺失/null |
| `energy.maxDbfs` | `raw.energy.max` | dBFS，`[-200,50]` | 缺失/null |
| `energy.stdDb` | `raw.energy.std` | dB 变化量，`[0,200]` | 缺失/null |
| `fit.beat` / `fit.tonal` / `fit.chord` | `raw.fit.*` | `[0,1]` | 缺失/null |
| `seg.energyChangeSec` | `raw.seg` | 秒，`0..context.durationSec`，严格递增，最多 1000 | 缺失/null；显式 `[]` 保留为空数组 |
| `warnings` | 固定枚举 | 最多 16、去重 | 无 warning 为 `[]` |

补充语义：

- `bpm: 0` 归一为 `null` 并加 `BPM_UNAVAILABLE`，不写“0 BPM”。
- `key.keyScore` 是独立数值；`best` 无法识别时仍保留合法 `keyScore`，但 `recognized=false`、`tonic/mode=null`，不猜 major、不保留原始 `best`。
- `min/max` 同时存在时要求 `min <= max`；`std < 0` 拒绝。
- `seg` 不排序“修复”：逆序、重复、负数、越过 `durationSec`、超过 1000 点均 `INVALID_SEG`。
- 有效测量判定：`bpm` 有非 0 值、`key` 有可识别调性或 `keyScore`、`loud/energy/fit` 任一非 null、`seg` 非空。`{}`、只有未知字段、空嵌套对象、只有 `bpm:0`、只有无法识别且无 `keyScore` 的 `key`、只有空 `seg` 均 `NO_MEASUREMENT`。

## 4. 调性语法（固定文档）

只接受以下完整语法（根音大写 `A–G`，可选 `#`/`b`；根音与 mode 之间是**一个** ASCII 空格或一个 `:`；mode 为 `major/minor/maj/min`）：

```
^([A-G])([#b]?)(?::| )(major|minor|maj|min)$
```

示例：`C major`、`A minor`、`C:maj`、`A:min`、`F#:major`、`Bb minor`。
`C Major`、`H major`、`C`、`C dorian`、`C  major`、`C\tmajor`、末尾空格等均为“无法识别”：`tonic/mode=null`、`recognized=false`、`KEY_UNRECOGNIZED`，不保留原文。长度 >32 或非字符串直接 `INVALID_KEY`。

## 5. 固定 warning 与失败码

Warning 枚举（只出现固定字符串，未知字段名/原始调性/路径不会插入）：

| Warning | 触发 |
|---|---|
| `BPM_UNAVAILABLE` | `bpm` 显式为 `0` |
| `KEY_UNRECOGNIZED` | `best` 是 ≤32 字符但不匹配固定语法 |
| `UNKNOWN_FIELDS_IGNORED` | 顶层或已知对象的嵌套出现未知字段（含 `src/asr/path/__proto__/constructor`），每次结果最多一次 |

失败码（`INVALID_CONTEXT` 为规格固定；其余为本实现固定并在此文档化）：

| Code | 触发 |
|---|---|
| `INVALID_CONTEXT` | context 缺失/未知字段/类型/范围/参数不符 |
| `INVALID_RAW_TYPE` | raw 不是 string/Buffer（不做隐式 String 转换） |
| `RESULT_TOO_LARGE` | 实际 UTF-8 字节 > 64 KiB |
| `INVALID_UTF8` | Buffer 非法 UTF-8 |
| `INVALID_JSON` | JSON 解析失败（含空串/BOM/尾随内容） |
| `INVALID_SHAPE` | JSON 顶层不是普通对象 |
| `INVALID_BPM` / `INVALID_KEY` / `INVALID_LOUD` / `INVALID_ENERGY` / `INVALID_FIT` / `INVALID_SEG` | 已知字段类型/范围/结构错误 |
| `NO_MEASUREMENT` | 没有有效测量值 |

`raw` 校验顺序：先校验 context（失败 `INVALID_CONTEXT`），再检查 raw 类型 → 字节上限 → UTF-8 → JSON → 顶层对象 → 字段。数值只接受 JSON number；`"120"`、`true`、`[]`、`{}`、`1e999`（解析为 Infinity）均拒绝。

## 6. context 严格校验

只接受恰好 8 个自有字符串键；未知键、符号键、非枚举额外键、缺失键都拒绝，且不原样 spread：

| 字段 | 约束 |
|---|---|
| `kind` | `music` 或 `sfx` |
| `sourceSha256` | 64 位小写 hex |
| `sourceSize` | 安全整数 `0..268435456`（256 MiB，含端点） |
| `durationSec` | 有限数 `0..600`（含端点） |
| `engineVersion` | `[A-Za-z0-9._+-]{1,128}` |
| `engineBinarySha256` | 64 位小写 hex |
| `engineGeneration` | 32–64 位小写 hex |
| `parameters` | 恰好 `{brief: true}`，多余键/错误值拒绝 |

模块只快照上述基本类型，不保留调用方对象引用；不接收/输出 path、URL、argv 或任意扩展参数。

**边界声明**：`durationSec` 由未来可信内部调用者提供，本模块**不 probe 媒体**，不证明它与真实文件时长一致；`sourceSha256`/`sourceSize` 同样只是调用者声明。

## 7. 版本指纹

`createAudioResultFingerprint` 先做与上文完全相同的 context 严格校验，再对固定域标签 + 固定数组顺序做 canonical JSON，最后 SHA256：

```
["shiguang.audio-result.fingerprint", 1, "brief-v1",
 kind, sourceSha256, sourceSize, durationSec,
 engineVersion, engineBinarySha256, engineGeneration,
 "brief", true]
```

- 使用数组而非对象拼接/分隔符字符串，避免依赖属性插入顺序；`parameters` 只按规范化后的 `brief:true` 进入。
- 覆盖 source digest + size、kind/duration、engine version + binary digest + generation、schemaVersion/protocol 与规范化 parameters；上述任一有效字段变化都会改变指纹（测试逐个验证）。
- 返回 allowlist `provenance` + `fingerprint`，不返回整个 context。
- **边界声明**：指纹只描述调用者给出的身份，不证明实际文件已 hash、当前仍被管理、缓存命中、事务保存或旧 job 防回写；这些依赖 T13B/T13C 与未来存储集成，本项不伪造完成。

## 8. 测试与证据

全部测试使用合成 JSON/Buffer 与临时目录；不启动服务、不联网、不读写真实素材/库、不运行发行引擎。

| 套件 | 结果 | 日志 |
|---|---|---|
| `tests/audio-result.test.mjs` | **33/33 pass**，0 fail/skip | `logs/result-tests.log` |
| `tests/audio-feature-flag.test.mjs`（默认冻结） | **3/3 pass** | `logs/feature-flag.log` |
| `node --check` ×3 + `git diff --check` | 全部 exit 0 | `logs/syntax.log` |
| `npm run build` | exit 0（仅既有 503.25 kB chunk 警告） | `logs/build.log` |

33 项覆盖矩阵：

1. 正常音乐完整字段、正 peak、0 分、seg；2. sfx 仅 loud；3. 静音候选 `-200 dBFS`/`std=0`；4. null/缺失语义与完整输出字段；5. `bpm=0` warning；6. bpm 边界/字符串/布尔/`1e999`；7. 调性 7 种合法语法映射；8. 无法识别调性不泄露原文、`keyScore` 保留、缺失/null 无 warning、tab/换行不算分隔；9. 调性类型/长度/`keyScore` 边界；10. loud 的 `0`/`-0`/`-200`/正 peak/越界/类型；11. energy 范围、`min<=max`、`std>=0`；12. fit `[0,1]` 与 0；13. seg 1000 点、1001 点、重复/逆序/负值/越界/类型、`duration=0`；14. 空对象/只有未知/空嵌套 → `NO_MEASUREMENT`；15. raw object/array/number/bool/null/Symbol/TypedArray；16. 坏 JSON 与顶层非对象；17. 非法 UTF-8 Buffer；18. 64 KiB 恰好接受/超 1 字节拒绝（string 与 Buffer）/多字节按实际字节；19. 未知顶层/嵌套字段一次 warning 且不泄露；20. warning 只用固定枚举；21. `__proto__`/`constructor` 不污染原型/全局；22. context 必填字段逐个缺失/类型错误；23. 未知键/符号键/非枚举键；24. context 各字段端点与非法值；25. parameters 固定形状；26. 指纹确定性/参数顺序；27. 每个身份字段变化改变指纹；28. 指纹失败固定码；29. provenance 仅 allowlist；30. 输入 Buffer/context 后续修改不影响结果、深度冻结；31. 结果顶层键 allowlist；32. 模块无 fs/net/http/child_process/spawn/fetch 静态断言；33. 失败结构稳定且不泄露输入片段。

复跑命令：

```bash
cd /Users/luohongming/Desktop/作业/素材管理器
node --test tests/audio-result.test.mjs
node --test tests/audio-feature-flag.test.mjs
npm run build
node collab/results/T-LOCAL-013D/benchmark.mjs
```

## 9. 纯解析基准

`node collab/results/T-LOCAL-013D/benchmark.mjs`，Node v22.7.0 / darwin-arm64，7 轮重复样本；**这是合成 JSON 的解析/规范化/指纹成本，不是真实音频分析性能，也不含引擎/IO/网络**。

| 场景 | 输入字节 | 输出字节 | 每轮次数 | 中位 ms/次 | 均值 ms/次 | 最大 ms/次 | 次/秒 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 小 JSON normalize | 179 | 753 | 20,000 | 0.003982 | 0.004021 | 0.004255 | 248,704 |
| 近 64 KiB normalize（1000 seg 点 + pad） | 65,536 | 5,547 | 1,000 | 0.058967 | 0.059860 | 0.061848 | 16,706 |
| fingerprint（context-only） | — | 478 | 50,000 | 0.001767 | 0.001773 | 0.001795 | 564,106 |

近 64 KiB 的输出字节较小，是因为未知 `pad` 字段按协议丢弃、只保留 1000 个 seg 点与固定字段；不是输入被截断。指纹只依赖 context，与 raw 大小无关。

## 10. 最小 diff 与源码 hash

- `diff.patch`：1206 行，两个新文件的 `git diff --no-index /dev/null <file>` 完整内容；`git apply --check --reverse` 通过（当前工作树与 diff 一致）。
- `code.sha256` / `evidence.sha256` / `results.json` 均在结果目录。

| 文件 | SHA256 |
|---|---|
| `server/audio-result.mjs` | `1c014fd9c550a4a4a0d9100d9a28a7f6e85915ad2b2efd5da45daae6dc14b42a` |
| `tests/audio-result.test.mjs` | `2eef9c644f548e57955271a7ede7af87ca38759e0888f319105736559788c776` |
| `benchmark.mjs` | `747c4b5532a3567a861fd600895bdd8be2e0c511f122adf93e22ac0106d49fe4` |
| `diff.patch` | `30aeaf4b5827e3b386542834865766a41d00c7177a2b32bcf29e9efb9cbd5dec` |

## 11. 已知边界 / 需要 GPT 重点复核

1. **协议不是真实发行协议**：`protocol: "brief-v1"` 明确是合成标记；本项没有运行发行引擎，也没有与真实二进制输出做兼容验收。
2. **时长/摘要不是证明**：context 的 `durationSec/sourceSha256/sourceSize` 只是调用者声明；本模块不 probe、不 hash 文件。
3. **指纹不等于存储**：不证明缓存命中、事务保存、旧 job 防回写；这些留给 T13B/T13C/未来存储。
4. **严格取舍**：BOM 不剥离（`TextDecoder` `ignoreBOM:true`，BOM 开头会 `INVALID_JSON`）；`key` 只接受文档化语法；空文件/只有 `bpm:0` 等单独出现返回 `NO_MEASUREMENT`。若验收要求更宽松，请限定具体输入与期望。
5. **`seg: []`**：与其它有效测量同现时保留空数组；单独出现视为无有效测量。`energyChangeSec` 只是候选转折点，不称剧情段落。
6. **`keyScore`**：`best` 无法识别时仍保留合法数值，但 `recognized=false`；不宣称概率/置信度。

## 12. 合规声明

未提交、未推送、未部署、未重启服务；未连 112.74.109.173、未操作 Docker/数据库/正式账户；未安装软件；未运行发行引擎或真实音频；未扫描/移动/删除真实素材；未读写真实素材库；未读取/打印任何密钥/令牌/私钥/P12；未改 `拾光云端后台` 任何文件（只读规格）；未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁；未改安装器/执行器/队列/快照/index/Library/旧 analysis/schema/HTTP/前端/发行配置；未加依赖。功能开关 `SHIGUANG_AUDIO_ANALYSIS` 仍默认关闭。
