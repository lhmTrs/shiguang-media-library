import {useEffect,useRef,useState} from 'react';
import {RefreshCw,X} from 'lucide-react';
import type {PromptRequest} from '../PromptTemplateWorkspace';

type Skill={id:string;name:string;title:string;description:string;scope:string;enabled:boolean;importable:boolean;toolDependencies:number};
type Catalog={catalogId:string;skills:Skill[];unreadableCount:number;expiresAt:number};
export type CodexSkillPreview={name:string;source:string;revision:string;contentHash:string;fileCount:number;totalBytes:number;warnings:string[];package:{format:string;entry:string;files:{path:string;text:string}[];references:string[];optionalReferences:string[];compatibility:string;requires:string[];conflicts:string[]}};
const scopeName=(s:string)=>({user:'个人技能',repo:'项目技能',system:'系统技能',admin:'管理员技能'}[s]||'其他来源');

export function CodexSkillImport({request,onPick,onClose,onConnected}:{request:PromptRequest;onPick:(value:CodexSkillPreview)=>void;onClose:()=>void;onConnected?:()=>Promise<void>}){
  const [catalog,setCatalog]=useState<Catalog|null>(null),[query,setQuery]=useState(''),[scope,setScope]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[selected,setSelected]=useState(''),[preview,setPreview]=useState<CodexSkillPreview|null>(null),[needsConnection,setNeedsConnection]=useState(false);
  const alive=useRef(true),sequence=useRef(0),operation=useRef(false),controller=useRef<AbortController|null>(null),panel=useRef<HTMLElement>(null);
  const api=<T,>(p:string,body?:unknown)=>request<T>(p,body,body===undefined?undefined:'POST',{signal:AbortSignal.any([AbortSignal.timeout(20000),...(controller.current?[controller.current.signal]:[])])});
  async function load(connect=false){
    if(operation.current)return;operation.current=true;const seq=++sequence.current;controller.current?.abort();controller.current=new AbortController();setBusy('正在读取本机 Codex 技能');setError('');setSelected('');setPreview(null);
    try{
      const status=await api<{connected:boolean}>('/prompt-codex/status');
      if(!alive.current||sequence.current!==seq)return;
      if(!status.connected){setCatalog(null);setNeedsConnection(true);if(!connect)return;setBusy('正在连接本机 Codex');await api('/prompt-codex/connect',{});}
      const next=await api<Catalog>('/storyboard-generation/skills');
      if(alive.current&&sequence.current===seq){setCatalog(next);setNeedsConnection(false);await onConnected?.();}
    }catch(e){if(alive.current&&sequence.current===seq&&(e as Error).name!=='AbortError')setError((e as Error).message);}
    finally{operation.current=false;if(alive.current&&sequence.current===seq)setBusy('');}
  }
  useEffect(()=>{alive.current=true;panel.current?.scrollIntoView({block:'nearest'});void load();return()=>{alive.current=false;sequence.current++;controller.current?.abort();};},[]);
  async function inspect(skill:Skill){
    if(!catalog||busy)return;const seq=++sequence.current;setSelected(skill.id);setPreview(null);setBusy('正在读取技能正文及文字引用');setError('');
    try{const result=await api<CodexSkillPreview>('/storyboard-generation/skills/preview',{catalogId:catalog.catalogId,skillId:skill.id});if(alive.current&&sequence.current===seq)setPreview(result);}
    catch(e){if(alive.current&&sequence.current===seq&&(e as Error).name!=='AbortError')setError((e as Error).message);}
    finally{if(alive.current&&sequence.current===seq)setBusy('');}
  }
  const q=query.trim().toLocaleLowerCase(),visible=(catalog?.skills??[]).filter(s=>(!scope||s.scope===scope)&&(!q||(s.title+' '+s.name+' '+s.description).toLocaleLowerCase().includes(q)));
  return <section className="sbg-skill-picker" aria-label="从 Codex 导入技能" ref={panel}>
    <header><div><h3>从 Codex 导入技能</h3><p>列表由本机 Codex 返回。选择后预览并复制为本地规则版本，不会运行技能或发送生成请求。</p></div><button type="button" aria-label="关闭 Codex 技能列表" onClick={onClose}><X size={16}/></button></header>
    <div className="sbg-row"><input aria-label="搜索 Codex 技能" placeholder="搜索技能名称或用途" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Codex 技能来源" value={scope} onChange={e=>setScope(e.target.value)}><option value="">全部来源</option>{['user','repo','system','admin'].map(s=><option key={s} value={s}>{scopeName(s)}</option>)}</select><button disabled={!!busy} onClick={()=>void load()}><RefreshCw size={14}/>重新读取技能</button><small>{visible.length} 个技能</small></div>
    {busy&&<p role="status">{busy}…</p>}{error&&<p role="alert" className="sbg-error">{error}</p>}
    {needsConnection&&!busy&&<div><p>尚未连接本机 Codex。连接后可读取已安装技能，不会发送生成请求。</p><button type="button" onClick={()=>void load(true)}>连接并读取技能</button></div>}
    {!!catalog?.unreadableCount&&<p className="sbg-warning">有 {catalog.unreadableCount} 项未能被 Codex 解析，请在本机 Codex 检查后刷新。</p>}
    <div className="sbg-skill-columns"><div className="sbg-skill-list" aria-label="Codex 技能列表">{visible.slice(0,100).map(s=><button key={s.id} type="button" aria-pressed={selected===s.id} disabled={!!busy||!s.importable} onClick={()=>void inspect(s)}><strong>{s.title}</strong><small>{s.name} · {scopeName(s.scope)}{!s.enabled?' · 已停用':!s.importable?' · 无本机正文':''}{s.toolDependencies?' · 需要额外工具':''}</small><span>{s.description}</span></button>)}{visible.length>100&&<p>仅显示前100项，请搜索名称或按来源缩小范围。</p>}{!busy&&catalog&&!visible.length&&<p>当前筛选下没有技能。可以更改搜索或刷新 Codex 列表。</p>}</div>
      <div className="sbg-skill-body">{preview?<><h3>{preview.name}</h3><p>{preview.fileCount} 个文字文件 · {(preview.totalBytes/1024).toFixed(1)} KiB · {preview.revision}</p><p>相关性未自动判定；输出仍受系统 JSON 格式约束。脚本、外部服务和其他工具权限不会随技能导入。</p>{preview.warnings.map((w,i)=><p key={i} className="sbg-warning">{w}</p>)}{preview.package.files.map(f=><details key={f.path} open={f.path===preview.package.entry}><summary>{f.path}</summary><pre>{f.text}</pre></details>)}<button className="sbg-primary" disabled={!!busy} onClick={()=>onPick(preview)}>使用此技能填写导入表单</button><p>下一步可以编辑名称、用途与正文，再检查保存；不会自动选中为本轮协议。</p></>:<p>点击左侧技能，查看本次会导入的实际正文和引用。</p>}</div>
    </div>
  </section>;
}
