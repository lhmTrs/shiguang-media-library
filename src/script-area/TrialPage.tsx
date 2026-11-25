// 泳道图试画页（给 agent 用，人也能用）：#/script-map-trial?project=…&target=kind:id[&before=kind:id][&open=节点id]
// 选一个 JSON → 同页调 POST …/maps/dry-run → 成功画图并列出提醒；422 列出问题并清掉旧图。只在页面内存，不保存。
// 给无头浏览器判断状态：根节点 data-trial-state（idle|checking|ok|invalid|error），以及 window.__SCRIPT_MAP_TRIAL__。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { asRequestError, errorText, parseRef, refParam, scriptBase } from './api';
import { CausalMap } from './CausalMap';
import { IssueList } from './IssueList';
import { allObjects, loadObjects, objectLabel, type ScriptObjects } from './objects';
import type { Binding, Issue, MapGraph, ObjectRef, RenderData, ScriptRequest } from './types';
import { buildTree, displayPath, type GroupedProject, type Series } from '../series/model';
import './script-area.css';

export const TRIAL_HASH = '#/script-map-trial';
export const isTrialHash = (hash: string) => hash === TRIAL_HASH || hash.startsWith(TRIAL_HASH + '?');
export function trialHref(projectId: string, target?: ObjectRef | null, before?: ObjectRef | null) {
  const q = new URLSearchParams({ project: projectId }); if (target) q.set('target', refParam(target)); if (before) q.set('before', refParam(before));
  return '/' + TRIAL_HASH + '?' + q.toString();
}
type State = 'idle' | 'checking' | 'ok' | 'invalid' | 'error';
type Params = { project: string; target: string; before: string; open: string };
const readParams = (): Params => {
  const q = new URLSearchParams(location.hash.slice(TRIAL_HASH.length).replace(/^\?/, ''));
  return { project: q.get('project') ?? '', target: q.get('target') ?? '', before: q.get('before') ?? '', open: q.get('open') ?? '' };
};
const writeParams = (p: Params) => {
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  history.replaceState(history.state, '', TRIAL_HASH + (q.toString() ? '?' + q.toString() : ''));
};
declare global { interface Window { __SCRIPT_MAP_TRIAL__?: { state: State; issues: Issue[]; width: number; height: number; message: string } } }

