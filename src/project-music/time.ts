// 项目音乐页的时间一律按北京时间显示，格式 YYYY-MM-DD HH:mm（与 AI 记录的「原话时间」同一格式）。
// 拾光其他页面同样按 Asia/Shanghai 显示；接口里存的仍是 UTC 毫秒。
const parts = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function beijingTime(ms: number) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
