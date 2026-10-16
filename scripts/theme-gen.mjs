#!/usr/bin/env node
/**
 * 界面风格（主题）生成器。
 *
 * 背景：`src/style.css` 原本把手写调好的配色直接写死在各条声明里（约 500 处、340 种色值）。
 * 为了让"换风格"不必手改这 3000 行，本工具做两件事：
 *
 *   1. `--tokenize`（**只跑一次**）：把 style.css 里每个色值替换成 `var(--c-xxx)`，
 *      并把「token → 原始色值」写进 `src/themes.css` 的 `:root`。默认风格因此逐像素不变。
 *   2. 默认模式（可反复跑）：读 `src/themes.css` 的 `:root` 里那份原始色值，
 *      用 HSL 规则派生出每套风格的 `html[data-theme=...]` 覆盖块，追加手工微调表。
 *
 * 为什么用"自动派生 + 少量手工微调"：色值太多没法逐个手调，但纯算法又分不清
 * "白底卡片"和"深色按钮上的白字"这类语义差异，所以关键色另有一张手工表（OVERRIDES）。
 *
 * 用法：
 *   node scripts/theme-gen.mjs --tokenize   # 一次性：改写 style.css（会自动备份）
 *   node scripts/theme-gen.mjs              # 之后：只重新生成 themes.css 的风格块
 *   node scripts/theme-gen.mjs --check      # 只校验，不写文件
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STYLE = path.join(project, "src/style.css");
const THEMES_FILE = path.join(project, "src/themes.css");
const LIST_FILE = path.join(project, "src/theme-list.ts");

/* ------------------------------------------------------------------ 颜色工具 */

