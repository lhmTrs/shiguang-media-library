import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Search, Tags, Upload } from "lucide-react";
import type { LocalRequest } from "./OpenAISettings";
import "./cloud-tags-sync.css";

type Source = { authorId: string; revision: number; policyVersion: number; visibility: "PRIVATE" | "PUBLIC"; count: number };
type Candidate = { id: string; name: string; tags: string[] };
type Scope = { mode: "SELF" | "GROUP" | "MEMBER"; groupId?: string; memberId?: string };
type Cache = { sources: { authorId: string; own: boolean; items: { sha256: string; bytes: number; tags: string[] }[] }[] };
type Group = { groupId: string; name: string; canReadShared: boolean };
type Member = { accountId: string; displayName: string; state: string; accountState: string };

export function CloudTagsSync({ request, groups, accountId }: { request: LocalRequest; groups: Group[]; accountId: string }) {
  const [me, setMe] = useState<Source | null>(null), [cache, setCache] = useState<Cache>({ sources: [] });
  const [mode, setMode] = useState<Scope["mode"]>("SELF"), [group, setGroup] = useState(""), [member, setMember] = useState("");
  const [members, setMembers] = useState<Member[]>([]), [q, setQ] = useState(""), [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [page, setPage] = useState(0);
  const generation = useRef(0), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  const scope: Scope = mode === "SELF" ? { mode } : { mode, groupId: group, ...(mode === "MEMBER" ? { memberId: member } : {}) };
  const scopeKey = JSON.stringify(scope), available = mode === "SELF" || !!group && (mode !== "MEMBER" || !!member);
  async function run(fn: (current: () => boolean) => Promise<void>) {
    if (busy) return;
    const id = ++generation.current, current = () => active.current && generation.current === id;
    setBusy(true); setError(""); setNotice("");
    try { await fn(current); }
    catch (e) { if (current()) setError((e as { code?: string }).code || "标签同步未完成"); }
    finally { if (active.current) setBusy(false); }
  }
  async function sync(current: () => boolean) {
    setCache({ sources: [] });
    try {
      const own = await request<Source>("/cloud-tags/me");
      if (current()) setMe(own);
      const result = await request<Cache & { deferred: { authorId: string; code: string }[] }>("/cloud-tags/sync", scope);
      if (current()) { setCache(result); setNotice(result.deferred.length ? `${result.deferred.length} 位成员待重试` : "同步完成"); }
    } catch (error) {
      try { const cached = await request<Cache>(`/cloud-tags/cache?${new URLSearchParams(scope).toString()}`); if (current()) setCache(cached); } catch { if (current()) setCache({ sources: [] }); }
      throw error;
    }
  }
  useEffect(() => {
    const readGeneration = ++generation.current;
    setCache({ sources: [] }); setPage(0); setError(""); setNotice("");
    if (!available) return;
    let live = true;
    void request<Cache>(`/cloud-tags/cache?${new URLSearchParams(scope).toString()}`).then(value => { if (live && generation.current === readGeneration) setCache(value); }).catch(() => {});
    return () => { live = false; };
  }, [scopeKey, request, available]);
  useEffect(() => { let live = true; void request<Source>("/cloud-tags/me").then(s => { if (live) setMe(s); }).catch(e => { if (live) setError(e.code || "标签服务未就绪"); }); return () => { live = false; }; }, [request]);
  useEffect(() => {
    setMember(""); setMembers([]); if (!group || mode !== "MEMBER") return;
    let live = true;
    void (async () => {
      const items: Member[] = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const batch = await request<Member[]>(`/cloud-management/groups/${encodeURIComponent(group)}/members?limit=100&offset=${offset}`);
        if (!live) return; items.push(...batch); if (batch.length < 100) break;
      }
      if (live) setMembers(items.filter(m => m.accountId !== accountId && m.state === "ACTIVE" && (!m.accountState || m.accountState === "ACTIVE")));
    })().catch(e => { if (live) setError(e.code || "读取成员失败"); });
    return () => { live = false; };
  }, [group, mode, request, accountId]);
  const candidate = candidates.find(c => c.id === selected);
  const total = cache.sources.reduce((n, s) => n + s.items.length, 0), currentPage = Math.min(page, Math.max(0, Math.ceil(total / 60) - 1));
  const visible = useMemo(() => {
    const rows: { source: Cache["sources"][number]; entry: Cache["sources"][number]["items"][number] }[] = [];
    let index = 0;
    for (const source of cache.sources) for (const entry of source.items) {
      if (index++ >= currentPage * 60) rows.push({ source, entry }); if (rows.length === 60) return rows;
    }
    return rows;
  }, [cache, currentPage]);
  return <section className="cw-panel ct-panel">
    <div className="ct-heading"><h2><Tags size={18} /> 标签同步</h2><button type="button" className="plain" disabled={busy || !available || !me} onClick={() => void run(sync)}><RefreshCw size={15} /> 同步</button></div>
    {error && <div role="alert" className="cw-error">{error}</div>}
    {notice && <div role="status">{notice}</div>}
    <div className="ct-toolbar">
      <label><input type="checkbox" checked={me?.visibility === "PUBLIC"} disabled={!me || busy} onChange={e => {
        const visibility = e.target.checked ? "PUBLIC" : "PRIVATE";
        if (visibility === "PUBLIC" && !window.confirm("公开当前及以后同步的全部标签给同组成员？")) return;
        void run(async current => { const result = await request<Source>("/cloud-tags/policy", { visibility, expectedPolicyVersion: me!.policyVersion }, "PUT"); if (current()) setMe(result); });
      }} />公开我的全部标签</label>
      {me && <span className="muted">标签版本 {me.revision} · 共享版本 {me.policyVersion}</span>}
    </div>
    <div className="ct-toolbar ct-scope">
      <select aria-label="标签查看范围" value={mode} disabled={busy} onChange={e => setMode(e.target.value as Scope["mode"])}>
        <option value="SELF">个人</option><option value="GROUP">所有组员</option><option value="MEMBER">个人 + 指定成员</option>
      </select>
      {mode !== "SELF" && <select aria-label="标签小组" value={group} disabled={busy} onChange={e => setGroup(e.target.value)}><option value="">选择小组</option>{groups.filter(g => g.canReadShared).map(g => <option key={g.groupId} value={g.groupId}>{g.name}</option>)}</select>}
      {mode === "MEMBER" && <select aria-label="指定成员" value={member} disabled={busy} onChange={e => setMember(e.target.value)}><option value="">选择成员</option>{members.map(m => <option key={m.accountId} value={m.accountId}>{m.displayName || m.accountId}</option>)}</select>}
    </div>
    <div className="ct-toolbar ct-publish">
      <input aria-label="查找本地音频" value={q} onChange={e => setQ(e.target.value)} placeholder="本地音频名称" />
      <button type="button" className="plain" disabled={busy} onClick={() => void run(async current => { const items = await request<Candidate[]>(`/cloud-tags/candidates?q=${encodeURIComponent(q)}`); if (current()) { setCandidates(items); setSelected(""); } })}><Search size={15} />查找</button>
      <select aria-label="待同步素材" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}><option value="">选择素材</option>{candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <button type="button" disabled={busy || !candidate || !me} onClick={() => void run(async current => {
        if (!candidate!.tags.length && !window.confirm("清除此内容在云端属于你的标签关联？")) return;
        const result = await request<Source>("/cloud-tags/publish", { assetId: candidate!.id, expectedRevision: me!.revision, expectedPolicyVersion: me!.policyVersion });
        if (current()) { setMe(result); await sync(current); }
      })}><Upload size={15} />同步此素材标签</button>
    </div>
    {candidate && <div>{candidate.tags.join(" · ") || "无标签"}</div>}
    <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>内容摘要</th><th>标签</th><th>来源</th></tr></thead><tbody>
      {visible.map(({source: s, entry: e}) => <tr key={`${s.authorId}:${e.sha256}:${e.bytes}`}><td title={e.sha256}>{e.sha256.slice(0, 16)} · {e.bytes} B</td><td style={{ opacity: s.own ? 1 : 0.65 }}>{e.tags.join(" · ")}</td><td>{s.own ? "自己" : s.authorId}</td></tr>)}
    </tbody></table></div>
    <div className="ct-heading"><span>{total} 条记录</span><div className="ct-toolbar"><button className="plain" aria-label="上一页标签" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15} /></button><span>{total ? currentPage + 1 : 0} / {Math.ceil(total / 60)}</span><button className="plain" aria-label="下一页标签" disabled={(currentPage + 1) * 60 >= total} onClick={() => setPage(currentPage + 1)}><ChevronRight size={15} /></button></div></div>
  </section>;
}
