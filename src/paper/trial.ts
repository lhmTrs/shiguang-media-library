// 「新样子（试用）」开关：纸本配色、宋体标题、侧栏一次只开一组、顶栏合并后台任务。
// 选择只记在本浏览器（照项目音乐「新画风试用：配色」的做法），不写数据库。
// 打开时在 <html> 上加 data-sg-paper="on"：试用配色（themes.css 末尾那一块）和 src/paper/paper.css 只认这个属性，
// 所以关掉时一条规则都不生效，现有界面和 6 套主题不变。定稿后换成正式主题，这个开关随之去掉。
import {useEffect, useLayoutEffect, useState} from 'react';

export const PAPER_TRIAL_KEY = 'shiguang.paperTrial.v1';

export function readPaperTrial(): boolean {
  try { return localStorage.getItem(PAPER_TRIAL_KEY) === 'on'; } catch { return false; }
}

export function applyPaperTrial(on: boolean) {
  const root = document.documentElement;
  if (on) root.dataset.sgPaper = 'on';
  else delete root.dataset.sgPaper;
}

export function usePaperTrial(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readPaperTrial);
  useLayoutEffect(() => {
    applyPaperTrial(on);
    // 打包的宋体只在打开时才加载；加载失败时字体栈回落到系统宋体（Songti SC），界面照常。
    if (on) void import('./fonts').catch(() => {});
  }, [on]);
  useEffect(() => {
    try { if (on) localStorage.setItem(PAPER_TRIAL_KEY, 'on'); else localStorage.removeItem(PAPER_TRIAL_KEY); } catch { /* 存不下就只在本次页面生效 */ }
  }, [on]);
  useEffect(() => {
    // 另一个标签页切换时跟着变，免得两个页面一新一旧。
    const storage = (e: StorageEvent) => { if (e.key === PAPER_TRIAL_KEY || e.key === null) setOn(readPaperTrial()); };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, []);
  return [on, setOn];
}
