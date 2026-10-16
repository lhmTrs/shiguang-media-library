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

/**
 * 应用并持久化风格：只改 <html data-theme>，配色全部由 CSS 侧 `html[data-theme=...]` 的 token 覆盖完成。
 * 因此切换是纯 CSS 行为，不触发任何数据请求。
 */
export function applyTheme(id: ThemeId): void {
  try {
    document.documentElement.dataset.theme = id;
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}
