// 待处理的轮询：任何时候最多一条轮询链。
// 规则：要么有一个等着的定时器，要么有一次正在进行的请求，二者不会同时存在，也不会各有两个。
// 页面从隐藏变回可见时：没有请求在进行，就取消定时器、马上读一次；有请求在进行，就什么也不做，等它读完照常排下一次。
export type PollEnv = {
  hidden: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onVisible: (fn: () => void) => () => void;
};

export const browserPollEnv = (): PollEnv => ({
  hidden: () => document.hidden,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: timer => window.clearTimeout(timer as number),
  onVisible: fn => {
    const handler = () => { if (!document.hidden) fn(); };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
});

/** 开始轮询，返回停止函数。页面隐藏时不发请求，只照常排下一次。 */
export function startPolling(run: () => Promise<unknown>, interval: number, env: PollEnv = browserPollEnv()) {
  let timer: unknown = null, inflight = false, stopped = false;
  const schedule = () => { if (!stopped) timer = env.setTimer(tick, interval); };
  async function tick() {
    timer = null;
    if (stopped) return;
    if (env.hidden()) return schedule();
    inflight = true;
    try { await run(); } catch { /* run 自己负责显示错误 */ } finally { inflight = false; }
    schedule();
  }
  const offVisible = env.onVisible(() => {
    if (stopped || inflight) return;
    if (timer !== null) { env.clearTimer(timer); timer = null; }
    void tick();
  });
  void tick();
  return () => { stopped = true; if (timer !== null) env.clearTimer(timer); timer = null; offVisible(); };
}
