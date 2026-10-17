import { Search, X } from "lucide-react";
import { searchTerms, joinSearchTerms } from "../server/search-query.mjs";

export type SearchMode = "all" | "any";
export { searchTerms, joinSearchTerms };

export function KeywordSearch({ value, change, mode, changeMode }: {
  value: string; change: (value: string) => void; mode: SearchMode; changeMode: (mode: SearchMode) => void;
}) {
  return <div className="search keyword-search" role="search">
    <Search size={18}/>
    <input aria-label="搜索素材" placeholder="搜索名称、标签或备注" maxLength={2000} value={value} onChange={e => change(e.target.value)}/>
    {value && <button className="icon-button" title="清空搜索" aria-label="清空搜索" onClick={() => change("")}><X size={16}/></button>}
    <select className="keyword-match-mode" aria-label="关键词匹配方式" value={mode} onChange={e => changeMode(e.target.value as SearchMode)}>
      <option value="all">同时匹配</option><option value="any">任一匹配</option>
    </select>
  </div>;
}

export function KeywordTokens({ value, change, mode }: { value: string; change: (value: string) => void; mode: SearchMode }) {
  const terms = searchTerms(value);
  return <>{terms.length > 1 && <span className="keyword-match-label">{mode === "any" ? "任一" : "同时"}</span>}{terms.map((term, index) => <span className="filter-token" key={term}>
    <Search size={13}/><span className="keyword-token-text">{term}</span>
    <button className="icon-button" title={`移除关键词：${term}`} aria-label={`移除关键词：${term}`} onClick={() => change(joinSearchTerms(terms.filter((_, i) => i !== index)))}><X size={14}/></button>
  </span>)}</>;
}
