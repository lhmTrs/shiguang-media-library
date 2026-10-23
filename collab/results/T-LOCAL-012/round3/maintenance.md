# 音频安装锁残留的人工维护恢复（T-LOCAL-012 Round 3）

Round 3 起，安装器**不在运行期自动回收任何已存在的锁**。这是为了避免
`rename(lockRoot, stale)` 把另一进程刚换入的活锁搬走。代价是：进程崩溃/断电后可能留下
`<dataDir>/engines/.audio-install.lock`，后续安装/卸载会一直返回 `ENGINE_BUSY`。

## 何时可以清理

必须同时满足：

1. 当前没有安装/卸载任务在运行；
2. 没有本应用的服务进程正在执行音频安装器；
3. 已确认 `owner.json` 里的 pid 不属于任何存活进程。

不要因为“等了几分钟”或“看起来没动静”就删除锁。

## 步骤（仅人工）

```bash
DATA_DIR="<你的应用数据目录>"
ENGINES="$DATA_DIR/engines"
LOCK="$ENGINES/.audio-install.lock"

# 1. 只读查看，不要改
ls -la "$ENGINES"
cat "$LOCK/owner.json"

# 2. 用 owner.json 里的 pid 确认进程是否存活；返回非 0 表示已不存在
kill -0 <pid>

# 3. 记录并移走整个锁目录（保留证据，不直接 rm）
BACKUP="$DATA_DIR/audio-install-lock-recovered-$(date +%Y%m%dT%H%M%S)"
mv "$LOCK" "$BACKUP"
```

然后重新发起安装。若 `kill -0` 仍成功，或无法判断 pid 归属，**停止操作**，把
`owner.json` 和 `ls -la "$ENGINES"` 的结果交给维护者，不要删除锁。

## 不要做

- 不要在安装/卸载运行中删除锁；
- 不要用 `rm -rf "$ENGINES"` 清空整个引擎目录；
- 不要删除来源不明的 `audio-installer-job-*` / `.audio-install.lock.creating-*` 目录；
- 不要把本步骤做成定时任务或启动时自动清理。
