import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CornerDownLeft } from "lucide-react";

export function PaginationControls({ page, pages, change, disabled = false, label = "素材分页" }: {
  page: number; pages: number; change: (page: number) => void; disabled?: boolean; label?: string;
}) {
  const [jump, setJump] = useState("");
  useEffect(() => setJump(""), [page]);
  const jumpValid = Number.isInteger(Number(jump)) && Number(jump) >= 1 && Number(jump) <= pages;
  const numbers = [...new Set([1, pages, ...Array.from({length: 5}, (_, i) => Math.max(1, Math.min(page - 2, pages - 4)) + i)])].filter(n => n >= 1 && n <= pages).sort((a,b) => a-b);
  return <nav className="page-controls" aria-label={label}>
    <div className="page-strip">
    <button className="icon-button" aria-label={`${label}：上一页`} disabled={disabled || page <= 1 || !pages} onClick={() => change(page - 1)}><ChevronLeft size={16}/></button>
    {numbers.map((n, index) => <span className="page-number-slot" key={n}>
      {index > 0 && n - numbers[index-1] > 1 && <span className="page-ellipsis" aria-hidden="true">…</span>}
      <button className="page-number" aria-label={`第 ${n} 页`} aria-current={page === n ? "page" : undefined} disabled={disabled} onClick={() => change(n)}>{n}</button>
    </span>)}
    {!pages && <span className="page-empty">0 / 0</span>}
    <button className="icon-button" aria-label={`${label}：下一页`} disabled={disabled || page >= pages || !pages} onClick={() => change(page + 1)}><ChevronRight size={16}/></button>
    </div>
    {pages > 7 && <form className="page-jump" onSubmit={event => { event.preventDefault(); const n = Number(jump); if (Number.isInteger(n) && n >= 1 && n <= pages) { change(n); setJump(""); } }}>
      <span>跳至</span><div className="page-jump-field"><input type="number" placeholder="页码" aria-label={`${label}：跳转页码`} min={1} max={pages} step={1} value={jump} disabled={disabled} onChange={e => setJump(e.target.value)}/>
      <button className="icon-button" title="确认跳转" aria-label={`${label}：确认跳转`} disabled={disabled || !jumpValid}><CornerDownLeft size={14}/></button></div>
    </form>}
  </nav>;
}
