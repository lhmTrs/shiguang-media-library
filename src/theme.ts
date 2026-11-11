import { DEFAULT_THEME, THEME_LIST, type ThemeId } from "./theme-list";

/** 与 themes.css / theme-list.ts 同源：风格清单由 scripts/theme-gen.mjs 生成。 */
const STORAGE_KEY = "shiguang.theme";
const VALID = new Set<string>(THEME_LIST.map((t) => t.id));

/**
 * 读取已保存的界面风格。
 * 非法值（旧版本遗留、手改过的 localStorage）一律回落默认，避免出现"没有任何配色生效"的白板界面。
 */
export function readTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && VALID.has(saved)) return saved as ThemeId;
  } catch {}
  return DEFAULT_THEME;
}

let browserTheme: ThemeId | undefined;
let themeWrites = Promise.resolve();

async function saveIntakeTheme(themeId: ThemeId, onlyIfUnset: boolean): Promise<void> {
  const signal = AbortSignal.timeout(4000);
  const session = await fetch('/api/session', { cache: 'no-store', signal });
  if (!session.ok) return;
  const value = await session.json() as { app?: string; token?: string };
  if (value.app !== 'shiguang-local-media' || !value.token) return;
  await fetch('/api/file-intake/theme', {
    method: 'PUT', signal,
    headers: { 'content-type': 'application/json', 'x-local-token': value.token },
    body: JSON.stringify({ themeId, onlyIfUnset }),
  });
}

/**
 * 应用并持久化风格：通过 <html data-theme> 切换配色，配色全部由 CSS 侧 `html[data-theme=...]` 的 token 覆盖完成。
 * 网页实际切换时也同步给访达收纳窗口；失败不阻塞浏览器的主题切换。
 */
export function applyTheme(id: ThemeId, { syncIntake = true } = {}): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
    document.documentElement.dataset.theme = id;
    if (saved !== null || id !== DEFAULT_THEME || browserTheme !== undefined) localStorage.setItem(STORAGE_KEY, id);
  } catch {}
  if (!syncIntake || /^#\/?file-intake(?:\/|$)/.test(location.hash) || browserTheme === id) return;
  const first = browserTheme === undefined;
  browserTheme = id;
  if (first && (saved === null || !VALID.has(saved))) return;
  themeWrites = themeWrites.then(() => saveIntakeTheme(id, first)).catch(() => {});
}
