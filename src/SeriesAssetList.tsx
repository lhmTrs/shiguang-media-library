import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import type { Asset } from "./main";
import { PaginationControls } from "./PaginationControls";

export type AssetSeries = { key: string; name: string; count: number; firstId: string };
type Members = { items: Asset[]; total: number; page: number; pages: number };
type Props = {
  groups: AssetSeries[]; assets: Asset[]; query: string; revision: string;
  request: <T>(url: string) => Promise<T>;
  renderAsset: (asset: Asset) => React.ReactNode;
  onVisible: (items: Asset[]) => void;
  focus: { key: string; assetId: string } | null;
};

function SeriesMembers({ group, query, revision, request, renderAsset, onLoaded, focusId }: {
  group: AssetSeries; query: string; revision: string; request: Props["request"];
  renderAsset: Props["renderAsset"]; onLoaded: (key: string, items: Asset[]) => void; focusId?: string;
}) {
  const [page, setPage] = useState(1), [data, setData] = useState<Members | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [focusPage, setFocusPage] = useState(focusId);
  useEffect(() => { setFocusPage(focusId); }, [focusId]);
  useEffect(() => {
    let live = true;
    setBusy(true); setError(""); onLoaded(group.key, []);
    const params = new URLSearchParams(query);
    params.set("seriesKey", group.key); params.set("memberPage", String(page));
    if (focusPage) params.set("focusId", focusPage);
    request<Members>("/asset-series/members?" + params).then(value => {
      if (!live) return;
      setData(value); onLoaded(group.key, value.items);
    }).catch(reason => { if (live) { setData(null); setError(reason instanceof Error ? reason.message : "系列读取失败"); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [query, group.key, revision, page, focusPage, retry, request, onLoaded]);
  return <div className="series-members" aria-busy={busy}>
    {busy ? <div className="series-feedback" role="status"><LoaderCircle size={16} className="spin"/>读取系列…</div>
      : error ? <div className="series-feedback" role="alert">{error}<button className="text-button" onClick={() => setRetry(n => n + 1)}><RefreshCw size={14}/>重试</button></div>
      : <>{data?.items.map(renderAsset)}{data && data.pages > 1 && <div className="series-pagination">
        <span>{data.total} 个素材</span>
        <PaginationControls label={`${group.name}系列分页`} page={data.page} pages={data.pages} disabled={busy} change={next => { setFocusPage(undefined); setPage(next); }}/>
      </div>}</>}
  </div>;
}

export function SeriesAssetList({ groups, assets, query, revision, request, renderAsset, onVisible, focus }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Record<string, Asset[]>>({});
  const onLoaded = React.useCallback((key: string, items: Asset[]) => setLoaded(previous => ({...previous, [key]: items})), []);
  useEffect(() => { if (focus) setExpanded(previous => new Set([...previous, focus.key])); }, [focus]);
  const visible = useMemo(() => groups.flatMap(group => group.count === 1 ? assets.filter(asset => asset.id === group.firstId) : expanded.has(group.key) ? loaded[group.key] || [] : []), [groups, assets, expanded, loaded]);
  useEffect(() => { onVisible(visible); }, [visible, onVisible]);
  return <>{groups.map(group => {
    if (group.count === 1) { const asset = assets.find(item => item.id === group.firstId); return asset ? renderAsset(asset) : null; }
    const open = expanded.has(group.key), panelId = "series-" + group.key;
    return <section className="asset-series" key={group.key}>
      <button className="series-heading" aria-expanded={open} aria-controls={panelId} onClick={() => setExpanded(previous => { const next = new Set(previous); next.has(group.key) ? next.delete(group.key) : next.add(group.key); return next; })}>
        {open ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}<FolderOpen size={19}/><strong>{group.name}</strong><span>{group.count.toLocaleString()} 个素材</span>
      </button>
      <div id={panelId} hidden={!open}>{open && <SeriesMembers group={group} query={query} revision={revision} request={request} renderAsset={renderAsset} onLoaded={onLoaded} focusId={focus?.key === group.key ? focus.assetId : undefined}/>}</div>
    </section>;
  })}</>;
}