function parseColor(raw) {
  const s = String(raw).trim().toLowerCase();
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  const m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex({ r, g, b, a }) {
  const f = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  const base = "#" + f(r) + f(g) + f(b);
  return a === undefined || a >= 0.999 ? base : base + f(a * 255);
}

function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb({ h, s, l }) {
  const H = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(H / 60) % 6;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return { r: (t[0] + m) * 255, g: (t[1] + m) * 255, b: (t[2] + m) * 255 };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* --------------------------------------------------------------- 语义色保护 */

/** 这些色值承载语义（素材类型、危险、成功、离线…），任何风格都不许改色相，否则界面会失去含义。 */
export const PROTECTED = new Set([
  "#b48438", "#498477", "#bd8153", "#5385af", // 音乐/音效/照片/视频 四类图标色
  "#fbf5e8", "#f0e8d7", "#fbf1e9", "#efe3d9", "#edf4f9", "#dce7ef", // 四类的浅底与描边
  "#ac823b", "#b47e52", "#5985aa", // 四类的小字色
  "#b3261e", "#c0392b", "#d32f2f", "#e05c4a", "#fdecea", "#fbe9e7", // 危险/删除/错误
  "#1f7a4d", "#2e7d5b", "#e6f4ec", // 成功
  "#8a6d1f", "#fdf6e3", // 提醒
]);

/* ------------------------------------------------------------ 风格定义与变换 */

/**
 * 每套风格的派生规则：
 *  - hue：`null` = 保留原色相；数字 = 把"品牌绿"（156°）映射到该角度，其余色相同比压缩，保住相对关系
 *  - sat：饱和度系数
 *  - mode：light / dark（dark 走分段亮度映射，保证"浅底深字"变成"深底浅字"）
 *  - scheme：写入 color-scheme，让滚动条、原生控件跟随
 */
export const THEMES = [
  { id: "forest", name: "森林绿", desc: "默认配色，清爽耐看", swatch: ["#356451", "#f7f9fa", "#24292c"], mode: "light", hue: null, sat: 1, scheme: "light", builtin: true },
  { id: "dark", name: "深色", desc: "暗色界面，夜间不刺眼", swatch: ["#6cc39a", "#15191b", "#e6ecea"], mode: "dark", hue: null, sat: 0.85, scheme: "dark" },
  { id: "midnight", name: "午夜蓝", desc: "深蓝底色，冷调夜用", swatch: ["#63a9e8", "#0f151d", "#e2e9f2"], mode: "dark", hue: 212, sat: 0.8, scheme: "dark" },
  { id: "sepia", name: "暖褐纸质", desc: "米黄纸感，久看舒服", swatch: ["#8a6a3a", "#faf6ee", "#33291d"], mode: "light", hue: 32, sat: 0.55, scheme: "light" },
  { id: "graphite", name: "极简灰白", desc: "去色处理，专注内容", swatch: ["#4a4a4a", "#f6f6f6", "#242424"], mode: "light", hue: null, sat: 0, scheme: "light" },
  { id: "ocean", name: "海洋青", desc: "青蓝点缀，明亮通透", swatch: ["#1f7d8c", "#f2f9fa", "#1d2c2f"], mode: "light", hue: 196, sat: 0.9, scheme: "light" },
];

/** 亮度分段映射：浅色风格直接照抄原值；深色风格把亮度"折叠"到深色界面该有的区间。 */
function mapLightness(l, mode) {
  if (mode !== "dark") return l;
  if (l >= 0.5) {
    // 浅色区（背景/描边/浅底）：压到 0.30 以下，越白越暗 —— 但底线 > 0，避免死黑一片
    return clamp(0.30 - (l - 0.5) * 0.42, 0.055, 0.30);
  }
  // 深色区（文字/强调色）：抬到 0.52 以上
  return clamp(0.52 + (0.5 - l) * 0.95, 0.52, 0.99);
}

export function derive(base, theme) {
  const rgb = parseColor(base);
  if (!rgb) return base;
  const hsl = rgbToHsl(rgb);
  const protectedColor = PROTECTED.has(String(base).toLowerCase());

  let h = hsl.h;
  if (theme.hue !== null && !protectedColor && hsl.s > 0.02) {
    // 以品牌绿 156° 为锚点做同比压缩，保住配色内部的相对色相关系
    h = theme.hue + (hsl.h - 156) * 0.35;
  }
  let s = hsl.s * theme.sat;
  if (theme.sat === 0 && protectedColor) s = hsl.s; // 去色风格下语义色仍需保留色相
  const l = mapLightness(hsl.l, theme.mode);
  const out = hslToRgb({ h, s, l });
  return toHex({ ...out, a: rgb.a });
}

/* ------------------------------------------------------------------ token 命名 */

function tokenForHex(hex) {
  return "--c-" + hex.replace("#", "").toLowerCase();
}

/* ------------------------------------------------------------ 一次性：token 化 */

/** 把 style.css 里的色值换成 var(--c-*)，返回 { css, tokens }。 */
export function tokenize(css) {
  const tokens = new Map(); // token -> 原始字面量
  // 注释先摘出来，避免把注释里的颜色也换掉（还原时按原样放回）
  const comments = [];
  let work = css.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    comments.push(m);
    return `\u0000COMMENT${comments.length - 1}\u0000`;
  });

  work = work.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => {
    const token = tokenForHex(hex.toLowerCase());
    if (!tokens.has(token)) tokens.set(token, hex.toLowerCase());
    return `var(${token})`;
  });

  // `white` 按所在属性区分：color/fill/stroke = 前景（按钮上的白字），其余 = 底色
  work = work.replace(/([-a-zA-Z]+)(\s*:\s*)([^;{}]+)/g, (whole, prop, sep, value) => {
    if (!/\bwhite\b/.test(value)) return whole;
    const isForeground = /^(color|fill|stroke|caret-color)$/i.test(prop);
    const token = isForeground ? "--c-white-fg" : "--c-white-bg";
    if (!tokens.has(token)) tokens.set(token, "#ffffff");
    return prop + sep + value.replace(/\bwhite\b/g, `var(${token})`);
  });

  work = work.replace(/\u0000COMMENT(\d+)\u0000/g, (_, i) => comments[Number(i)]);
  return { css: work, tokens };
}

