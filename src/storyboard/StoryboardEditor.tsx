import {notifyFeedback, useFeedbackToast} from '../global-feedback';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Scissors, Clapperboard, Upload, Download, Save, Undo2, Redo2, Plus, Copy, Trash2, ChevronDown, ChevronRight, X, Users, Image, Settings, FolderOpen, FileText, Search, Film, Link, AlertTriangle, Clock3, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, SlidersHorizontal, MoreHorizontal, Check } from 'lucide-react';
import * as domain from '../../server/storyboard/shared/model.mjs';
import { Field, Modal, download } from './ui';
import { AgentShare } from '../AgentShare';
import { DEFAULT_COLUMNS, STORYBOARD_COLUMNS, type StoryboardAppearance, type StoryboardColumn } from './preferences';
import type { StoryboardTransport } from './transport';
import type {ShotFocus} from './shot-navigation';
import './storyboard.css';
import {ShotVideoDialog} from './ShotVideoDialog';
import {createShotVideoApi,useShotSummaries} from './shot-video-api';
import {migrationText,migrationView,newClipCount,shotButtonLabel,type MigrationView} from './shot-video-model.mjs';
import {ReadingMode} from './ReadingMode';
import {unsavedChanges, summary as unsavedSummary} from './unsaved';
import {historyApi, pendingBadge, type VersionMeta} from './history';
import {LogPanel, OldVersion, PendingPanel} from './HistoryPanels';
import {setStoryboardLeaveGuard} from './leave-guard';
import {storyboardDiff} from '../../server/storyboard/shared/change-diff.mjs';
import {applyVideoShotEdits} from './video-shot-draft';
import {GenerationDialog} from './GenerationDialog';
import {insertShotNear, addShotBlocked, type InsertWhere} from './shot-insert';
import {ShotMenu} from './ShotMenu';
import {getSegmentLimit, segmentSummary, nextSegmentName, nearestEmptyBase, splitSegment, mergeSegment, reconcileSegmentCuts, SEGMENT_MODES, modeLabel, MODE_LABEL, trimSeconds, newSegmentId, type SegmentMode} from './segments';
import {useGenerationProjectState} from './generation-state';
import type {GenerationFocus,GenerationTask} from './generation-types';
import type {PromptRequest} from '../PromptTemplateWorkspace';
const M: any = domain;
type Any = any;
const cache={get:(key:string)=>{try{return localStorage.getItem(key);}catch{return null;}},set:(key:string,value:string)=>{try{localStorage.setItem(key,value);return true;}catch{return false;}},remove:(key:string)=>{try{localStorage.removeItem(key);}catch{}}};
type EditorProps = {generationRequest:PromptRequest;generationFocus?:GenerationFocus;onGenerationFocusHandled?:(n:number)=>void;onTaskViewing?:(ids:string[])=>void;onDirtyChange:(v:boolean)=>void; projectId: string; projectName: string; onAssets: () => void; transport: StoryboardTransport; visible: boolean; refreshSeconds: number; appearance: StoryboardAppearance; onAppearanceChange: (value: StoryboardAppearance) => void; onSettings: () => void; shotFocus?:ShotFocus; onShotFocusHandled?:(request:number)=>void };
const COLUMN_LABEL = Object.fromEntries(STORYBOARD_COLUMNS.map(c => [c.key, c.label])) as Record<StoryboardColumn,string>;
/** 列宽：文字多的列宽，其余窄；总宽超出时表格横向滚动。 */
const COLUMN_WIDTH: Record<StoryboardColumn,number> = {framing:150,action:340,camera:260,sound:240,duration:76,transition:220,first_frame:220,continuity:220,design_note:220};
const labels: Record<string,string> = {framing:'景别与角度', action:'画面与人物动作',camera:'摄影机设计',sound:'环境与动作声',transition:'剪辑衔接',first_frame:'第一帧状态',physical_feedback:'物理反馈',environment_feedback:'环境反馈',result:'段落结果',continuity:'连续性要求',design_note:'设计备注'};
export function StoryboardEditor({generationRequest,generationFocus,onGenerationFocusHandled,onTaskViewing,onDirtyChange, projectId, projectName, onAssets, transport, visible, refreshSeconds, appearance, onAppearanceChange, onSettings, shotFocus, onShotFocusHandled }: EditorProps) {

    const generation=useGenerationProjectState(generationRequest,projectId,visible),generationBlock=useRef(true);generationBlock.current=generation.blocked;
    const [generationOpen,setGenerationOpen]=useState<{taskId?:string}|null>(null),observedGeneration=useRef(''),handledGenerationFocus=useRef(0);
    const generationReload=useRef<{taskId:string;epoch:number;project:Any;promise:Promise<void>}|null>(null);
    const [connected, setConnected] = useState(false), [connectionError, setConnectionError] = useState('');
  useFeedbackToast(connectionError, {source: '分镜设计', active: visible});
    const overwrites=useRef<{segment_id:string,name:string}[]>([]);const [customReset,setCustomReset]=useState(0),[reading,setReading]=useState(false),[shotMenu,setShotMenu]=useState<Any>(null),[pendingCount,setPendingCount]=useState<number|null>(null),[view,setView]=useState<'edit'|'pending'|'log'>('edit'),[oldMeta,setOldMeta]=useState<VersionMeta|null>(null),[pendingShots,setPendingShots]=useState<Set<string>>(()=>new Set());
    const history = React.useMemo(()=>historyApi(transport,projectId,()=>token.current),[transport,projectId]);
    const scenePanel=appearance.showScenes, detailPanel=appearance.showDetails, columns=appearance.columns?.length?appearance.columns:DEFAULT_COLUMNS;
    const setScenePanel = (value: boolean | ((before:boolean)=>boolean)) => onAppearanceChange({...appearance,showScenes: typeof value==='function'?value(scenePanel):value});
    const setDetailPanel = (value: boolean | ((before:boolean)=>boolean)) => onAppearanceChange({...appearance,showDetails: typeof value==='function'?value(detailPanel):value});
    
    const visibleRef = useRef(visible); visibleRef.current = visible;
    const storageKey = (key: string) => `shiguang.storyboard.integrated.${transport.origin}.${projectId}.${key}`;
    const [project, setProject] = useState<Any>(null), [active, setActive] = useState(''), [selected, setSelected] = useState<string[]>([]), [collapsed, setCollapsed] = useState<string[]>([]), [sceneFilter, setSceneFilter] = useState(''), [query, setQuery] = useState(''), [modal, setModal] = useState<Any>(null), [notice, setNotice] = useState(''), [status, setStatus] = useState('未打开项目'), [saved, setSaved] = useState(''), [file, setFile] = useState(''), [workspace, setWorkspace] = useState(''), [busy, setBusy] = useState(false), [historyVersion, refreshHistory] = useState(0), [promptDraft, setPromptDraft] = useState(''), [promptOrigin, setPromptOrigin] = useState<Any>(null), [range, setRange] = useState('13-20'), [missing, setMissing] = useState<string[]>([]);
  useFeedbackToast(notice, {source: '分镜设计', active: visible, kind: 'auto'});
    const pRef = useRef<Any>(null), token = useRef(''), hash = useRef<string | null>(null), savedRef = useRef(''), saving = useRef(false), conflict = useRef(false), conflictData = useRef<Any>(null), epoch = useRef(0), undo = useRef<Any[]>([]), redo = useRef<Any[]>([]), input = useRef<HTMLInputElement>(null), autoTimer = useRef<Any>(null);
    const modalRef=useRef<Any>(null); modalRef.current=modal;
    const editorRef=useRef<HTMLElement>(null),pendingShotScroll=useRef('');
    const dbRevision = useRef<number | null>(null), initializedAt=useRef<number|null>(null),libraryId=useRef(''),assetStamp = useRef('');
    const [shotVideo,setShotVideo]=useState<{shotId:string;number:string}|null>(null),shotVideoRef=useRef(shotVideo);shotVideoRef.current=shotVideo;
    const [boardMigration,setBoardMigration]=useState<MigrationView|null>(null);
    const shotVideoApi=useMemo(()=>createShotVideoApi(transport,projectId,()=>token.current),[transport,projectId]),shotSummaries=useShotSummaries(shotVideoApi,visible&&!!project);
    const persistDraft=()=>{if(pRef.current&&!cache.set(storageKey('recovery'),JSON.stringify({project:pRef.current,hash:hash.current,revision:dbRevision.current,file,documentId:pRef.current.document_id??pRef.current.project_id,initializedAt:initializedAt.current,libraryId:libraryId.current})))say('浏览器未能缓存镜头输入，请保持页面打开并保存或导出，避免刷新丢失。');};
    const say = (s: string) => setNotice(s);
    useEffect(() => { if (!notice)
        return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
    useEffect(() => { pRef.current = project; }, [project]);
    useEffect(() => {
      let alive = true;
      transport.session().then(async r => {
        if (!alive) return;
        token.current=r.token;libraryId.current=r.instanceId;setWorkspace(r.workspace);
        const res=await transport.request('/api/projects/'+projectId), data=await res.json();
        if (!alive) return;
        if(res.ok) install(data.project,data); else if(res.status!==404) throw Error(data.message);
        setConnected(true);
        const pending=cache.get(storageKey('pending-init')); 
        if(pending) { try {const m=JSON.parse(pending); if(m.type==='import'&&m.request_id&&m.plan){conflict.current=true;setStatus('初始化结果待确认');setModal({...m,pending:true});return;}}catch{} cache.remove(storageKey('pending-init')); }
        const draft=cache.get(storageKey('recovery'));
        if(draft) { try {const d=JSON.parse(draft); if(!M.validateProject(d.project).length && (!res.ok || M.canonical(d.project)!==M.canonical(data.project)||Object.keys(d.videoEdits??{}).length)) setModal({type:'recovery',...d,current:res.ok?data:null});}catch{cache.remove(storageKey('recovery'));} }
      }).catch(e => { if(alive) setConnectionError('分镜数据库连接失败：'+e.message); });
      return () => { alive=false; epoch.current++; clearTimeout(autoTimer.current); };
    }, [transport,projectId]);
    const install = (value: Any, record?: Any) => { if(record)setBoardMigration(migrationView(record.videoBindingMigration));overwrites.current=[];initializedAt.current=record?.initialized_at??null;const p = M.normalizeProject(value); clearTimeout(autoTimer.current); epoch.current++; conflictData.current = null; undo.current = []; redo.current = []; refreshHistory(v => v + 1); hash.current = record?.hash ?? null; dbRevision.current=record?.revision??null; assetStamp.current=record?.asset_stamp??''; savedRef.current = record ? M.canonical(p) : ''; setSaved(savedRef.current); setFile(record?.file ?? ''); setMissing(record?.missing_assets ?? []); conflict.current = false; setProject(p); pRef.current = p; setActive(M.timeline(p)[0]?.shot.id ?? ''); setSelected([]); setSceneFilter(''); setQuery(''); setStatus(record ? '已保存到数据库' : '草稿 · 待保存'); if (record)
        cache.set(storageKey('last-project'), p.project_id); setModal(null); };
    const mutate = (recipe: Any) => { if(generationBlock.current){say('分镜生成锁或接纳状态尚未解除，编辑暂缓');return;}const before = pRef.current; if (!before)
        return; try {
        const next = M.commitProject(before, recipe);
        if (next === before)
            return;
        const errors = M.validateProject(next);
        if (errors.length)
            throw Error(errors.map((e: Any) => e.path + '：' + e.message).join('\n'));
        undo.current.push(before);
        if (undo.current.length > 100)
            undo.current.shift();
        redo.current = [];
        pRef.current = next;
        setProject(next);
        refreshHistory(v => v + 1);
        setStatus('编辑中 · 等待保存');
    }
    catch (e: Any) {
        say(e.message);
    } };
    const travel = (back: boolean) => {if(generationBlock.current)return;const stack = back ? undo.current : redo.current, other = back ? redo.current : undo.current; if (!stack.length)
        return; other.push(pRef.current); const next = M.restoreHistory(pRef.current, stack.pop());
    next.asset_manifest=M.clone(pRef.current.asset_manifest); next.characters=M.clone(pRef.current.characters); pRef.current = next; setProject(next); refreshHistory(v => v + 1); setStatus('编辑中 · 等待保存'); };
    const save = async () => {if(generationBlock.current){say('当前分镜写入已冻结，请先核对生成任务');return;} const p = pRef.current; if (!p || saving.current || conflict.current || !token.current || ['import','repair','restore-backup'].includes(modalRef.current?.type))
        return; const serialized = M.canonical(p); if (serialized === savedRef.current)
        return; { const bad = grownOverlong(p), limit = segmentSummary(p).limit_ms; if (bad.length) { const text = '这些段超过 ' + trimSeconds(limit ?? 0) + ' 秒，存不进去：' + bad.map((g: Any) => g.name + ' 段 ' + M.sec(g.duration_ms) + ' 秒').join('、') + '。请先在段里切一刀。'; say(text); return; } } if (savedRef.current) { let big=false, changed=0, total=0; try { const d=storyboardDiff(JSON.parse(savedRef.current),p); big=d.summary_only; changed=d.metrics.changedFieldCount; total=d.metrics.unionFieldCount; } catch { /* 比较失败不拦保存，后端仍按同一口径记录 */ } if (big && !await askBig(changed,total)) return; }
        const generation = epoch.current; saving.current = true; setBusy(true); setStatus('正在保存到数据库…'); try {
        const response = await transport.request('/api/projects/' + encodeURIComponent(projectId), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token.current }, body: JSON.stringify({ project: p, expected_revision: dbRevision.current, change: { author: 'user' }, request_id: crypto.randomUUID(), ...(()=>{ const live = overwrites.current.filter(o => (p.segments ?? []).some((g: Any) => g.id === o.segment_id && g.name === o.name)); return live.length ? { segment_name_overwrites: live } : {}; })() }) });
        const result = await response.json();
        if (epoch.current !== generation)
            return;
        if (response.status === 409 && !result.code?.startsWith?.('REQUEST_ID')) { await aiFirst(); return; }
        if (response.status === 409) {
            conflict.current = true;
            setStatus('数据库已更新 · 草稿未覆盖');
            conflictData.current = { type: 'conflict', message:result.message, local: pRef.current };
            setModal(conflictData.current);
            return;
        }
        if (!response.ok)
            throw Error((result.message || result.error || '保存失败') + (result.errors ? '\n' + result.errors.map((e: Any) => e.path + '：' + e.message).join('\n') : ''));
        overwrites.current=[]; hash.current = result.hash; dbRevision.current=result.revision; assetStamp.current=result.asset_stamp; if(typeof result.pending_count==='number')setPendingCount(pendingBadge(result));
        cache.set(storageKey('last-project'), p.project_id);
        savedRef.current = serialized;
        setSaved(serialized);
        setFile(result.file); setStatus('已保存到数据库');
        if (M.canonical(pRef.current) === serialized) {
          pRef.current=result.project; setProject(result.project); savedRef.current=M.canonical(result.project); setSaved(savedRef.current); cache.remove(storageKey('recovery'));
        }
        return result;
    }
    catch (e: Any) {
        if (epoch.current !== generation)
            return;
        setStatus('草稿已缓存，数据库待保存');
        say(e.message);
    }
    finally {
        if(epoch.current===generation){saving.current = false;
        setBusy(false);}
    } };
    useEffect(() => { if (!project || M.canonical(project) === saved)
        return; try {
        persistDraft();
    }
    catch {
        say('浏览器草稿空间不足，请手动保存或导出项目。');
    } /* 只有点保存才写库（STORYBOARD-CHANGE-LOG v1）：不再自动存库，这里只保留浏览器草稿 */ }, [project, saved, busy, modal, generation.blocked]);
    useEffect(() => { const handler = (e: BeforeUnloadEvent) => { if (pRef.current && M.canonical(pRef.current) !== savedRef.current) {
        e.preventDefault();
        e.returnValue = '';
    } }; window.addEventListener('beforeunload', handler); const keys = (e: KeyboardEvent) => { if (!visibleRef.current || !(e.target instanceof HTMLElement) || !e.target.closest('.sb-app')) return; if(shotVideoRef.current)return; if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
    } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        travel(!e.shiftKey);
    } }; window.addEventListener('keydown', keys); return () => { window.removeEventListener('beforeunload', handler); window.removeEventListener('keydown', keys); }; }, []);
    useEffect(() => { if (!refreshSeconds || !visible) return; const timer=setInterval(async()=>{
      if(!pRef.current || saving.current || conflict.current || document.hidden || document.activeElement?.closest('.sb-app input,.sb-app textarea,.sb-app select')) return;
      const generation=epoch.current, base=hash.current;
      try { const res=await transport.request('/api/projects/'+projectId), r=await res.json();
        if(generation!==epoch.current || saving.current || conflict.current || base!==hash.current) return;
        if(!res.ok) throw Error(r.message);
        if(r.hash!==hash.current) await aiFirst(r);
        else if(r.asset_stamp!==assetStamp.current && M.canonical(pRef.current)===savedRef.current) install(r.project,r);
      } catch(e:Any) { say(e.message); }
    },Math.max(1000,refreshSeconds*1000)); return()=>clearInterval(timer); },[visible,refreshSeconds,transport,projectId]);
    const openShotVideo=(shotId:string,number:string)=>setShotVideo({shotId,number});
    useEffect(()=>{void shotSummaries.refresh();},[saved]);useEffect(()=>{if(!visible)setShotVideo(null);},[visible]);useEffect(()=>{setShotVideo(null);},[projectId]);
    const prepareGeneration=async():Promise<number|null>=>{if(generationBlock.current)throw Error('目标项目的锁或接纳结果尚未解除，请核对任务');if(conflict.current||modalRef.current)throw Error('请先处理当前分镜面板或版本冲突；原输入保留');if(saving.current)throw Error('当前分镜正在保存，请稍后重新检查');await save();if(pRef.current&&M.canonical(pRef.current)!==savedRef.current)throw Error('分镜草稿未保存成功，未开始生成；原输入保留');return pRef.current?dbRevision.current:null;};
    const readGeneratedStoryboard=(taskId:string):Promise<void>=>{
      if(pRef.current&&M.canonical(pRef.current)!==savedRef.current)return Promise.reject(Error('本地仍有未保存草稿，已保留；请先导出或核对后载入数据库分镜'));
      if(modalRef.current&&modalRef.current.type!=='conflict')return Promise.reject(Error('当前分镜面板输入已保留，请关闭面板后重新载入'));
      const original=pRef.current,generationEpoch=epoch.current,existing=generationReload.current;
      if(existing?.taskId===taskId&&existing.epoch===generationEpoch&&existing.project===original)return existing.promise;
      const pending={taskId,epoch:generationEpoch,project:original,promise:Promise.resolve()};
      const promise=(async()=>{const response=await transport.request('/api/projects/'+projectId),record=await response.json();if(!response.ok)throw Error(record.message||'新分镜读取失败');if(epoch.current!==generationEpoch||pRef.current!==original||generationReload.current!==pending)throw Error('读取期间已有新输入，当前草稿保留');install(record.project,record);})();
      pending.promise=promise;generationReload.current=pending;
      void promise.finally(()=>{if(generationReload.current===pending)generationReload.current=null;}).catch(()=>{});
      return promise;
    };
    useEffect(()=>{if(!visible)setGenerationOpen(null);},[visible]);
    useEffect(()=>{if(!visible||!generationFocus||generationFocus.projectId!==projectId||generationFocus.request<=handledGenerationFocus.current)return;handledGenerationFocus.current=generationFocus.request;setShotVideo(null);setGenerationOpen({taskId:generationFocus.taskId});onGenerationFocusHandled?.(generationFocus.request);},[visible,generationFocus]);
    useEffect(()=>{if(generation.state?.locked){observedGeneration.current=generation.state.ownerTaskId||'';return;}if(!generation.known||!observedGeneration.current)return;const id=observedGeneration.current;observedGeneration.current='';let current=true;void generationRequest<GenerationTask>('/storyboard-generation/tasks/'+id).then(t=>{if(current&&t.projectId===projectId&&t.status==='completed')return readGeneratedStoryboard(t.taskId);}).catch(e=>{if(current)say('生成任务状态已更新：'+e.message);});return()=>{current=false;};},[generation.known,generation.state?.locked,generation.state?.ownerTaskId]);
    useEffect(()=>{const changed=()=>{persistDraft();setGenerationOpen(null);epoch.current++;saving.current=false;setBusy(false);setShotVideo(null);conflict.current=true;setStatus('资料库身份已变化，旧草稿保留');conflictData.current={type:'conflict',message:'资料库身份已变化，请导出旧草稿并重新打开当前项目'};setModal(conflictData.current);};window.addEventListener('shiguang-library-identity-changed',changed);return()=>window.removeEventListener('shiguang-library-identity-changed',changed);},[]);
    const canSwitch = () => !project || M.canonical(pRef.current) === savedRef.current || confirm('当前修改尚未写入数据库。继续切换？可先取消并保存或导出。');
    const parseImport = async (raw:string, filename:string, timing='duration') => {
      if(!token.current || busy || generationBlock.current) return;
      setBusy(true);
      try { const source=JSON.parse(raw); const res=await transport.request('/api/projects/'+projectId+'/preview',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token.current},body:JSON.stringify({source,filename,timing})}); const data=await res.json(); if(!res.ok) throw Error(data.message);
        setModal({type:'import',source,raw,filename,timing,plan:data,request_id:crypto.randomUUID()});
      } catch(e:Any) { setModal({type:'repair',raw,filename,errors:[{path:'$',message:e.message}]}); }
      finally { setBusy(false); }
    };
    const finishImport = async () => {
      if(generationBlock.current){say('当前分镜正在生成或接纳待确认，不能初始化');return;}const m=modal; setBusy(true); conflict.current=true; clearTimeout(autoTimer.current);
      if(!cache.set(storageKey('pending-init'),JSON.stringify(m))) say('浏览器无法保存初始化回执编号，请保持本页打开，直到确认初始化结果。');
      try { const res=await transport.request('/api/projects/'+projectId+'/initialize',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token.current},body:JSON.stringify({source:m.source,filename:m.filename,timing:m.timing,request_id:m.request_id,expected_revision:m.plan.expected_revision})}); const data=await res.json();
        if(!res.ok) { if(res.status<500) { cache.remove(storageKey('pending-init')); setModal({...m,error:data.message,pending:false,blocked:true}); } else setModal({...m,error:data.message,pending:true}); throw Error(data.message); }
        cache.remove(storageKey('pending-init')); cache.remove(storageKey('recovery'));
        install(data.project,data); setPromptDraft(''); setPromptOrigin(null); setCollapsed([]); say('分镜初始化完成，已关联项目资产。原有资产、图片与音乐记录保留。');
      } catch(e:Any) { setStatus('初始化未确认 · 自动保存暂停'); setModal((old:Any)=>({...old,pending:!old?.blocked,error:e.message})); }
      finally { setBusy(false); }
    };
    const checkInitialization = async () => {
      setBusy(true); try { const res=await transport.request('/api/projects/'+projectId+'/requests/'+modal.request_id),r=await res.json(); if(!res.ok) throw Error(r.message);
        if(r.completed) { const current=await transport.request('/api/projects/'+projectId).then(r=>r.json()); cache.remove(storageKey('pending-init')); cache.remove(storageKey('recovery')); install(current.project,current); say('已确认初始化成功，已载入当前数据库分镜。'); }
        else setModal({...modal,pending:true,checked:true,error:'暂未查到回执。可继续查询，或使用同一请求编号重试；不会重复初始化。'});
      } catch(e:Any) { say(e.message); } finally { setBusy(false); }
    };
    const openProjects = async () => { if(!canSwitch() || conflict.current) return; const res=await transport.request('/api/legacy/projects'); setModal({type:'projects',rows:await res.json()}); };
    const openSaved = async (id:string) => { const res=await transport.request('/api/legacy/projects/'+id),data=await res.json(); if(!res.ok) {say(data.message);return;} void parseImport(M.pretty(data.project),data.project.title+'.storyboard.json'); };
    const loadExample = async () => { if(!canSwitch()) return; const res=await transport.request('/api/example'); void parseImport(await res.text(),'示例.json'); };
    const openAssetPicker=async(kind='character',page=1,q='')=>{try{const data=await transport.projectAssets(projectId,kind,page,q);setModal({type:'asset-picker',kind,page,q,...data});}catch(e:Any){say(e.message);}};
    const addManifestAsset=(a:Any)=>{mutate((p:Any)=>{const list=p.asset_manifest[a.kind];if(!list.some((v:Any)=>v.id===a.id))list.push({id:a.id,name:a.name});if(a.kind==='character'&&!p.characters.some((c:Any)=>c.id===a.id))p.characters.push({id:a.id,name:a.name,age:a.details?.age??'',role:a.details?.role??'',description:a.performance_info,appearance:a.base_info});});setModal(null);say('已加入完整清单，保存后受分镜保护；解除保护需重新初始化。');};
    const downloadBackup=async()=>{setBusy(true);try{const res=await transport.request('/api/backup'),data=await res.json();if(!res.ok)throw Error(data.message);download('分镜与项目资产-完整备份.json',M.pretty(data));say('已导出分镜与项目资产完整备份。');}catch(e:Any){say(e.message);}finally{setBusy(false);}};
    const restoreBackup=async(source:Any)=>{if(generationBlock.current){say('当前分镜写入已冻结，不能恢复备份');return;}setBusy(true);try{const res=await transport.request('/api/restore',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token.current},body:JSON.stringify(source)}),data=await res.json();if(!res.ok)throw Error(data.message);setModal(null);say('完整备份恢复成功，请重新选择或刷新项目。');}catch(e:Any){say(e.message);}finally{setBusy(false);}};
    const leaveResolve = useRef<((ok:boolean)=>void)|null>(null);
    const bigResolve = useRef<((ok:boolean)=>void)|null>(null);
    /** 一次保存改动超过整份一半时先确认（口径与后端 change-diff 一致）。 */
    const askBig = (changed:number,total:number) => new Promise<boolean>(resolve => { bigResolve.current?.(false); bigResolve.current=resolve; setModal({type:'big-change',changed,total}); });
    const settleBig = (ok:boolean) => { const done=bigResolve.current; bigResolve.current=null; setModal(null); done?.(ok); };
    const isDirty = () => !!pRef.current && M.canonical(pRef.current)!==savedRef.current;
    /** 有未保存修改时弹「保存 / 放弃 / 留着」；没有就直接继续。 */
    const askLeave = (reason:string) => !isDirty() ? Promise.resolve(true) : new Promise<boolean>(resolve => { leaveResolve.current?.(false); leaveResolve.current = resolve; setModal({type:'leave',reason,places:unsavedChanges(savedRef.current,pRef.current).places}); });
    const settleLeave = async (choice:'save'|'discard'|'stay') => { const done=leaveResolve.current; leaveResolve.current=null; setModal(null); if(choice==='stay'){done?.(false);return;} if(choice==='save'){const r=await save(); done?.(!!r && !isDirty()); return;} await reloadCurrent(); done?.(true); };
    useEffect(()=>{ if(!visible) return; return setStoryboardLeaveGuard((reason?:string)=>askLeave(reason??'离开分镜页')); },[visible]);
    // 待看标记与数量：载入或保存出新版本后重读；旧库没迁移时（503）静默不显示。
    const loadedRevision = project ? dbRevision.current : null;
    useEffect(()=>{ if(loadedRevision==null) return; let alive=true; history.pending().then(d=>{ if(!alive) return; setPendingCount(pendingBadge(d)); setPendingShots(new Set(d.items.filter(i=>i.shot_id&&!i.deleted&&!i.net_unchanged).map(i=>i.shot_id as string))); }).catch(()=>{ if(alive){setPendingCount(null);setPendingShots(new Set());} }); return()=>{alive=false;}; },[history,loadedRevision,pendingCount,view]);
    const reloadCurrent = async () => { try { const res=await transport.request('/api/projects/'+projectId),data=await res.json(); if(!res.ok) throw Error(data.message); cache.remove(storageKey('recovery')); install(data.project,data); } catch(e:Any) { say(e.message); } };
    // 冲突时 AI 优先（用户确认的规则）：别处（通常是 agent）已保存新版本时，放弃页面里没保存的修改、载入最新，并说明放弃了几处。
    const aiFirst = async (latest?: Any) => { const lost=unsavedChanges(savedRef.current,pRef.current).places; try { const data=latest??await (async()=>{const res=await transport.request('/api/projects/'+projectId),d=await res.json();if(!res.ok)throw Error(d.message);return d;})(); conflict.current=false; conflictData.current=null; cache.remove(storageKey('recovery')); install(data.project,data); setStatus('已载入最新分镜'); if(lost) notifyFeedback({kind:'warning',source:'分镜',title:'Codex 刚保存了新版本',message:`你的 ${lost} 处未保存修改已放弃。改过的镜头已标「待看」。`,key:'storyboard-ai-first'}); } catch(e:Any){ say(e.message); } };
    const patchShot=(id:string,key:string,value:Any)=>mutate((p:Any)=>{const q=M.timeline(p).find((r:Any)=>r.shot.id===id)?.shot;if(q)q[key]=value;});
    const exportProject = () => { const errors = M.validateProject(pRef.current); if (errors.length) {
        say(errors.map((e: Any) => e.path + ': ' + e.message).join('\n'));
        return;
    } download(project.title + '.storyboard.json', M.pretty(pRef.current)); say('已导出完整标准 JSON，包含素材清单、数据库关联编号和来源原文。'); };
    const handleDelete = (ids: string[]) => { if (!ids.length)
        return; setModal({ type: 'delete', ids, impact: M.deletionImpact(project, ids) }); };
    const insertNear = (anchorId: string, where: InsertWhere) => { let id = ''; mutate((p: Any) => { const before = M.clone(p); id = insertShotNear(p, anchorId, where); if (id) p.segments = reconcileSegmentCuts(before, p, { insertions: [{ shot_id: id, anchor_shot_id: anchorId, side: where === 'above' ? 'before' : 'after' }] }).segments; }); if (id) { setActive(id); setDetailPanel(true); } };
    const segmentOf = (shotId: string) => segmentSummary(pRef.current).segments.find((g: Any) => g.shot_ids.includes(shotId));
    const doSplit = (shotId: string, overwriteName?: string) => { const id = newSegmentId(); let ok = false; mutate((p: Any) => { p.segments = splitSegment(p, shotId, { id, name: overwriteName }).segments; ok = true; }); if (ok && overwriteName) overwrites.current = [...overwrites.current.filter(o => o.name !== overwriteName), { segment_id: id, name: overwriteName }]; };
    const cutAt = (shotId: string) => { try { const g = segmentOf(shotId); if (!g) return; if (g.start_shot_id === shotId) { say('这一镜已经是 ' + g.name + ' 段的第一镜'); return; } const name = nextSegmentName(pRef.current, g.id), empty = nearestEmptyBase(pRef.current, g.id); if (empty) setModal({ type: 'split', shotId, name, empty }); else doSplit(shotId); } catch (e: Any) { say(e.message); } };
    const mergeInto = (segmentId: string) => { try { mutate((p: Any) => { p.segments = mergeSegment(p, segmentId).segments; }); } catch (e: Any) { say(e.message); } };
    const grownOverlong = (p: Any) => { const cur = segmentSummary(p).segments.filter((g: Any) => g.overlong); if (!cur.length) return []; let prev: Any[] = []; try { prev = savedRef.current ? segmentSummary(JSON.parse(savedRef.current)).segments : []; } catch { prev = []; } return cur.filter((g: Any) => { const old = prev.find((o: Any) => o.id === g.id); return !old || g.duration_ms > old.duration_ms; }); };
    const openPrompt = () => { try {
        const built = { ...M.buildPrompt(pRef.current, selected), source_revision: project.revision };
        setPromptOrigin(built);
        setPromptDraft(built.prompt);
        setModal({ type: 'prompt' });
    }
    catch (e: Any) {
        say(e.message);
    } };
    const bindings = (values: Any[], onChange: Any) => <div className="sb-bindings">{values.map((b: Any, i: number) => <div className="sb-binding" key={i}><div className="sb-row sb-between"><strong>{project.assets.find((a: Any) => a.id === b.asset_id)?.name ?? '缺失素材'}</strong><button aria-label="移除参考绑定" onClick={() => onChange(values.filter((_: Any, j: number) => j !== i))}><X size={14}/></button></div><label className="sb-field"><span>参考主体</span><select aria-label="参考主体" value={b.subject_id ?? ''} onChange={e => onChange(values.map((v: Any, j: number) => i === j ? { ...v, subject_id: e.target.value } : v))}><option value="">全局 / 未指定</option>{project.characters.map((c: Any) => <option key={c.id} value={c.id}>人物 · {c.name}</option>)}{project.scenes.map((s: Any) => <option key={s.id} value={s.id}>场景 · {s.location}</option>)}</select></label><label className="sb-field"><span>适用场景（可多选；全不选表示全部场景）</span><select multiple aria-label="参考适用场景" value={b.scene_ids ?? []} onChange={e => onChange(values.map((v: Any, j: number) => i === j ? { ...v, scene_ids: Array.from(e.target.selectedOptions).map(o => o.value) } : v))}>{project.scenes.map((s: Any) => <option key={s.id} value={s.id}>{s.name ?? s.location}</option>)}</select></label><Field label="只锁定什么" value={b.locks} multiline onCommit={(v: string) => onChange(values.map((a: Any, j: number) => j === i ? { ...a, locks: v } : a))}/><Field label="必须忽略什么" value={b.ignores} multiline onCommit={(v: string) => onChange(values.map((a: Any, j: number) => j === i ? { ...a, ignores: v } : a))}/>{b.shot_ids?.length > 0 && <small>限定镜头 ID：{b.shot_ids.join('、')}</small>}</div>)}<select aria-label="添加参考绑定" value="" onChange={e => { if (e.target.value)
        onChange([...values, { asset_id: e.target.value, subject_id: '', locks: '', ignores: '', scene_ids: [], shot_ids: [] }]); }}><option value="">＋ 绑定参考素材</option>{project.assets.map((a: Any) => <option key={a.id} value={a.id}>{a.name ?? a.path}</option>)}</select></div>;
    const rows: Any[] = project ? M.timeline(project) : [], activeRow = rows.find(r => r.shot.id === active), shot = activeRow?.shot, choice = project ? M.selection(project, selected) : null, filtered = rows.filter(r => (!sceneFilter || r.scene.id === sceneFilter) && (!query || r.number.includes(query) || [r.shot.action, r.shot.camera, r.scene.location].some(v => v.includes(query))));
    const segSum: Any = project ? segmentSummary(project) : null, segStart = new Map<string, Any>((segSum?.segments ?? []).map((g: Any, i: number) => [g.start_shot_id, { ...g, index: i }]));
    const actual = project ? M.duration(project) : 0, dirty = project && M.canonical(project) !== saved;
    const unsaved = React.useMemo(()=>unsavedChanges(saved,project),[saved,project]), unsavedText = dirty ? unsavedSummary(unsaved) : '';
    useEffect(()=>{
      if(!visible||!connected||!shotFocus||shotFocus.projectId!==projectId||['import','repair','restore-backup','recovery','conflict','external-error'].includes(modal?.type))return;
      let live=true;
      void (async()=>{
        let current=pRef.current;const generation=epoch.current;
        if(current&&M.canonical(current)===savedRef.current&&!saving.current&&!conflict.current){
          const response=await transport.request('/api/projects/'+projectId),record=await response.json();if(!live)return;
          if(!response.ok)throw Error(record.message||'关联分镜已不可用，请刷新关联镜号');
          if(epoch.current!==generation)return;
          if(M.canonical(pRef.current)===savedRef.current&&!saving.current&&!conflict.current){install(record.project,record);current=pRef.current;}else current=pRef.current;
        }
        if(!live)return;
        if(!current||(current.document_id??current.project_id)!==shotFocus.documentId)throw Error('关联分镜已变化，请返回刷新关联镜号');
        const found=M.timeline(current).find((r:Any)=>r.shot.id===shotFocus.shotId);
        if(!found){setActive('');setSelected([]);throw Error('该关联镜头已删除或分镜已重新初始化，请刷新关联镜号');}
        setSceneFilter('');setQuery('');setCollapsed(before=>before.filter(id=>id!==found.scene.id));setActive(found.shot.id);setSelected([found.shot.id]);setDetailPanel(true);setModal(null);pendingShotScroll.current=found.shot.id;say('已定位镜 '+found.number+' · '+(found.scene.location||'未命名场次'));onShotFocusHandled?.(shotFocus.request);
      })().catch((e:Error)=>{if(live){say(e.message);onShotFocusHandled?.(shotFocus.request);}});
      return()=>{live=false;};
    },[visible,connected,shotFocus,project?.project_id,modal?.type]);
    useEffect(()=>{if(!visible||!pendingShotScroll.current)return;const frame=requestAnimationFrame(()=>{const row=Array.from(editorRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-shot]')??[]).find(r=>r.dataset.shot===pendingShotScroll.current);if(row){pendingShotScroll.current='';row.tabIndex=-1;row.scrollIntoView({block:'center',inline:'nearest'});row.focus({preventScroll:true});}});return()=>cancelAnimationFrame(frame);},[visible,active,project,query,sceneFilter,shotFocus?.request]);
    useEffect(()=>{onDirtyChange(!!dirty); return()=>onDirtyChange(false);},[!!dirty,onDirtyChange]);
    const sceneEdit = modal?.type === 'scene' ? project.scenes.find((s: Any) => s.id === modal.id) : null;
    const addShot = (sceneId?: string) => { const scene = sceneId || sceneFilter || activeRow?.scene.id || project?.scenes[0]?.id; const blocked = addShotBlocked(pRef.current, scene); if (blocked) { say(blocked); return; } const q = M.emptyShot(); mutate((p: Any) => { const before = M.clone(p), order = M.timeline(p), sceneIndex = p.scenes.findIndex((s: Any) => s.id === scene); const prev = order.filter((r: Any) => r.sceneIndex < sceneIndex).at(-1), next = order.find((r: Any) => r.sceneIndex > sceneIndex); p.scenes[sceneIndex].shots.push(q); const insertions = prev ? [{ shot_id: q.id, anchor_shot_id: prev.shot.id, side: 'after' as const }] : next ? [{ shot_id: q.id, anchor_shot_id: next.shot.id, side: 'before' as const }] : []; p.segments = reconcileSegmentCuts(before, p, { insertions, firstSegmentId: newSegmentId() }).segments; }); setActive(q.id); setDetailPanel(true); };
    return <section ref={editorRef} className="sb-app" aria-label="分镜设计工作台" data-scenes={scenePanel} data-details={detailPanel} data-density={appearance.density}>
      {shotMenu&&<ShotMenu container={editorRef.current} target={{x:shotMenu.x,y:shotMenu.y,title:'镜 '+shotMenu.number+' 操作',returnFocus:shotMenu.returnFocus}} close={()=>setShotMenu(null)} items={[{key:'above',label:'在上方插入镜头',icon:<Plus size={14}/>,onSelect:()=>insertNear(shotMenu.id,'above')},{key:'below',label:'在下方插入镜头',icon:<Plus size={14}/>,onSelect:()=>insertNear(shotMenu.id,'below')},{key:'cut',label:'从这里切段',icon:<Scissors size={14}/>,disabled:segStart.has(shotMenu.id),hint:segStart.has(shotMenu.id)?'这一镜已经是 '+segStart.get(shotMenu.id).name+' 段的第一镜':undefined,onSelect:()=>cutAt(shotMenu.id)}]}/>}
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={async e => { const f=e.target.files?.[0]; if(f && canSwitch()) void parseImport(await f.text(),f.name); e.target.value=''; }}/>
      <header className="sb-project-header">
        <div className="sb-project-heading"><span className="sb-project-icon"><Clapperboard size={23}/></span><div><div className="sb-eyebrow">分镜设计</div><div className="sb-project-picker"><h1>{project?.title || '尚未初始化分镜'}</h1></div><small>{projectName} · 数据库存储</small></div>{project && <span className="sb-revision">v{project.revision}</span>}</div>
        <div className="sb-header-actions">{project&&<button type="button" onClick={()=>setReading(true)} title="整屏只看分镜内容 · Esc 退出"><BookOpen size={15}/>阅读模式</button>}<button className="sb-primary-soft" disabled={!connected||!generation.known&&!generation.state} onClick={()=>void askLeave('开始 Codex 生成').then(ok=>{if(!ok)return;setShotVideo(null);setGenerationOpen({taskId:generation.state?.ownerTaskId||undefined});})}> {generation.state?.locked||generation.pendingLocal?'查看 Codex 分镜任务':project?'使用 Codex 重新生成':'使用 Codex 生成'}</button><button disabled={generation.blocked || !connected || busy || conflict.current} onClick={() => input.current?.click()}><Upload size={15}/>{project?'重新初始化 JSON':'初始化 JSON'}</button>{project && <button onClick={exportProject}><Download size={15}/>导出</button>}<button aria-label="分镜界面设置" title="界面设置 · 与素材库共享" onClick={onSettings}><SlidersHorizontal size={17}/></button>{project && <button className="sb-primary" onClick={() => void save()} disabled={generation.blocked || busy || !dirty || conflict.current}><Save size={15}/>{busy?'保存中':'保存项目'}</button>}</div>
      </header>
      {!connected && <div className="sb-connection" role="status">{connectionError ? <><AlertTriangle size={26}/><h2>分镜工作台暂未连接</h2><p>{connectionError}</p><button onClick={() => location.reload()}>重新连接</button></> : <><span className="sb-spinner"/>正在读取分镜项目…</>}</div>}
      <div className="sb-generation-status" role="status">{generation.error?<>{generation.error}<button onClick={generation.refresh}>重新核对生成锁</button></>:generation.pendingLocal?'生成接纳回执待确认 · 当前编辑暂缓，未声称任务已停止':generation.state?.locked?'此项目的分镜正在生成 · 全部分镜编辑已冻结，旧数据只读保留':!generation.known?'正在核对项目生成锁…':''}</div>
      <fieldset disabled={generation.blocked} className="sb-generation-editing">
      {connected && !project && <div className="sb-welcome"><span className="sb-welcome-icon"><Clapperboard size={42}/></span><h2>为当前项目初始化分镜</h2><p>用完整 JSON 初始化，自动创建或关联人物、场景和道具。<br/>后续编辑直接保存在当前素材管理器数据库。</p><div className="sb-row"><button className="sb-primary" onClick={() => input.current?.click()}><Upload size={16}/>导入分镜 JSON</button><button onClick={() => void loadExample()}>载入通用示例</button></div><button className="sb-text-button" onClick={() => void openProjects()}><FolderOpen size={15}/>从旧版分镜导入</button></div>}
      {project && <>
        <div className="sb-commandbar"><div className="sb-row"><button aria-label="撤销" title="撤销" disabled={!undo.current.length} onClick={() => travel(true)}><Undo2 size={16}/></button><button aria-label="重做" title="重做" disabled={!redo.current.length} onClick={() => travel(false)}><Redo2 size={16}/></button><span className="sb-separator"/><button className={"sb-save-state "+(conflict.current?"sb-warning":"")} data-testid="save-status" onClick={() => {if(conflictData.current)setModal(conflictData.current);}} title={file || workspace}><span className={"sb-save-dot "+(dirty?"sb-pending":"")}/>{unsavedText&&!busy?<span className="sb-unsaved-text">{unsavedText}</span>:status}</button></div><div className="sb-row sb-resources"><button onClick={() => setModal({type:'characters'})}><Users size={15}/>人物 <b>{project.characters.length}</b></button><button onClick={() => setModal({type:'assets'})}><Image size={15}/>素材清单 <b>{Object.values(project.asset_manifest??{}).reduce((n:number,a:any)=>n+a.length,0) as number}</b></button><button onClick={() => setModal({type:'settings'})}><Settings size={15}/>项目设置</button></div></div>
        <div className="sb-workbench">
          <aside className="sb-scenes" aria-label="场景目录"><div className="sb-panel-heading"><strong>场景</strong><div className="sb-row"><button aria-label="新增场景" title="新增场景" onClick={() => {const id=M.uid('scene');mutate((p:Any)=>p.scenes.push({id,name:'新场景',location:'',story_time:'',interior_exterior:'',spatial_setup:'',shots:[]}));setModal({type:'scene',id});}}><Plus size={16}/></button><button aria-label="收起场景目录" onClick={()=>setScenePanel(false)}><PanelLeftClose size={15}/></button></div></div><button className={"sb-all-scenes "+(!sceneFilter?"sb-chosen":"")} onClick={()=>setSceneFilter('')}><Film size={16}/>全部镜头 <b>{rows.length}</b></button><div className="sb-scene-list">{project.scenes.map((s:Any,i:number)=>{const sr=rows.filter(r=>r.scene.id===s.id),closed=collapsed.includes(s.id);return <section key={s.id} className={"sb-scene-card "+(sceneFilter===s.id?"sb-current":"")}><div className="sb-scene-top"><button className="sb-scene-name" onClick={()=>setSceneFilter(s.id)}><span className="sb-scene-index">{String(i+1).padStart(2,'0')}</span><span><strong>{s.location||s.name||'新场景'}</strong><small>{s.story_time||'剧情时间待填写'}</small></span></button><button aria-label={'编辑场景'+(i+1)} title="编辑场景" onClick={()=>setModal({type:'scene',id:s.id})}><MoreHorizontal size={16}/></button></div><div className="sb-scene-meta"><button aria-label={(closed?'展开':'收起')+'场景'+(i+1)} onClick={()=>setCollapsed(old=>closed?old.filter(id=>id!==s.id):[...old,s.id])}>{closed?<ChevronRight size={12}/>:<ChevronDown size={12}/>} {s.shots.length} 镜</button><span>{M.sec(s.shots.reduce((n:number,q:Any)=>n+q.duration_ms,0))} 秒</span><small>{sr.length?M.clock(sr[0].start_ms):'—'}</small></div>{!closed&&<div className="sb-scene-shots">{sr.map(r=><button key={r.shot.id} className={active===r.shot.id?"sb-active":""} onClick={()=>{setActive(r.shot.id);setSceneFilter(s.id);setDetailPanel(true);}}><span>{r.number}</span><em>{r.shot.framing||'新镜头'}</em><small>{M.sec(r.shot.duration_ms)}s</small></button>)}{s.shots.length===0&&<button type="button" className="sb-scene-add" aria-label={'在场景'+(i+1)+'新增镜头'} onClick={()=>addShot(s.id)}><Plus size={13}/>新增镜头</button>}</div>}</section>;})}</div></aside>
          <section className="sb-editor" aria-label="分镜表">
            {(shotSummaries.data?.migration??boardMigration)&&<p className="sv-migration" role="status">{migrationText(shotSummaries.data?.migration??boardMigration)}</p>}
            <div className="sb-table-tools"><div className="sb-row"><button aria-label={scenePanel?'隐藏场景目录':'显示场景目录'} title={scenePanel?'隐藏场景目录':'显示场景目录'} onClick={()=>setScenePanel(v=>!v)}>{scenePanel?<PanelLeftClose size={16}/>:<PanelLeftOpen size={16}/>}</button><div className="sb-view-tabs" role="group" aria-label="分镜视图">{([["edit","编辑"],["pending","待看的修改"],["log","改动记录"]] as const).map(([k,t])=><button key={k} type="button" aria-pressed={view===k} onClick={()=>setView(k)}>{t}{k==="pending"&&!!pendingCount&&<b>{pendingCount}</b>}</button>)}</div>{view==="edit"&&<label className="sb-search"><Search size={15}/><input aria-label="搜索镜号或内容" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索镜号、动作、运镜"/></label>}</div><div className="sb-row"><span className="sb-table-count">{rows.length} 镜 · 点击镜号预览</span><button aria-label={detailPanel?'隐藏镜头详情':'显示镜头详情'} title={detailPanel?'隐藏镜头详情':'显示镜头详情'} onClick={()=>setDetailPanel(v=>!v)}>{detailPanel?<PanelRightClose size={16}/>:<PanelRightOpen size={16}/>}</button></div></div>
            {view!=="edit"?<div className="sb-table-scroll">{view==="pending"?<PendingPanel api={history} refreshKey={dbRevision.current} shotNumber={id=>rows.find(r=>r.shot.id===id)?.number} onLocate={id=>{setView("edit");setActive(id);requestAnimationFrame(()=>document.querySelector(`tr[data-shot="${CSS.escape(id)}"]`)?.scrollIntoView({block:"center"}));}} onCount={n=>setPendingCount(n)}/>:<LogPanel api={history} refreshKey={dbRevision.current} onOpen={m=>setOldMeta(m)}/>}</div>:<div className="sb-table-scroll"><table aria-label="可编辑分镜表" style={{minWidth:110+columns.reduce((n,k)=>n+COLUMN_WIDTH[k],0)}}><colgroup><col style={{width:36}}/><col style={{width:74}}/>{columns.map(k=><col key={k} style={{width:COLUMN_WIDTH[k]}}/>)}</colgroup><thead><tr><th><input type="checkbox" aria-label="选择全部当前镜头" checked={filtered.length>0&&filtered.every(r=>selected.includes(r.shot.id))} onChange={e=>setSelected(e.target.checked?[...new Set([...selected,...filtered.map(r=>r.shot.id)])]:selected.filter(id=>!filtered.some(r=>r.shot.id===id)))}/></th><th className="sb-shot-heading" scope="col">镜号</th>{columns.map(k=><th key={k} scope="col">{COLUMN_LABEL[k]}</th>)}</tr></thead><tbody>{filtered.map((r,i)=><React.Fragment key={r.shot.id}>{segStart.has(r.shot.id)&&(()=>{const g=segStart.get(r.shot.id);return <tr className={'sb-segment-divider'+(g.overlong?' is-over':'')} data-testid={'segment-'+g.name}><td colSpan={2+columns.length}><strong>{g.name} 段</strong><span>{g.shot_count} 镜 · {M.sec(g.duration_ms)} 秒</span>{g.overlong&&<em role="status"><AlertTriangle size={13}/>超过 {trimSeconds(segSum.limit_ms)} 秒，建议再切一刀</em>}{g.index>0&&<button type="button" aria-label={'把'+g.name+'段并入上一段'} onClick={()=>mergeInto(g.id)}>并入上一段</button>}</td></tr>;})()}{(i===0||filtered[i-1].scene.id!==r.scene.id)&&<tr className="sb-scene-divider"><td colSpan={2+columns.length}><span>场 {String(r.sceneIndex+1).padStart(2,'0')}</span><strong>{r.scene.location||'新场景'}</strong><small>{r.scene.story_time} · {r.scene.interior_exterior}</small></td></tr>}<tr data-shot={r.shot.id} data-testid={'shot-row-'+r.number} className={active===r.shot.id?"sb-active-row":""} onClick={()=>{setActive(r.shot.id);}} onContextMenu={e=>{e.preventDefault();setActive(r.shot.id);setShotMenu({x:e.clientX,y:e.clientY,id:r.shot.id,number:r.number,returnFocus:e.currentTarget});}}><td className="sb-check-cell"><input type="checkbox" aria-label={'选择镜'+r.number} checked={selected.includes(r.shot.id)} onClick={e=>e.stopPropagation()} onChange={e=>setSelected(old=>e.target.checked?[...old,r.shot.id]:old.filter(id=>id!==r.shot.id))}/></td><td className="sb-shot-number">{unsaved.shots.has(r.shot.id)&&<i className="sb-unsaved-dot" role="img" aria-label="这一镜有未保存的修改"/>}<button className="sbv-open-shot" title="播放这一镜的片子；不改变勾选" aria-label={'播放镜'+r.number+'的片子'} onClick={e=>{e.stopPropagation();openShotVideo(r.shot.id,r.number);}}><strong>{r.number}</strong><span className="sbv-open-label"><Film size={12}/>{shotButtonLabel(shotSummaries.data,r.shot.id)}</span></button>{(shotSummaries.data?.shots[r.shot.id]?.needsReview||newClipCount(shotSummaries.data?.shots[r.shot.id])>0)&&<span className="sb-shot-video-chips">{shotSummaries.data?.shots[r.shot.id]?.needsReview&&<span className="sb-review-chip" title="绑定的分镜内容改过，片子仍可播放">需复核</span>}{newClipCount(shotSummaries.data?.shots[r.shot.id])>0&&<span className="sb-fresh-chip">有 {newClipCount(shotSummaries.data?.shots[r.shot.id])} 条新片子</span>}</span>}{pendingShots.has(r.shot.id)&&<span className="sb-pending-chip" title="保存后被改过、你还没看过">待看</span>}</td>{columns.map(k=>k==='sound'?<React.Fragment key={k}><td><div className="sb-sound-cell"><Field inline multiline changed={!!(unsaved.shots.get(r.shot.id)?.has('sound')||unsaved.shots.get(r.shot.id)?.has('dialogue'))} label={'镜'+r.number+'环境与动作声'} value={r.shot.sound} onCommit={(v:string)=>patchShot(r.shot.id,'sound',v)}/>{r.shot.dialogue.map((d:Any)=><p key={d.id}><b>{project.characters.find((c:Any)=>c.id===d.character_id)?.name}</b> {d.text}</p>)}{r.shot.audio_continuations.length>0&&<small className="sb-mint"><Link size={11}/> 承接前镜语音</small>}</div></td></React.Fragment>:k==='duration'?<React.Fragment key={k}><td className="sb-duration-cell"><Field inline changed={!!unsaved.shots.get(r.shot.id)?.has('duration_ms')} label={'镜'+r.number+'时长'} testid={'duration-'+r.number} value={M.sec(r.shot.duration_ms)} onCommit={(v:string)=>{try{patchShot(r.shot.id,'duration_ms',M.secondsToMs(v));}catch(e:Any){say(e.message);}}}/><small>秒</small></td></React.Fragment>:<td key={k}><Field inline multiline changed={!!unsaved.shots.get(r.shot.id)?.has(k)} label={'镜'+r.number+labels[k]} value={r.shot[k]} onCommit={(v:string)=>patchShot(r.shot.id,k,v)}/></td>)}</tr></React.Fragment>)}</tbody></table>{!filtered.length&&<div className="sb-empty"><Film size={30}/><p>这里还没有镜头</p><button onClick={()=>addShot()}><Plus size={15}/>新增镜头</button></div>}</div>}
            <div className="sb-selection-bar" style={view==="edit"?undefined:{display:"none"}}><div><strong>{selected.length?`已选 ${selected.length} 镜`:'选择连续镜头'}</strong><small>{selected.length?(choice.continuous?`${M.sec(choice.duration_ms)} 秒 · 连续片段`:`缺口：${choice.missing.join('、')||'含已删镜头'}`):'按镜号范围生成整合提示词'}</small></div><div className="sb-range"><input aria-label="镜号范围" value={range} onChange={e=>setRange(e.target.value)} placeholder="13-20"/><button onClick={()=>{const match=/^(\d+)\s*[-—~至]\s*(\d+)$/.exec(range.trim());if(!match||+match[1]>+match[2]||+match[1]<1||+match[2]>rows.length){say('请输入有效连续镜号，例如 13-20');return;}setSelected(rows.slice(+match[1]-1,+match[2]).map(r=>r.shot.id));}}>选取</button></div>{selected.length>0&&<button aria-label="清空选择" onClick={()=>setSelected([])}><X size={15}/></button>}<button className="sb-primary" disabled={!choice.continuous} onClick={openPrompt}><FileText size={15}/>整合提示词</button></div>
          </section>
          <aside className="sb-details" aria-label="镜头详情"><div className="sb-panel-heading"><span>镜头详情</span><button aria-label="关闭镜头详情" onClick={()=>setDetailPanel(false)}><X size={16}/></button><span className="sb-tag">{shot ? 'SHOT ' + activeRow.number : '未选中'}</span></div>{shot ? <div className="sb-detail-scroll" key={shot.id}><div className="sb-detail-title"><h2>镜 {activeRow.number}<small>{shot.framing || '待补充景别'}</small></h2><div className="sb-row"><button title="复制镜头" aria-label="复制当前镜头" onClick={() => { let id = ''; mutate((p: Any) => { const before = M.clone(p); id = M.duplicateShot(p, shot.id); if (id) p.segments = reconcileSegmentCuts(before, p, { insertions: [{ shot_id: id, anchor_shot_id: shot.id, side: 'after' }] }).segments; }); if (id)
                setActive(id); }}><Copy size={16}/></button><button title="删除镜头" aria-label="删除当前镜头" onClick={() => handleDelete([shot.id])}><Trash2 size={16}/></button></div></div><div className="sb-detail-meta"><span>{M.clock(activeRow.start_ms)} → {M.clock(activeRow.end_ms)}</span><span>REV {shot.revision}</span></div><div className="sb-row"><button aria-label="在当前镜头上方插入镜头" onClick={() => insertNear(shot.id, 'above')}><Plus size={14}/>在上方插入</button><button aria-label="在当前镜头下方插入镜头" onClick={() => insertNear(shot.id, 'below')}><Plus size={14}/>在下方插入</button></div><Field label="时长（秒，精确到毫秒）" testid="detail-duration" value={M.sec(shot.duration_ms)} onCommit={(v: string) => { try {
                patchShot(shot.id, 'duration_ms', M.secondsToMs(v));
            }
            catch (e: Any) {
                say(e.message);
            } }}/>{['framing', 'action', 'camera', 'sound', 'transition'].map(k => <Field key={k} label={labels[k]} testid={'detail-' + k} value={shot[k]} multiline rows={k === 'action' || k === 'camera' ? 6 : 3} onCommit={(v: string) => patchShot(shot.id, k, v)}/>)}
 <div className="sb-section-title"><h3>对白与声音承接</h3><button aria-label="新增对白" disabled={!project.characters.length} onClick={() => patchShot(shot.id, 'dialogue', [...shot.dialogue, { id: M.uid('dialogue'), character_id: project.characters[0].id, text: '', source: '现场对白', performance: '' }])}><Plus size={15}/></button></div>{shot.dialogue.map((d: Any, i: number) => <div className="sb-dialogue-editor" key={d.id}><div className="sb-row"><select aria-label={'对白人物' + (i + 1)} value={d.character_id} onChange={e => patchShot(shot.id, 'dialogue', shot.dialogue.map((a: Any) => a.id === d.id ? { ...a, character_id: e.target.value } : a))}>{project.characters.map((c: Any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button aria-label={'删除对白' + (i + 1)} onClick={() => { const refs = rows.filter(r => r.shot.audio_continuations.some((c: Any) => c.dialogue_id === d.id)); if (refs.length) {
                say('该对白被镜 ' + refs.map(r => r.number).join('、') + ' 承接，请先解除承接。');
                return;
            } patchShot(shot.id, 'dialogue', shot.dialogue.filter((a: Any) => a.id !== d.id)); }}><X size={14}/></button></div>{[['source', '声源'], ['text', '台词原文'], ['performance', '表演要求']].map(([k, label]) => <Field key={k} label={label} value={d[k]} multiline={k !== 'source'} onCommit={(v: string) => patchShot(shot.id, 'dialogue', shot.dialogue.map((a: Any) => a.id === d.id ? { ...a, [k]: v } : a))}/>)}</div>)}{shot.audio_continuations.map((c: Any, i: number) => <div className="sb-continuation" key={i}><strong><Link size={13}/> 承接镜 {rows.find(r => r.shot.id === c.source_shot_id)?.number}</strong><p>{rows.find(r => r.shot.id === c.source_shot_id)?.shot.dialogue.find((d: Any) => d.id === c.dialogue_id)?.text}</p><Field label="承接说明" multiline value={c.note} onCommit={(v: string) => patchShot(shot.id, 'audio_continuations', shot.audio_continuations.map((a: Any, j: number) => j === i ? { ...a, note: v } : a))}/><button onClick={() => patchShot(shot.id, 'audio_continuations', shot.audio_continuations.filter((_: Any, j: number) => i !== j))}>解除承接</button></div>)}<select aria-label="添加语音承接" value="" onChange={e => { const d = rows.flatMap(r => r.shot.dialogue.map((d: Any) => ({ ...d, source_shot_id: r.shot.id }))).find(d => d.id === e.target.value); if (d)
                patchShot(shot.id, 'audio_continuations', [...shot.audio_continuations, { source_shot_id: d.source_shot_id, dialogue_id: d.id, note: '' }]); }}><option value="">＋ 承接已有对白（不重复说台词）</option>{rows.filter(r => r.shot.id !== shot.id).flatMap(r => r.shot.dialogue.map((d: Any) => <option key={d.id} value={d.id}>镜 {r.number} · {d.text.slice(0, 26)}</option>))}</select>
 <h3>人物关联</h3><p className="sb-muted sb-hint">关联只标明人物身份。请明确画内、画外或仅声音。</p>{project.characters.map((c: Any) => <div className="sb-presence" key={c.id}><label><input type="checkbox" aria-label={'关联人物' + c.name} checked={shot.character_ids.includes(c.id)} onChange={e => mutate((p: Any) => { const q = M.timeline(p).find((r: Any) => r.shot.id === shot.id).shot; q.character_ids = e.target.checked ? [...q.character_ids, c.id] : q.character_ids.filter((id: string) => id !== c.id); q.character_presence = e.target.checked ? [...q.character_presence, { character_id: c.id, mode: 'unspecified' }] : q.character_presence.filter((v: Any) => v.character_id !== c.id); })}/>{c.name}</label>{shot.character_ids.includes(c.id) && <select aria-label={c.name + '出场方式'} value={(shot.character_presence ?? []).find((v: Any) => v.character_id === c.id)?.mode ?? 'unspecified'} onChange={e => { const vals = (shot.character_presence ?? []).filter((v: Any) => v.character_id !== c.id); patchShot(shot.id, 'character_presence', [...vals, { character_id: c.id, mode: e.target.value }]); }}><option value="unspecified">待确认</option><option value="visible">画内</option><option value="offscreen">画外</option><option value="voice_only">仅声音</option></select>}</div>)}<h3>场景与道具关联</h3><label className="sb-field"><span>本镜场景资产</span><select aria-label="本镜场景资产" value={shot.scene_asset_id??''} onChange={e=>patchShot(shot.id,'scene_asset_id',e.target.value||null)}><option value="">沿用场次关联 / 未指定</option>{project.asset_manifest.scene.map((a:Any)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{project.asset_manifest.prop.map((a:Any)=><label className="sb-field" key={a.id}><span><input type="checkbox" aria-label={'关联道具'+a.name} checked={(shot.prop_ids??[]).includes(a.id)} onChange={e=>patchShot(shot.id,'prop_ids',e.target.checked?[...(shot.prop_ids??[]),a.id]:(shot.prop_ids??[]).filter((id:string)=>id!==a.id))}/>{a.name}</span></label>)}<h3>本镜参考素材</h3>{bindings(shot.reference_bindings, (v: Any) => patchShot(shot.id, 'reference_bindings', v))}{shot.reference_bindings.map((b: Any, i: number) => { const a = project.assets.find((v: Any) => v.id === b.asset_id); return a ? <Media origin={transport.apiBase} key={i} asset={a} projectId={projectId} missing={missing.includes(a.id)}/> : null; })}
 <details><summary>完整母版字段与连续性</summary>{['first_frame', 'physical_feedback', 'environment_feedback', 'result', 'continuity'].map(k => <Field key={k} label={labels[k]} value={shot[k]} multiline onCommit={(v: string) => patchShot(shot.id, k, v)}/>)}</details><details><summary>设计备注（不随提示词导出）</summary><Field label="设计备注" value={shot.design_note} multiline onCommit={(v: string) => patchShot(shot.id, 'design_note', v)}/></details><details><summary>永久 ID 与来源原文</summary><code className="sb-id">{shot.id}</code><pre>{M.pretty(shot.source ?? {})}</pre></details></div> : <div className="sb-empty">点击一行镜头，编辑完整长文本。</div>}</aside>
        </div>
        <footer className="sb-statusbar"><span>{project.scenes.length} 场 · {segSum?.segments.length??0} 段 · {rows.length} 镜 · {M.dialogueCount(project)} 条对白</span><button type="button" className="sb-segment-mode" title="修改分割模式" onClick={()=>setModal({type:'settings'})}>分割：{modeLabel(project.segment_settings)}</button><div className="sb-duration-summary"><Clock3 size={14}/><strong data-testid="total-duration">{M.sec(actual)} 秒</strong><span>目标 {M.sec(project.settings.target_duration_ms)} 秒</span>{actual!==project.settings.target_duration_ms&&<span className="sb-amber">差额 {actual>project.settings.target_duration_ms?'+':''}{M.sec(actual-project.settings.target_duration_ms)} 秒</span>}</div><small title={file}>{missing.length?`缺失 ${missing.length} 个素材，可重新定位`:'数据库保存 · 原文完整保留'}</small></footer>
      </>}
      </fieldset>
       {oldMeta&&project&&visible&&<OldVersion api={history} meta={oldMeta} title={projectName} currentRevision={dbRevision.current??0} onClose={()=>setOldMeta(null)} onRestored={()=>{setOldMeta(null);setView("edit");void reloadCurrent();}}/>}{reading&&project&&visible&&<ReadingMode project={project} title={projectName} onClose={()=>setReading(false)} onJump={id=>{setReading(false);setActive(id);requestAnimationFrame(()=>document.querySelector(`tr[data-shot="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'}));}}/>}{generationOpen&&visible&&generation.libraryId&&<GenerationDialog projectId={projectId} projectName={projectName} libraryId={generation.libraryId} request={generationRequest} prepare={prepareGeneration} dirty={()=>!!pRef.current&&M.canonical(pRef.current)!==savedRef.current} projectLocked={generation.blocked} taskId={generationOpen.taskId} onImported={readGeneratedStoryboard} onViewing={onTaskViewing} onClose={()=>{setGenerationOpen(null);generation.refresh();}}/>}
       {shotVideo&&visible&&<ShotVideoDialog key={shotVideo.shotId} api={shotVideoApi} shotId={shotVideo.shotId} shotNumber={shotVideo.number} summaries={shotSummaries.data?.shots??{}} onChanged={shotSummaries.refresh} onClose={()=>setShotVideo(null)}/>}
       
 {modal && <Modal top={['big-change','leave'].includes(modal.type)} disabled={generation.blocked} wide={['prompt', 'history', 'settings', 'repair', 'conflict', 'assets'].includes(modal.type)} title={({ import: '初始化项目分镜', repair: 'JSON 校验与修复', projects: '从旧版分镜导入', characters: '人物管理', assets: '参考素材管理', 'asset-picker':'加入项目资产', 'restore-backup':'恢复完整备份', settings: '项目设置', scene: '场景编辑', delete: '删除镜头', prompt: '整合视频提示词', history: '提示词版本', conflict: '外部更新 · 版本冲突', 'big-change': '这次保存改动很大', leave: `还有 ${modal.places||''} 处修改没保存`, split: '切出新段', recovery: '恢复未保存草稿', 'external-error': '磁盘文件无法载入' } as Record<string, string>)[modal.type]} onClose={() => {if(modal.type==='leave'){void settleLeave('stay');return;}if(modal.type==='big-change'){settleBig(false);return;}if(!modal.pending&&!busy)setModal(null);}}>
 {modal.type === 'import' && <>
  <div className="sb-import-stats"><span><b>{modal.plan.scenes}</b>场</span><span><b>{modal.plan.shots}</b>镜</span><span><b>{M.sec(modal.plan.duration_ms)}</b>秒</span></div>
  <p>目标项目：<strong>{modal.plan.project_name}</strong>。{modal.plan.replacing?'将覆盖全部现有分镜、对白与清单关联。':'将创建此项目的当前分镜。'}原有资产、造型、图片和音乐使用记录保留；不提供初始化历史恢复。</p>
  <p>{modal.plan.characters} 人物 · {modal.plan.scene_assets} 场景资产 · {modal.plan.props} 道具 · 解除 {modal.plan.unlinked} 项旧关联。</p>
  <div className="sb-diff-list">{modal.plan.assets.map((a:Any,i:number)=><p key={i}>{({character:'人物',scene:'场景',prop:'道具'} as Any)[a.kind]} · {a.name} — {a.action==='reuse'?'复用现有档案，保留原资料':'新建档案'}{a.action==='reuse'&&'；导入资料不覆盖原档'}</p>)}</div>
  <p className="sb-muted">同名归档档案保持归档。仅按当前项目、类型和活动名称匹配。</p>
  {modal.plan.warnings.map((w:Any,i:number)=><p className="sb-muted" key={i}>{w.path}：{w.message}</p>)}
  {modal.error&&<div className="sb-callout sb-warning" role="alert">{modal.error}</div>}
  <div className="sb-modal-actions">{modal.pending?<><button disabled={busy} onClick={()=>void checkInitialization()}>查询初始化结果</button>{modal.checked&&<button disabled={busy} onClick={()=>void finishImport()}>使用同一请求重试</button>}</>:modal.blocked?<><button onClick={()=>void reloadCurrent()}>载入当前分镜</button><button onClick={()=>{const m=modal;void parseImport(m.raw,m.filename,m.timing);}}>重新预览</button></>:<><button disabled={busy} onClick={()=>setModal(null)}>取消</button><button className="sb-primary" disabled={busy} onClick={()=>void finishImport()}>{busy?'正在初始化…':modal.plan.replacing?'初始化并覆盖当前分镜':'初始化项目分镜'}</button></>}</div>
 </>}
 {modal.type === 'repair' && <><p>当前项目未被替换。可在下方修复 JSON 后重新校验，也可下载原文。</p><div className="sb-error-list">{modal.errors.map((e: Any, i: number) => <p key={i}><code>{e.path}</code> {e.message}</p>)}</div><textarea className="sb-json-editor" aria-label="修复 JSON" value={modal.raw} onChange={e => setModal({ ...modal, raw: e.target.value })}/><div className="sb-modal-actions"><button onClick={() => download('待修复-' + modal.filename, modal.raw)}>下载原文</button><button className="sb-primary" onClick={() => parseImport(modal.raw, modal.filename)}>重新校验</button></div></>}
 {modal.type === 'projects' && <><p className="sb-muted sb-id">{workspace}</p>{modal.rows.length ? modal.rows.map((r: Any) => <button key={r.id} className="sb-project-item" onClick={() => void openSaved(r.id)}><FolderOpen size={20}/><span><strong>{r.title}</strong><small>{r.error ?? ('REV ' + r.revision + ' · ' + r.id)}</small></span><ChevronRight size={17}/></button>) : <div className="sb-empty">还没有保存的项目，先导入 JSON。</div>}</>}
 {modal.type === 'recovery' && <><p>找到本项目的未保存草稿。{modal.current?.revision!==modal.revision?'数据库已更新，旧草稿只能导出，避免覆盖新初始化。':'可以继续编辑或导出保留。'}</p><div className="sb-modal-actions"><button className="sb-danger" onClick={()=>{cache.remove(storageKey('recovery'));setModal(null);}}>丢弃草稿</button><button onClick={()=>download('未保存草稿.storyboard.json',M.pretty({...modal.project,...(modal.videoEdits?{unsaved_preview_inputs:modal.videoEdits}:{})}))}>导出草稿</button>{modal.current?.revision===modal.revision&&(!modal.videoEdits||modal.libraryId===libraryId.current&&modal.initializedAt===initializedAt.current)&&<button className="sb-primary" onClick={()=>{const m=modal;let restored=m.project;if(Object.keys(m.videoEdits??{}).length){try{restored=applyVideoShotEdits(m.project,m.videoEdits);}catch(e:Any){say(e.message+'。草稿未改动，可先导出。');return;}}install(restored,m.current);savedRef.current=M.canonical(m.current.project);setSaved(savedRef.current);}}>恢复编辑</button>}</div></>}
 {['characters','assets'].includes(modal.type) && <><div className="sb-callout">完整清单中的资产均受分镜保护，即使没有对白或镜头引用也不能归档。资料和名称请在项目资产库编辑，分镜按永久编号显示最新名称。移出清单需重新初始化。</div>{Object.entries(project.asset_manifest??{}).filter(([kind])=>modal.type!=='characters'||kind==='character').map(([kind,items]:Any)=><div key={kind}><h3>{({character:'人物',scene:'场景',prop:'道具'} as Any)[kind]}</h3>{items.map((a:Any)=><div className="sb-character-card" key={a.id}><strong>{a.name}</strong><small> 已关联 · 禁止归档</small><br/><code>{a.id}</code></div>)}</div>)}<div className="sb-row"><button onClick={()=>void openAssetPicker()}>从当前项目资产加入清单</button><button className="sb-primary" onClick={onAssets}>前往当前项目资产库</button></div></>}
 {modal.type === 'asset-picker' && <><p>选用后加入当前分镜完整清单，保存后禁止归档；移出须重新初始化。</p><div className="sb-row"><select aria-label="加入清单资产类型" value={modal.kind} onChange={e=>void openAssetPicker(e.target.value)}><option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option></select><input aria-label="搜索项目资产" defaultValue={modal.q} onKeyDown={e=>{if(e.key==='Enter')void openAssetPicker(modal.kind,1,e.currentTarget.value);}} placeholder="输入名称后回车"/></div>{modal.items.map((a:Any)=><button key={a.id} className="sb-project-item" disabled={project.asset_manifest[a.kind].some((e:Any)=>e.id===a.id)} onClick={()=>addManifestAsset(a)}>{a.name}{project.asset_manifest[a.kind].some((e:Any)=>e.id===a.id)?' · 已加入':' · 加入清单'}</button>)}<div className="sb-row"><button disabled={modal.page<=1} onClick={()=>void openAssetPicker(modal.kind,modal.page-1,modal.q)}>上一页</button><span>{modal.total} 项</span><button disabled={modal.page*40>=modal.total} onClick={()=>void openAssetPicker(modal.kind,modal.page+1,modal.q)}>下一页</button><button onClick={onAssets}>前往资产库新建</button></div></>}
 {modal.type === 'restore-backup' && <><p>此操作恢复完整备份中的项目、资产与分镜编号。只写入缺少的记录；同编号不同内容或项目名称冲突时整体拒绝，不覆盖已有资料。原始媒体文件需另行携带。</p><div className="sb-modal-actions"><button disabled={busy} onClick={()=>setModal(null)}>取消</button><button disabled={busy} className="sb-primary" onClick={()=>void restoreBackup(modal.source)}>确认恢复完整备份</button></div></>}
 {modal.type === 'settings' && <><div className="sb-two-cols"><div><Field label="项目名称" value={project.title} onCommit={(v: string) => mutate((p: Any) => p.title = v)}/><Field label="故事核心" value={project.synopsis} multiline rows={6} onCommit={(v: string) => mutate((p: Any) => p.synopsis = v)}/>{[['aspect_ratio', '画幅'], ['fps', '帧率'], ['target_duration_ms', '目标总时长（秒）'], ['platform', '目标平台'], ['model', '目标模型']].map(([k, label]) => <Field key={k} label={label} value={k === 'target_duration_ms' ? M.sec(project.settings[k]) : project.settings[k]} onCommit={(v: string) => { try {
            const val = k === 'target_duration_ms' ? M.secondsToMs(v) : k === 'fps' ? Number(v) : v;
            mutate((p: Any) => p.settings[k] = val);
        }
        catch (e: Any) {
            say(e.message);
        } }}/>)}<label className="sb-field"><span>分割模式（每段时长上限）</span><select aria-label="分割模式" value={project.segment_settings?.mode ?? 'seedance_2_5'} onChange={e=>{const mode=e.target.value as SegmentMode;mutate((p:Any)=>{p.segment_settings={mode,custom_limit_ms:mode==='custom'?(p.segment_settings?.custom_limit_ms??getSegmentLimit(p.segment_settings)??30000):null};});}}>{SEGMENT_MODES.map((m:SegmentMode)=><option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select></label>{project.segment_settings?.mode==='custom'&&<Field key={'custom-limit-'+customReset} label="自定义上限（秒）" value={project.segment_settings?.custom_limit_ms?M.sec(project.segment_settings.custom_limit_ms):''} onCommit={(v:string)=>{try{const ms=M.secondsToMs(v);if(!(ms>0))throw Error('请填大于 0 的秒数');mutate((p:Any)=>{p.segment_settings={mode:'custom',custom_limit_ms:ms};});}catch(e:Any){say(e.message);setCustomReset(n=>n+1);}}}/>}<p className="sb-muted">平台与模型留作后续配置，不会提交付费生成。</p></div><div><JsonField label="全局规则（保留全部子项）" value={project.global_rules} onCommit={(v: Any) => mutate((p: Any) => p.global_rules = v)} onError={say}/><JsonField label="项目说明 / 元数据" value={project.metadata ?? {}} onCommit={(v: Any) => mutate((p: Any) => p.metadata = v)} onError={say}/><details><summary>原始导入信息</summary><pre>{M.pretty(project.import_source ?? {})}</pre></details></div></div><div className="sb-callout">分镜保存在当前素材管理器的 SQLite / MySQL 数据库。源 JSON 只用于初始化，不会被监听或回写。再次导入会整体替换分镜。</div><div className="agent-share-settings">
          <span><a href={transport.url('/api/schema')} download="project.schema.json">下载标准导出 JSON Schema</a> · <a href={transport.url('/api/initialization-schema')} download="initialization.schema.json">下载新版中文初始化 Schema</a></span>
          {visible && <AgentShare key={projectId} projectId={projectId} projectName={projectName} disabled={generation.blocked}/>}
        </div><h3>完整分镜与项目资产备份</h3><p className="sb-muted">包含当前数据库全部项目分镜、清单、人物、造型、图片绑定和初始化回执；不含原始媒体文件。恢复不覆盖不同内容。</p><div className="sb-row"><button disabled={busy||dirty} onClick={()=>void downloadBackup()}>下载完整备份</button><label className="sb-button">选择完整备份恢复<input type="file" hidden accept=".json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{setModal({type:'restore-backup',source:JSON.parse(await f.text())});}catch{say('备份 JSON 无法解析');}}}/></label></div></>}
 {modal.type === 'scene' && sceneEdit && <><label className="sb-field"><span>场次关联的场景资产</span><select aria-label="场次场景资产" value={sceneEdit.scene_asset_id??''} onChange={e=>mutate((p:Any)=>p.scenes.find((s:Any)=>s.id===sceneEdit.id).scene_asset_id=e.target.value||null)}><option value="">未指定（不根据地点文字猜测）</option>{project.asset_manifest.scene.map((a:Any)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{[['name', '场景名称'], ['location', '地点'], ['story_time', '剧情时间'], ['interior_exterior', '内外景'], ['spatial_setup', '空间设定']].map(([k, label]) => <Field key={k} label={label} value={sceneEdit[k]} multiline={k === 'spatial_setup'} rows={8} onCommit={(v: string) => mutate((p: Any) => p.scenes.find((s: Any) => s.id === sceneEdit.id)[k] = v)}/>)}<div className="sb-row"><button data-testid="scene-insert-after" onClick={() => { const id = M.uid('scene'); mutate((p: Any) => { const i = p.scenes.findIndex((x: Any) => x.id === sceneEdit.id); p.scenes.splice(i + 1, 0, { id, name: '新场景', location: '', story_time: '', interior_exterior: '', spatial_setup: '', shots: [] }); }); setModal({ type: 'scene', id }); }}><Plus size={15}/>在此场景后新建场景</button><button className="sb-danger" onClick={() => { if (sceneEdit.shots.length) {
            say('场景仍含镜头，请先删除镜头。');
            return;
        } const used = project.reference_bindings.some((b: Any) => b.subject_id === sceneEdit.id || b.scene_ids?.includes(sceneEdit.id)) || rows.some(r => r.shot.reference_bindings.some((b: Any) => b.subject_id === sceneEdit.id || b.scene_ids?.includes(sceneEdit.id))); if (used) {
            say('场景仍有参考绑定，请先解除关联。');
            return;
        } mutate((p: Any) => p.scenes = p.scenes.filter((s: Any) => s.id !== sceneEdit.id)); setModal(null); }}>删除空场景</button></div></>}
 {modal.type === 'delete' && <><div className="sb-callout sb-warning"><AlertTriangle size={20}/>将删除 {modal.ids.length} 个镜头，时间轴会自动重算。</div><p>受影响提示词批次：{modal.impact.batches.length} 个；下游语音承接：{modal.impact.continuations.length} 处。</p><p>下游承接将解除；本次页面内可撤销。删除镜头不会移出素材清单，也不会解除资产保护。</p><div className="sb-modal-actions"><button onClick={() => setModal(null)}>取消</button><button className="sb-danger" data-testid="confirm-delete" onClick={() => { mutate((p: Any) => { const before = M.clone(p); M.deleteShots(p, modal.ids); p.segments = reconcileSegmentCuts(before, p).segments; }); setSelected(old => old.filter(id => !modal.ids.includes(id))); setModal(null); }}>确认删除</button></div></>}
 {modal.type === 'prompt' && promptOrigin && <><div className="sb-row sb-between"><span className="sb-pill">{promptOrigin.shot_ids.length} 镜 · {M.sec(promptOrigin.duration_ms)} 秒 · 段内从 0 开始</span><span className="sb-tag">{promptOrigin.template_version}</span></div><p className="sb-muted">确定性拼装，原文完整保留。缺失项标记待补充；可在此编辑并导出，不保存历史版本。</p>{(promptOrigin.requires_sync || promptDraft !== promptOrigin.prompt) && <div className="sb-callout sb-warning">手动提示词与源分镜待同步，未自动回写剧情。请核对当前分镜后再导出。</div>}<textarea className="sb-prompt-editor" aria-label="整合提示词全文" value={promptDraft} onChange={e => setPromptDraft(e.target.value)}/><div className="sb-modal-actions"><button onClick={() => download(`镜序-${M.sec(promptOrigin.duration_ms)}秒.txt`, promptDraft, 'text/plain;charset=utf-8')}><Download size={15}/>导出 TXT</button><button onClick={() => download('整合提示词.json', M.pretty({ ...promptOrigin, prompt: promptDraft, requires_sync: promptDraft !== promptOrigin.prompt || promptOrigin.requires_sync }))}>导出提示词 JSON</button><button className="sb-primary" onClick={()=>void navigator.clipboard.writeText(promptDraft).then(()=>say('已复制整合提示词')).catch(()=>say('复制失败，请导出 TXT'))}><Copy size={15}/>复制提示词</button></div></>}
 {modal.type==='big-change' && <><p>这次保存会改动 {modal.changed} 处（整份共 {modal.total} 处），超过一半。保存后改动记录里只记摘要，完整内容在那一版里可以查看和恢复。</p><div className="sb-modal-actions"><button data-testid="big-cancel" onClick={()=>settleBig(false)}>先不保存</button><button className="sb-primary" data-testid="big-save" onClick={()=>settleBig(true)}>确定保存</button></div></>}
 {modal.type==='split' && <><p>从这一镜起切出一段新段。它和下一段之间空着字母 <b>{modal.empty}</b>，可以直接用回它。</p><p className="sb-muted">覆盖后，以前叫 {modal.empty} 的提示词和片子将对不上，旧 {modal.empty} 的资料作废。历史版本、素材和片子都不会删。</p><div className="sb-modal-actions"><button onClick={()=>setModal(null)}>取消</button><button data-testid="split-new" onClick={()=>{const id=modal.shotId;setModal(null);doSplit(id);}}>叫 {modal.name}</button><button className="sb-primary" data-testid="split-overwrite" onClick={()=>{const id=modal.shotId,name=modal.empty;setModal(null);doSplit(id,name);}}>覆盖 {modal.empty}</button></div></>}
 {modal.type==='leave' && <><p>你要{modal.reason}。这些修改还没写进数据库，别的页面和 Codex 都看不到。</p><div className="sb-modal-actions"><button data-testid="leave-discard" onClick={()=>void settleLeave('discard')}>放弃这些修改</button><button data-testid="leave-stay" onClick={()=>void settleLeave('stay')}>留着，先不走</button><button className="sb-primary" data-testid="leave-save" onClick={()=>void settleLeave('save')}>保存</button></div></>}
 {['conflict','external-error'].includes(modal.type) && <><div className="sb-callout sb-warning">{modal.message||'数据库分镜已更新'}。自动保存已暂停，当前草稿保留。载入最新数据前可先导出草稿。</div><div className="sb-modal-actions"><button onClick={()=>download('未保存分镜.storyboard.json',M.pretty(project))}>导出当前草稿</button><button className="sb-primary" onClick={()=>void reloadCurrent()}>载入最新数据库分镜</button></div></>}
 </Modal>}
    </section>;
}
function JsonField({ label, value, onCommit, onError }: Any) { return <Field label={label} value={M.pretty(value)} multiline rows={15} onCommit={(v: string) => { try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw Error('须为 JSON 对象');
    onCommit(parsed);
}
catch (e: Any) {
    onError(label + '：' + e.message);
} }}/>; }

function Media({ asset, projectId, missing, origin }: Any) { const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [asset.path, asset.embedded_data]); const src = asset.embedded_data ?? `${origin}/projects/${projectId}/media?path=${encodeURIComponent(asset.path)}`; if (missing && !asset.embedded_data || failed)
    return <div className="sb-media-missing"><AlertTriangle size={24}/><span>素材缺失，请重新定位</span></div>; return <div className="sb-media-preview">{asset.media_type.startsWith('image/') ? <img src={src} alt={asset.name ?? '参考图'} onError={() => setFailed(true)}/> : asset.media_type.startsWith('video/') ? <video src={src} controls onError={() => setFailed(true)}/> : <audio src={src} controls onError={() => setFailed(true)}/>}</div>; }
