// Only a precise, pre-handler HOST_BUSY refusal permits replaying a local read.
// Writes, other errors and abandoned requests are never retried here.
const retryDelays = [250, 500, 1000, 1500, 2000, 2500, 3000, 3500];
const busyMessage = '素材库仍在检查文件或执行维护，暂未读到数据，请稍后重新读取。';
export const hostBusyMessage = (code: unknown, fallback: string) => code === 'HOST_BUSY' ? busyMessage : fallback;

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); throw signal.reason; }
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
    })]);
  } finally { if (stop) signal.removeEventListener('abort', stop); }
}

export function createHostReadClient({
  fetch: send = (input: string, init?: RequestInit) => globalThis.fetch(input, init),
  now = Date.now,
  wait = delay,
}: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: () => number; wait?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) {
  let active = 0, waiting = 0, lastActivity = 0;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  async function track<T>(work: () => Promise<T>): Promise<T> {
    active++;
    try { return await work(); }
    finally { active--; lastActivity = now(); }
  }
  async function fetchRead(input: string, init: RequestInit = {}, assertCurrent?: (signal?: AbortSignal) => Promise<void>): Promise<Response> {
    if ((init.method ?? 'GET').toUpperCase() !== 'GET' || !input.startsWith('/api/')) return send(input, init);
    return track(async () => {
      let recovering = false, busySince = 0, signal = init.signal ?? undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const busyFailure = () => Object.assign(Error(busyMessage), { code: 'HOST_BUSY', status: 423 });
      const receive = async (response: Response) => {
        // These callers read finite JSON APIs. Keep ownership until the full body
        // is ready, even when a caller only checks status and never calls json().
        const reader = response.clone().body?.getReader();
        try {
          if (reader) while (!(await abortable(reader.read(), signal)).done) { /* Drain the clone; retain the original response. */ }
        }
        catch (error) {
          void reader?.cancel(error).catch(() => {});
          void response.body?.cancel().catch(() => {});
          throw error;
        } finally { reader?.releaseLock(); }
        if (recovering && assertCurrent) await abortable(assertCurrent(signal), signal);
        signal?.throwIfAborted();
        return response;
      };
      try {
        for (let attempt = 0; ; attempt++) {
          signal?.throwIfAborted();
          const response = await send(input, { ...init, signal });
          signal?.throwIfAborted();
          if (response.status !== 423) return await receive(response);
          const refusal = await abortable(response.clone().json(), signal).catch(error => {
            signal?.throwIfAborted(); return null;
          });
          signal?.throwIfAborted();
          if (refusal?.code !== 'HOST_BUSY') return await receive(response);
          if (!recovering) {
            recovering = true; busySince = now(); waiting++; notify();
            const deadline = new AbortController();
            signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
            deadlineTimer = setTimeout(() => deadline.abort(busyFailure()), 15000);
          }
          const pause = retryDelays[attempt];
          if (pause === undefined || now() - busySince + pause > 15000) {
            throw busyFailure();
          }
          await wait(pause, signal);
          if (assertCurrent) await abortable(assertCurrent(signal), signal);
        }
      } finally {
        clearTimeout(deadlineTimer);
        if (recovering) { waiting--; notify(); }
      }
    });
  }
  return {
    fetch: fetchRead,
    track,
    idle: (quietMs = 2000) => active === 0 && now() - lastActivity >= quietMs,
    recovering: () => waiting > 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const hostReads = createHostReadClient();