export function TrialPage({ request }: { request: ScriptRequest }) {
  const [params, setParams] = useState<Params>(readParams);
  const [projects, setProjects] = useState<GroupedProject[] | null>(null), [series, setSeries] = useState<Series[]>([]), [listError, setListError] = useState('');
  const [objects, setObjects] = useState<ScriptObjects | null>(null), [objectsError, setObjectsError] = useState('');
  const [graph, setGraph] = useState<MapGraph | null>(null), [fileName, setFileName] = useState(''), [fileError, setFileError] = useState('');
  const [state, setState] = useState<State>('idle'), [message, setMessage] = useState(''), [issues, setIssues] = useState<Issue[]>([]), [data, setData] = useState<RenderData | null>(null);
  const ticket = useRef(0), sheet = useRef<HTMLDivElement>(null);
  const update = (next: Partial<Params>) => setParams(p => { const v = { ...p, ...next }; writeParams(v); return v; });

  useEffect(() => { const sync = () => setParams(readParams()); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync); }, []);
  useEffect(() => {
    let live = true;
    Promise.all([request<GroupedProject[]>('/projects'), request<Series[]>('/project-series')])
      .then(([p, s]) => { if (live) { setProjects(p); setSeries(s); } })
      .catch(e => { if (live) setListError(errorText(e)); });
    return () => { live = false; };
  }, [request]);
  useEffect(() => {
    setObjects(null); setObjectsError('');
    if (!params.project) return;
    const c = new AbortController();
    loadObjects(request, params.project, c.signal).then(setObjects).catch(e => { if (!c.signal.aborted) setObjectsError(errorText(e)); });
    return () => c.abort();
  }, [request, params.project]);

  const tree = useMemo(() => buildTree(projects ?? [], series), [projects, series]);
  const projectLabel = (p: GroupedProject) => displayPath(tree, p.id, p.name);
  const target = parseRef(params.target), before = parseRef(params.before);
  const options = allObjects(objects);

  // 每次输入变化（换文件、换挂载对象）都重新试画；旧请求的回包一律丢掉
  useEffect(() => {
    const mine = ++ticket.current;
    const done = (s: State, msg: string, list: Issue[] = [], rd: RenderData | null = null) => { if (mine !== ticket.current) return; setState(s); setMessage(msg); setIssues(list); setData(rd); };
    if (!graph) { done(fileError ? 'error' : 'idle', fileError); return; }
    if (!params.project) { done('error', '先选项目（集）'); return; }
    if (!target) { done('error', '先选这张图画在哪一份上（版本、迁移时的稿子或草稿快照）'); return; }
    const diff = graph.kind === 'diff';
    if (diff && !before) { done('error', '这是改动图：还要选前稿'); return; }
    if (diff && before && before.kind === target.kind && before.id === target.id) { done('error', '前稿和当前稿是同一份，请换一份'); return; }
    const binding: Binding = diff ? { before: before!, target } : { target };
    setState('checking'); setMessage('正在试画…'); setData(null); setIssues([]);
    request<{ renderData: RenderData; issues: Issue[] }>(scriptBase(params.project) + '/maps/dry-run', { binding, graph }, 'POST', { signal: AbortSignal.timeout(30000) })
      .then(r => done('ok', r.issues?.length ? `画好了，有 ${r.issues.length} 条提醒` : '画好了，没有问题', r.issues ?? [], r.renderData))
      .catch(e => { const err = asRequestError(e); if (err.status === 422 && err.issues) done('invalid', '没有通过校验，图没有画', err.issues); else done('error', errorText(err)); });
  }, [graph, fileError, params.project, params.target, params.before, request]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(file: File | undefined) {
    if (!file) return;
    const mine = ++ticket.current; setFileName(file.name); setFileError(''); setData(null); setIssues([]); setState('checking'); setMessage('正在读取文件…');
    try {
      const text = await file.text(); if (mine !== ticket.current) return;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('文件里不是一个 JSON 对象');
      setGraph(parsed as MapGraph);
    } catch (e) {
      if (mine !== ticket.current) return;
      setGraph(null); setFileError('读不懂这个文件：' + (e instanceof SyntaxError ? '不是有效的 JSON' : errorText(e)));
    }
  }

  useEffect(() => {
    const svg = sheet.current?.querySelector('svg');
    window.__SCRIPT_MAP_TRIAL__ = { state, issues, message, width: Number(svg?.getAttribute('width') || 0), height: Number(svg?.getAttribute('height') || 0) };
  }, [state, issues, message, data]);

  const objectSelect = (label: string, value: string, onChange: (v: string) => void, allowEmpty: string) =>
    <label className="sa-field"><span>{label}</span><select aria-label={label} value={value} onChange={e => onChange(e.target.value)} disabled={!objects}>
      <option value="">{allowEmpty}</option>
      {options.map(o => <option key={o.kind + o.id} value={o.kind + ':' + o.id}>{objectLabel(o)}</option>)}
      {value && !options.some(o => o.kind + ':' + o.id === value) && <option value={value}>{objects ? '（这一集里没有：' + value + '）' : value}</option>}
    </select></label>;

  return <main className="sa-trial" data-trial-state={state} aria-label="泳道图试画">
    <header className="sa-trial-head">
      <div><h1>泳道图试画</h1><p>选一个泳道图 JSON，拾光按正式上传的同一套规则校验并画出来。只在这一页里看，不保存；刷新要重新选文件。</p></div>
    </header>
    <div className="sa-trial-controls">
      <label className="sa-field"><span>项目</span><select aria-label="项目" value={params.project} onChange={e => update({ project: e.target.value, target: '', before: '' })}>
        <option value="">{projects ? '选一集或一个单独项目' : listError ? '项目列表没有读到' : '正在读取项目…'}</option>
        {(projects ?? []).map(p => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
        {params.project && projects && !projects.some(p => p.id === params.project) && <option value={params.project}>（没有这个项目：{params.project}）</option>}
      </select></label>
      {objectSelect('画在', params.target, v => update({ target: v }), '选一份稿子')}
      {objectSelect('前稿（改动图才要）', params.before, v => update({ before: v }), '单版图不用选')}
      <label className="sa-field sa-file"><span>选择泳道图 JSON</span><input type="file" aria-label="选择泳道图 JSON" accept=".json,application/json" onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }}/></label>
    </div>
    {(listError || objectsError) && <p className="sa-alert" role="alert">{listError || objectsError}</p>}
    {params.project && objects && !options.length && <p className="sa-muted">这一集还没有可以挂图的稿子：先定稿，或在剧本页冻结一份草稿快照。</p>}
    <p className={'sa-trial-status is-' + state} role="status">{fileName && <b>{fileName}</b>}{fileName && ' · '}{message || '还没有选文件'}</p>
    <IssueList issues={issues}/>
    <div ref={sheet} className="sa-trial-map">{state === 'ok' && data && <CausalMap data={data} openId={params.open || undefined}/>}</div>
  </main>;
}
