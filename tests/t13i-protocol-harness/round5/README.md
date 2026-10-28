# T13I 注入式协议 harness（round5）

本目录是 `T13I-PROTOCOL-HARNESS-20261024` **round5** 的测试代码，不是产品功能，不接入
`server/`、`src/`、`scripts/`、发行配置或依赖。目标仍是在不安装、不解包、不运行真实
发行引擎的前提下，用假 `lease / executor / probe` 走通现有产品合同，并把“真实执行
未授权”固定在入口 gate 上。

round5 只补独立审查 round4 的窄 P2：**raw 准入只检查 `Buffer.isBuffer()`，没有确认
真实 typed-array byte view**。在 Node22 上：

```js
const raw = Object.create(Buffer.prototype);
Buffer.isBuffer(raw);      // true
ArrayBuffer.isView(raw);   // false
```

round4 的 `new Uint8Array(value)` 对非 view 会回退到调用方 `Symbol.iterator`，把回调
带进 raw 捕获边界。round5 在保留 round4 已通过的字节复制逻辑的前提下，增加真实
byte-view 准入守卫：

1. 在模块加载时固定 `ArrayBuffer.isView`、`Buffer.isBuffer` 与
   `%TypedArray%.prototype[@@toStringTag]` 的内建 getter；判定只读内部 slot，不读
   调用方 own getter、`valueOf`/`toString`、`Symbol.iterator`。
2. `isGenuineByteView()` 要求 `ArrayBuffer.isView(value) === true` 且内建 tag 为
   `Uint8Array`；`isAcceptedRawBuffer()` 在其外仍要求 `Buffer.isBuffer(value) === true`。
3. `captureRaw()` 只在两者都成立后调用原 `copyBufferBytes()`；复制函数自身再做一次
   view 复核，未来新增调用点也不能绕过。Proxy、`Object.create(Buffer.prototype)`、
   `Uint16Array` 伪装、detached buffer 等在复制前固定
   `INVALID_REQUEST fake_executor_raw_type`。
4. `string` / 缺省 raw 与真实 Buffer / Buffer 子类继续支持；真实 Buffer 的独立副本、
   调用方后续 mutation 隔离、返回副本不反向别名均保持 round4 行为。
5. 其它构造字段、`postconditionOverride` 惰性例外、访问器拒绝、strict success
   postcondition、canonical gate 与产品源码均未改。

`contracts.mjs`、`harness.mjs`、`scenarios.mjs` 与 round4 逐字节相同；`run-harness.mjs`
只改了 usage 中的目录名。round1/round2/round3/round4 的冻结文件均未覆盖。

## raw 准入表（本目录注入边界）

| raw 输入 | 判定 | 结果 |
|---|---|---|
| `undefined` | 缺省 | 使用 `{"bpm":120}`，不读调用方 |
| `string` | 原始类型 | UTF-8 复制 |
| 真实 `Buffer` / Buffer 子类 | `Buffer.isBuffer=true` + genuine `Uint8Array` view | 按内部 slot 复制 |
| `Object.create(Buffer.prototype)` | `isBuffer=true`，`isView=false` | 固定拒绝，0 iterator |
| Proxy 包真实 Buffer | `isBuffer=true`，`isView=false` | 固定拒绝，0 get/iterator |
| `Uint16Array` 加 `Buffer.prototype` | `isBuffer=true`，tag 非 `Uint8Array` | 固定拒绝 |
| 普通 `Uint8Array` / `DataView` | 不是 Buffer | 固定拒绝 |
| number/null/array/object/String 对象/symbol | 非 Buffer | 固定拒绝，0 coercion |

`harness.mjs` 的 executor 返回值检查仍是 `string || Buffer.isBuffer`；本目录唯一可注入的
executor 由 `createFakeExecutor` 的 WeakMap membership 限制，`execute()` 只返回真实
`Buffer`，因此不构成调用方可控 raw 入口。本轮不扩到任意恶意 JS/Proxy 沙箱，也不改
产品/旧测试/配置。

## 入口

```sh
# API
import { runProtocolHarness } from "./tests/t13i-protocol-harness/round5/harness.mjs";

# round5 定向自测（只跑 raw 准入 9 项）
node --test tests/t13i-protocol-harness/round5/raw-admission.test.mjs

# 原审查非 view 反例（仅 import 路径适配到 round5）
node tests/t13i-protocol-harness/round5/probes/probe-nonview-buffer.mjs

# round4 真实 Buffer valueOf 反例（仅 import 路径适配到 round5）
node tests/t13i-protocol-harness/round5/probes/probe-buffer-coercion.mjs
```

`runProtocolHarness(scenario, { lease, executor, probe })` 仍是唯一完整入口。gate 顺序与
round4 相同：scenario 读取走 own data descriptor → `mode=injected` → 拒绝真实执行/引擎
路径 → 拒绝真实 install → 拒绝预算改写 → 只接受私有 WeakMap membership 的冻结 fake →
adapter 容器/方法/postcondition 记录访问器拒绝 → 之后才创建临时目录/调用方法。

## round5 定向验证

- 原 `probe-nonview-buffer.mjs`（断言未改，仅 import 路径适配）：`bufferPredicate=true`、
  `realTypedArray=false`、`iteratorCalls=0`、`rejected=true`，exit 0。
- `raw-admission.test.mjs` 9/9：原反例、无 iterator/带 coercion accessor 的非 view 伪装、
  普通原型矩阵、Proxy、`Uint16Array` 伪装、真实 Buffer 复制/隔离、Buffer 子类、string/
  缺省 raw、非法类型矩阵；所有拒绝路径 0 次调用方 coercion/iterator。
- round4 的 `probe-buffer-coercion.mjs` 仅换 import 路径后仍 `coercionCalls=0`、`code=OK`，
  证明真实 Buffer 复制逻辑未回归。
- 按工单**不重跑** round2/round3 的 32 项、canonical 12 场景、strict success 与旧 27+12；
  这些范围未改动，仍以上一轮独立验收为准。

不运行真实引擎/clang/ffprobe，不读真实音频/库/凭据，不联网，不安装/解包/下载，
不提交/推送/部署。自测不等于独立验收，也不等于 T13I 第 3 或整体 READY。
