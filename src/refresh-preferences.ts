export const REFRESH_STORAGE_KEY = "shiguang.refreshSeconds";
export const REFRESH_INTERVALS = [
  { seconds: 0, label: "关闭" },
  { seconds: 15, label: "15 秒" },
  { seconds: 30, label: "30 秒" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 120, label: "2 分钟" },
  { seconds: 300, label: "5 分钟" },
];

export function readRefreshSeconds(): number {
  try {
    const saved = localStorage.getItem(REFRESH_STORAGE_KEY);
    if (saved !== null) {
      const value = Number(saved);
      if (saved.trim() && REFRESH_INTERVALS.some(option => option.seconds === value)) return value;
    }
  } catch {}
  return 30;
}
