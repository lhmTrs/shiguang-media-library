// 「新画风试用：配色」：只在本浏览器记住，不写数据库。试点专用，全库推广时换成正式主题后去掉。
import {useEffect, useState} from 'react';

export type Palette = 'follow' | 'paper' | 'studio' | 'gallery';
export const PALETTES: {id: Palette; name: string}[] = [
  {id: 'follow', name: '跟随主题'},
  {id: 'paper', name: '纸张'},
  {id: 'studio', name: '工作室'},
  {id: 'gallery', name: '画廊'},
];
const KEY = 'shiguang.musicPalette.v1';
const valid = (v: unknown): v is Palette => PALETTES.some(p => p.id === v);

export function readPalette(): Palette {
  try {
    const v = localStorage.getItem(KEY);
    return valid(v) ? v : 'follow';
  } catch {
    return 'follow';
  }
}

export function usePalette(): [Palette, (p: Palette) => void] {
  const [palette, setPalette] = useState<Palette>(readPalette);
  useEffect(() => {
    try { localStorage.setItem(KEY, palette); } catch { /* 存不下就只在本次页面生效 */ }
  }, [palette]);
  return [palette, setPalette];
}
