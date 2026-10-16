/* 由 scripts/theme-gen.mjs 生成，请勿手改。
   改风格请改该脚本里的 THEMES / OVERRIDES，然后运行：node scripts/theme-gen.mjs */

export type ThemeId = "forest" | "dark" | "midnight" | "sepia" | "graphite" | "ocean";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  desc: string;
  /** 预览用的三个代表色：[强调色, 底色, 文字色] */
  swatch: [string, string, string];
  mode: "light" | "dark";
}

export const THEME_LIST: ThemeMeta[] = [
  { id: "forest", name: "森林绿", desc: "默认配色，清爽耐看", swatch: ["#356451", "#f7f9fa", "#24292c"], mode: "light" },
  { id: "dark", name: "深色", desc: "暗色界面，夜间不刺眼", swatch: ["#6cc39a", "#15191b", "#e6ecea"], mode: "dark" },
  { id: "midnight", name: "午夜蓝", desc: "深蓝底色，冷调夜用", swatch: ["#63a9e8", "#0f151d", "#e2e9f2"], mode: "dark" },
  { id: "sepia", name: "暖褐纸质", desc: "米黄纸感，久看舒服", swatch: ["#8a6a3a", "#faf6ee", "#33291d"], mode: "light" },
  { id: "graphite", name: "极简灰白", desc: "去色处理，专注内容", swatch: ["#4a4a4a", "#f6f6f6", "#242424"], mode: "light" },
  { id: "ocean", name: "海洋青", desc: "青蓝点缀，明亮通透", swatch: ["#1f7d8c", "#f2f9fa", "#1d2c2f"], mode: "light" },
];

export const DEFAULT_THEME: ThemeId = "forest";
