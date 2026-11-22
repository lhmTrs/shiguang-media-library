// 界面上跟系统有关的字（Windows 原生运行设计 v1 第 4 节词表）。
// - 「访达 / 废纸篓 / Mac」跟**服务端**系统走：读 GET /api/session 的 platform；没有这个字段（旧后台）时当 darwin。
// - 按键提示（⌘ ⌥ ⇧）跟**浏览器**所在系统走：非 Mac 浏览器显示 Ctrl / Alt / Shift。
// Mac 列就是原来写死的字，逐字不变；改用词要和服务端一起改（设计第 3 节合同）。
import {useSyncExternalStore} from 'react';

export type PlatformWords = {
  /** 访达 / 资源管理器 / 文件管理器 */
  fileManager: string;
  /** 在访达中显示 / 在文件夹中显示 */
  reveal: string;
  /** 访达次数 / 定位次数 */
  revealCount: string;
  /** 「访达 3 次」里的「访达」/「定位」 */
  revealTimes: string;
  /** 访达打开次数 / 定位次数（列表悬停说明） */
  revealOpenCount: string;
  /** 打开访达所在位置 / 打开文件所在的位置 */
  openLocation: string;
  /** 可在访达中打开 / 可在资源管理器中打开 */
  openFallback: string;
  /** 在访达里（改名、挪走、放进来）/ 在资源管理器里 */
  editOutside: string;
  /** 废纸篓 / 回收站 */
  trash: string;
  /** 系统废纸篓 / 系统回收站 */
  systemTrash: string;
  /** 这台 Mac / 这台电脑 */
  thisMac: string;
  /** Mac 原生组件 / 系统组件 */
  macNative: string;
};

const MAC: PlatformWords = {
  fileManager: '访达', reveal: '在访达中显示', revealCount: '访达次数', revealTimes: '访达', revealOpenCount: '访达打开次数', openLocation: '打开访达所在位置',
  openFallback: '可在访达中打开', editOutside: '在访达里', trash: '废纸篓', systemTrash: '系统废纸篓',
  thisMac: '这台 Mac', macNative: 'Mac 原生组件',
};
const WINDOWS: PlatformWords = {
  fileManager: '资源管理器', reveal: '在文件夹中显示', revealCount: '定位次数', revealTimes: '定位', revealOpenCount: '定位次数', openLocation: '打开文件所在的位置',
  openFallback: '可在资源管理器中打开', editOutside: '在资源管理器里', trash: '回收站', systemTrash: '系统回收站',
  thisMac: '这台电脑', macNative: '系统组件',
};
const LINUX: PlatformWords = {...WINDOWS, fileManager: '文件管理器', openFallback: '可在文件管理器中打开', editOutside: '在文件管理器里'};

export function wordsFor(platform: string): PlatformWords {
  return platform === 'darwin' ? MAC : platform === 'win32' ? WINDOWS : LINUX;
}

let serverPlatform = 'darwin';
const listeners = new Set<() => void>();
/** 收到 /api/session 后调用；不是非空字符串（旧后台没有这个字段）时按 darwin。 */
export function setServerPlatform(value: unknown) {
  const next = typeof value === 'string' && value ? value : 'darwin';
  if (next === serverPlatform) return;
  serverPlatform = next;
  for (const listener of listeners) listener();
}
export const getServerPlatform = () => serverPlatform;
export const serverIsMac = () => serverPlatform === 'darwin';
/** 不在 React 组件里时用；组件里用 usePlatformWords()，平台读到后会重新渲染。 */
export const platformWords = () => wordsFor(serverPlatform);
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useServerPlatform() { return useSyncExternalStore(subscribe, getServerPlatform, getServerPlatform); }
export function usePlatformWords() { return wordsFor(useServerPlatform()); }

// ---- 按键提示：跟浏览器 ----
export const browserIsMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const MAC_KEYS: Record<string, string> = {mod: '⌘', alt: '⌥', shift: '⇧'};
const PC_KEYS: Record<string, string> = {mod: 'Ctrl', alt: 'Alt', shift: 'Shift'};
/** shortcut('mod', 'V') → Mac「⌘V」，其他「Ctrl+V」；shortcut('mod', 'alt', 'V') →「⌘⌥V」/「Ctrl+Alt+V」。 */
export function shortcut(...keys: string[]) {
  const mac = browserIsMac(), table = mac ? MAC_KEYS : PC_KEYS;
  return keys.map(k => table[k] ?? k).join(mac ? '' : '+');
}
/** 单独的修饰键名：Mac「⌘」，其他「Ctrl」。 */
export const modKey = () => (browserIsMac() ? MAC_KEYS : PC_KEYS).mod;

// ---- 粘贴进来的路径 ----
/** 去掉首尾空白和首尾成对的引号：Windows「复制为路径」会带双引号（"D:\素材\音乐"）。两边都对的修正，不分系统。
 *  引号里面的字一个不动：目录名可以以空格开头或结尾（「所选目录 」和「所选目录」是两个目录），trim 掉就会选到另一个。 */
export function pastedPath(value: string) {
  const text = value.trim();
  return text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0] ? text.slice(1, -1) : text;
}
/** 按钮能不能点：去掉引号后还有非空白字符。只管禁用，不改要提交的路径。 */
export const hasPastedPath = (value: string) => !!pastedPath(value).trim();
