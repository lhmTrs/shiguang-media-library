export type FeedbackKind = 'error' | 'warning' | 'success' | 'info';
export type FeedbackCategory = 'input' | 'connection' | 'account' | 'conflict' | 'file' | 'service' | 'operation';
export type FeedbackInput = {message: string; kind?: FeedbackKind | 'auto'; title?: string; source?: string; duration?: number; key?: string};
export type FeedbackItem = {id: string; kind: FeedbackKind; category: FeedbackCategory; title: string; message: string; source: string; count: number; leaving: boolean};
export type FeedbackSnapshot = {items: readonly FeedbackItem[]; waiting: number};
const duration = {error: 8000, warning: 6000, success: 4000, info: 4000};
const headings: Record<FeedbackCategory, string> = {input: '输入需要检查', connection: '连接出现问题', account: '账户或权限问题', conflict: '操作状态需要核对', file: '文件处理失败', service: '服务暂时不可用', operation: '操作未完成'};

/** Display text only; never persist exception objects, credentials or request payloads. */
export function feedbackText(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, '[密钥已隐藏]')
    .replace(/((?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,;，；]+/gi, '$1[已隐藏]')
    .trim().slice(0, 600);
}

export function describeFeedback(input: FeedbackInput) {
  let message = feedbackText(input.message);
  if (!message) return null;
  if (/^(?:AbortError|已取消(?:本次)?操作|用户已取消)/.test(message)) return null;
  if (input.kind === 'auto' && /^(?:正在|连接中|加载中|处理中|已连接|等待.*返回)/.test(message) && !/失败|异常|错误|无法|未能/.test(message)) return null;
  const busy = /\b(?:HOST_BUSY|DATABASE_BUSY|SQLITE_BUSY|FILE_MAINTENANCE_BUSY)\b/.test(message);
  const category: FeedbackCategory = busy ? 'service'
    : /CONFLICT|STALE|UNKNOWN|待核对|尚未核清|版本.*(?:变化|更新|冲突)|资料已被/.test(message) ? 'conflict'
    : /AUTH|TOKEN|UNAUTHORIZED|FORBIDDEN|登录|权限|额度|余额/.test(message) ? 'account'
    : /NETWORK|Failed to fetch|fetch failed|Load failed|断网|连接.*(?:失败|断开)|超时|TimeoutError|ECONN/i.test(message) ? 'connection'
    : /请输入|请选择|不能为空|格式不正确|参数无效|INVALID_|VALIDATION/.test(message) ? 'input'
    : /文件|目录|素材|编码|磁盘|ENOENT|ENOSPC/.test(message) ? 'file'
    : /HTTP\s*5\d\d|SERVICE_|服务.*(?:失败|不可用|错误)/.test(message) ? 'service' : 'operation';
  const kind: FeedbackKind = busy ? 'warning' : input.kind && input.kind !== 'auto' ? input.kind
    : /失败|异常|错误|无法|未能|未成功/.test(message) ? 'error'
    : /暂未|未完成|尚未|待核对|UNKNOWN|离线|失效|缺失/.test(message) ? 'warning'
    : /已|成功|完成/.test(message) ? 'success' : 'info';
  if (busy) message = '素材库正在处理文件或维护任务，请稍后重试。现有输入与上次确认的结果会保留。';
  if (/^(?:Failed to fetch|fetch failed|Load failed|NETWORK_ERROR)$/i.test(message)) message = '暂时无法连接服务，请检查连接后重试。当前输入仍保留。';
  const title = feedbackText(input.title || (kind === 'success' ? '操作成功' : kind === 'info' ? '提示' : busy ? '任务处理中' : headings[category]));
  return {kind, category, title, message, source: feedbackText(input.source || '')};
}

type Internal = FeedbackItem & {key: string; remaining: number; started: number; paused: Set<string>};
type Timer = ReturnType<typeof setTimeout> | number;
export function createFeedbackStore(clock: {now?: () => number; schedule?: (fn: () => void, ms: number) => Timer; cancel?: (timer: Timer) => void} = {}) {
  const now = clock.now || Date.now;
  const schedule: (fn: () => void, ms: number) => Timer = clock.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel: (timer: Timer) => void = clock.cancel || (timer => clearTimeout(timer));
  let entries: Internal[] = [], queue: Internal[] = [], sequence = 0, hidden = false;
  let snapshot: FeedbackSnapshot = {items: [], waiting: 0};
  const timers = new Map<string, Timer>(), recent = new Map<string, number>(), listeners = new Set<() => void>();
  const clearTimer = (id: string) => { const timer = timers.get(id); if (timer !== undefined) cancel(timer); timers.delete(id); };
  const emit = () => { snapshot = {items: entries.map(({key: _key, remaining: _remaining, started: _started, paused: _paused, ...item}) => ({...item})), waiting: queue.length}; for (const listener of listeners) listener(); };
  const arm = (item: Internal) => { clearTimer(item.id); if (item.paused.size || item.leaving) return; item.started = now(); timers.set(item.id, schedule(() => dismiss(item.id), item.remaining)); };
  const promote = () => { while (entries.length < 3 && queue.length) { const next = queue.shift()!; entries.push(next); arm(next); } };
  function dismiss(id: string) {
    const item = entries.find(row => row.id === id);
    if (!item) { queue = queue.filter(row => row.id !== id); emit(); return; }
    if (item.leaving) return;
    clearTimer(id); item.leaving = true; emit();
    timers.set(id, schedule(() => { clearTimer(id); entries = entries.filter(row => row.id !== id); promote(); emit(); }, 240));
  }
  function publish(input: FeedbackInput) {
    const description = describeFeedback(input); if (!description) return null;
    const key = input.key || [description.kind, description.category, description.message].join(':');
    const existing = [...entries, ...queue].find(item => item.key === key && !item.leaving);
    if (existing) { existing.count++; emit(); return existing.id; }
    const previous = recent.get(key); if (previous !== undefined && now() - previous < 10000) return null;
    recent.delete(key); recent.set(key, now()); if (recent.size > 100) recent.delete(recent.keys().next().value!);
    const item: Internal = {...description, id: 'feedback-' + (++sequence), key, count: 1, leaving: false, remaining: Number.isFinite(input.duration) ? Math.max(150, Math.min(input.duration!, 30000)) : duration[description.kind], started: now(), paused: new Set(hidden ? ['hidden'] : [])};
    if (entries.length < 3) { entries.push(item); arm(item); } else { if (queue.length >= 8) queue.shift(); queue.push(item); }
    emit(); return item.id;
  }
  function pause(id: string, reason: string, paused: boolean) {
    const item = [...entries, ...queue].find(row => row.id === id); if (!item || item.leaving) return;
    if (paused) { if (item.paused.has(reason)) return; if (!item.paused.size && entries.includes(item)) { item.remaining = Math.max(0, item.remaining - (now() - item.started)); clearTimer(id); } item.paused.add(reason); }
    else { if (!item.paused.delete(reason)) return; if (entries.includes(item)) arm(item); }
  }
  return {publish, dismiss, pause, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setHidden: (value: boolean) => { hidden = value; for (const item of [...entries, ...queue]) pause(item.id, 'hidden', value); },
    clear: () => { for (const id of timers.keys()) clearTimer(id); entries = []; queue = []; recent.clear(); emit(); },
  };
}
