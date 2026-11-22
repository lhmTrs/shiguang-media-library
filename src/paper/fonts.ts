// 「新样子（试用）」的宋体（Noto Serif SC 500/600，见 scripts/paper-fonts.mjs）。
// 这个模块只由 trial.ts 在开关打开时动态 import，Vite 会把它和它的样式拆成单独一块：开关关着时不下载、不声明这套字体。
import './noto-serif-sc.css';
