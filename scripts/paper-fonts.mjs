#!/usr/bin/env node
/**
 * 「新样子（试用）」的宋体：从 @fontsource/noto-serif-sc 生成 src/paper/noto-serif-sc.css。
 *
 * - 只要 500、600 两个字重（素材名、标题）；按字符分片（unicode-range），页面上用到哪片才下载哪片。
 * - 只引用 woff2，不带 woff 备用格式：现在的浏览器都认 woff2，带上 woff 会让 dist 多一倍（约 21MB → 9MB）。
 * - 这份样式只在试用开关打开时由 src/paper/fonts.ts 动态加载；开关关着时不发任何字体请求。
 *
 * 用法：
 *   node scripts/paper-fonts.mjs          # 重新生成
 *   node scripts/paper-fonts.mjs --check  # 只校验生成结果和仓库里的一致
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = path.join(project, "node_modules/@fontsource/noto-serif-sc");
const OUT = path.join(project, "src/paper/noto-serif-sc.css");
const WEIGHTS = [500, 600];

export function generate() {
  const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
  const blocks = [];
  for (const weight of WEIGHTS) {
    const css = fs.readFileSync(path.join(pkg, `${weight}.css`), "utf8");
    for (const [block] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      const src = /src:\s*url\(\.\/files\/([^)]+\.woff2)\)\s*format\('woff2'\)[^;]*;/.exec(block);
      if (!src) throw Error(`${weight}.css 里有一块没有 woff2：${block.slice(0, 120)}`);
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1].trim();
      if (!range) throw Error(`${weight}.css 里有一块没有 unicode-range：${src[1]}`);
      blocks.push(`@font-face{font-family:'Noto Serif SC';font-style:normal;font-display:swap;font-weight:${weight};src:url(../../node_modules/@fontsource/noto-serif-sc/files/${src[1]}) format('woff2');unicode-range:${range}}`);
    }
  }
  if (blocks.length < 2 * 100) throw Error("分片数量不对：" + blocks.length);
  return `/* 由 scripts/paper-fonts.mjs 从 @fontsource/noto-serif-sc ${version} 生成，请勿手改。字体许可：SIL Open Font License 1.1。
   只在「新样子（试用）」打开时加载（src/paper/fonts.ts）；${WEIGHTS.join("、")} 两个字重、只引用 woff2，按 unicode-range 分片，用到才下载。 */
${blocks.join("\n")}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const css = generate();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (current !== css) { console.error("src/paper/noto-serif-sc.css 与生成结果不一致：请运行 node scripts/paper-fonts.mjs"); process.exitCode = 1; }
    else console.log(`字体样式检查通过：${css.split("\n").length - 3} 个分片`);
  } else {
    fs.writeFileSync(OUT, css);
    console.log(`已生成 src/paper/noto-serif-sc.css：${css.split("\n").length - 3} 个分片`);
  }
}