/* --------------------------------------------------- 反复跑：生成 themes.css */

/** 从已有 themes.css 的 :root 块里读回「token → 原始色值」。 */
export function readBaseTokens(css) {
  const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!rootBlock) return new Map();
  const out = new Map();
  for (const line of rootBlock[1].split("\n")) {
    const m = /^\s*(--c-[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function base(theme) {
  return `/* 由 scripts/theme-gen.mjs 生成，请勿手改：改风格请改该脚本的 THEMES / OVERRIDES 后重新运行。 */

/* 1) 原始色值：默认风格（森林绿）逐像素等价于改造前的界面 */
:root {
  color-scheme: light;
${[...tokens].map(([k, v]) => `  ${k}: ${v};`).join("\n")}
}

/* 2) 每套风格：只覆盖 token，所有 var(--c-*) 引用会自动跟随 */
`;
}

function themeBlock(theme) {
  const overrides = OVERRIDES[theme.id] ?? {};
  // 手工微调过的 token 不再出现在自动派生列表里：CSS 后声明优先，否则微调会被覆盖。
  const lines = [...tokens]
    .filter(([k]) => !(k in overrides))
    .map(([k, v]) => `  ${k}: ${derive(v, theme)};`);
  const tune = Object.entries(overrides)
    .filter(([k]) => tokens.has(k))
    .map(([k, v]) => `  ${k}: ${v};`);
  const head = `html[data-theme="${theme.id}"] {`;
  return [
    `/* ${theme.name} —— ${theme.desc} */`,
    head,
    `  color-scheme: ${theme.scheme};`,
    ...(tune.length ? ["  /* 手工微调：自动派生分不清角色，这几处按语义钉死 */", ...tune] : []),
    ...lines,
    `}`,
  ].join("\n");
}

/* --------------------------------------------------------------- 手工微调表 */

/**
 * key = token 名，value = 该风格下的取值。
 * 只放"自动派生一定做错"的角色：页面底色、卡片底色、正文/次要文字、描边、强调色。
 * 其余 500 个 token 全部交给 derive()。
 */
export const OVERRIDES = {
  dark: {
    "--c-white-bg": "#1d2325",
    "--c-fff": "#1d2325",
    "--c-ffffff": "#1d2325",
    "--c-f7f9fa": "#141819",
    "--c-f4f7f6": "#20272a",
    "--c-f8faf9": "#1a2022",
    "--c-e5e9e6": "#2c3538",
    "--c-d9e2dd": "#2c3538",
    "--c-edf3ef": "#232b2d",
    "--c-24292c": "#e7ecea",
    "--c-748179": "#95a29c",
    "--c-356451": "#6cc39a",
    "--c-315d4b": "#8ad4b0",
    "--c-white-fg": "#0d1a15",
  },
  midnight: {
    "--c-white-bg": "#161c26",
    "--c-fff": "#161c26",
    "--c-ffffff": "#161c26",
    "--c-f7f9fa": "#0f151d",
    "--c-f4f7f6": "#1a2130",
    "--c-f8faf9": "#141b24",
    "--c-e5e9e6": "#26303f",
    "--c-d9e2dd": "#26303f",
    "--c-edf3ef": "#1c2432",
    "--c-24292c": "#e4ebf5",
    "--c-748179": "#8f9db3",
    "--c-356451": "#63a9e8",
    "--c-315d4b": "#8cc4f2",
    "--c-white-fg": "#0c1420",
  },
  sepia: {
    "--c-white-bg": "#fffdf7",
    "--c-fff": "#fffdf7",
    "--c-ffffff": "#fffdf7",
    "--c-f7f9fa": "#faf6ee",
    "--c-f4f7f6": "#f4eee1",
    "--c-e5e9e6": "#e6dcc8",
    "--c-d9e2dd": "#e6dcc8",
    "--c-24292c": "#33291d",
    "--c-748179": "#8a7b64",
    "--c-356451": "#8a6a3a",
    "--c-315d4b": "#6f5530",
  },
  graphite: {
    "--c-white-bg": "#ffffff",
    "--c-fff": "#ffffff",
    "--c-ffffff": "#ffffff",
    "--c-f7f9fa": "#f6f6f6",
    "--c-f4f7f6": "#f0f0f0",
    "--c-e5e9e6": "#e4e4e4",
    "--c-d9e2dd": "#e4e4e4",
    "--c-24292c": "#242424",
    "--c-748179": "#767676",
    "--c-356451": "#4a4a4a",
    "--c-315d4b": "#2e2e2e",
  },
  ocean: {
    "--c-white-bg": "#ffffff",
    "--c-fff": "#ffffff",
    "--c-ffffff": "#ffffff",
    "--c-f7f9fa": "#f2f9fa",
    "--c-f4f7f6": "#e8f3f5",
    "--c-e5e9e6": "#d7e7ea",
    "--c-d9e2dd": "#d7e7ea",
    "--c-24292c": "#1d2c2f",
    "--c-748179": "#6b8489",
    "--c-356451": "#1f7d8c",
    "--c-315d4b": "#17606c",
  },
};

/* ---------------------------------------------------------------------- 主流程 */

let tokens = new Map();

function generateThemeCss() {
  const parts = [base()];
  for (const theme of THEMES) {
    if (theme.builtin) continue;
    parts.push(themeBlock(theme));
  }
  return parts.join("\n");
}

/** 风格清单的 TypeScript 版本：与 themes.css 同源，避免前端硬编码一份会漂移的列表。 */
function generateThemeListTs() {
  const ids = THEMES.map((t) => `"${t.id}"`).join(" | ");
  const items = THEMES.map(
    (t) =>
      `  { id: "${t.id}", name: ${JSON.stringify(t.name)}, desc: ${JSON.stringify(t.desc)}, swatch: [${t.swatch
        .map((c) => `"${c}"`)
        .join(", ")}], mode: "${t.mode}" }`,
  ).join(",\n");
  return `/* 由 scripts/theme-gen.mjs 生成，请勿手改。
   改风格请改该脚本里的 THEMES / OVERRIDES，然后运行：node scripts/theme-gen.mjs */

export type ThemeId = ${ids};

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  desc: string;
  /** 预览用的三个代表色：[强调色, 底色, 文字色] */
  swatch: [string, string, string];
  mode: "light" | "dark";
}

export const THEME_LIST: ThemeMeta[] = [
${items},
];

export const DEFAULT_THEME: ThemeId = "forest";
`;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--tokenize")) {
    const original = fs.readFileSync(STYLE, "utf8");
    const backupDir = path.join(project, "backups/source");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const backup = path.join(backupDir, `style.css.${stamp}.bak`);
    fs.writeFileSync(backup, original);
    const { css, tokens: found } = tokenize(original);
    tokens = found;
    fs.writeFileSync(STYLE, css);
    fs.writeFileSync(THEMES_FILE, generateThemeCss());
    fs.writeFileSync(LIST_FILE, generateThemeListTs());
    console.log(
      `已 token 化 ${found.size} 个色值 → src/style.css\n备份：${path.relative(project, backup)}\n风格：${THEMES.map((t) => t.name).join("、")}`,
    );
    return;
  }

  tokens = readBaseTokens(fs.readFileSync(THEMES_FILE, "utf8"));
  if (tokens.size === 0) throw new Error("themes.css 里没有 token；请先运行 node scripts/theme-gen.mjs --tokenize");
  const css = generateThemeCss();
  if (args.includes("--check")) {
    console.log(`token ${tokens.size} 个，风格 ${THEMES.length} 套，检查通过`);
    return;
  }
  fs.writeFileSync(THEMES_FILE, css);
  fs.writeFileSync(LIST_FILE, generateThemeListTs());
  console.log(`已重新生成 src/themes.css 与 src/theme-list.ts：${tokens.size} token × ${THEMES.length} 套风格`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
