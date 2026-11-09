import {useFeedbackToast} from '../global-feedback';
import {useEffect,useRef,useState} from 'react';
import {BookOpen,Save,Search,X} from 'lucide-react';
import {errorText,scopeQuery,type Rules} from './types';

type Client={read:<T>(path:string,signal?:AbortSignal)=>Promise<T>;write:<T>(path:string,body:unknown,method?:string)=>Promise<T>};
export function ReferencePanel({scope,kind,client,close}:{scope:string;kind:'rules'|'docs';client:Client;close:()=>void}){
  const [rules,setRules]=useState<Rules|null>(null),[text,setText]=useState(''),[catalog,setCatalog]=useState<unknown>(null),[docs,setDocs]=useState<unknown>(null),[query,setQuery]=useState(''),[operationId,setOperationId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useFeedbackToast(error, {source: '自由管家'});
  useFeedbackToast(notice, {source: '自由管家', kind: 'auto'});
  const alive=useRef(true),readVersion=useRef(0),saving=useRef(false),searchController=useRef<AbortController|null>(null),panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    alive.current=true;const previous=document.activeElement as HTMLElement|null;panel.current?.focus();const controller=new AbortController();setBusy(true);
    const work=kind==='rules'?client.read<Rules>('/rules'+scopeQuery(scope),controller.signal).then(v=>{if(alive.current){setRules(v);setText(v.text);}}):Promise.all([client.read('/capabilities'+scopeQuery(scope),controller.signal),client.read('/docs'+scopeQuery(scope),controller.signal)]).then(([c,d])=>{if(alive.current){setCatalog(c);setDocs(d);}});
    void work.catch(e=>{if(alive.current&&!controller.signal.aborted)setError(errorText(e));}).finally(()=>{if(alive.current)setBusy(false);});
    return()=>{alive.current=false;controller.abort();searchController.current?.abort();previous?.isConnected&&previous.focus({preventScroll:true});};
  },[scope,kind]);
  async function save(){
    if(!rules||saving.current)return;saving.current=true;setBusy(true);setError('');setNotice('');
    try{const v=await client.write<Rules>('/rules',{scope,text,expected_revision:rules.revision},'PUT');if(alive.current){setRules(v);setText(v.text);setNotice('规则已保存，从下一轮起生效。');}}
    catch(e){if(alive.current)setError(errorText(e)+'。编辑内容已保留；如版本冲突，请复制草稿后重新打开核对。');}
    finally{saving.current=false;if(alive.current)setBusy(false);}
  }
  async function search(){
    const version=++readVersion.current;searchController.current?.abort();const c=new AbortController();searchController.current=c;setBusy(true);setError('');
    try{const v=await client.read('/docs'+scopeQuery(scope)+(query?'&query='+encodeURIComponent(query):'')+(operationId?'&operationId='+encodeURIComponent(operationId):''),c.signal);if(alive.current&&version===readVersion.current)setDocs(v);}
    catch(e){if(alive.current&&!c.signal.aborted&&version===readVersion.current)setError(errorText(e));}
    finally{if(alive.current&&version===readVersion.current)setBusy(false);}
  }
  return <div className="concierge-reference" role="region" aria-label={kind==='rules'?'管家规则':'能力文档'} tabIndex={-1} ref={panel} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}}}>
    <header><strong><BookOpen size={15}/>{kind==='rules'?'管家规则':'按需能力文档'}</strong><button aria-label="关闭参考面板" onClick={close}><X size={16}/></button></header>
    <div className="concierge-reference-body">
      {error&&<p role="alert" className="concierge-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {kind==='rules'?<>
        <p>通用规则对所有项目生效，项目规则作为补充。本轮沿用开始时的规则，保存后从下一轮生效。</p>
        {scope!=='global'&&rules&&<details><summary>查看通用规则</summary><pre>{rules.globalText||rules.defaultText}</pre></details>}
        {rules&&<><details><summary>查看默认规则</summary><pre>{rules.defaultText}</pre></details><label>{scope==='global'?'通用规则':'本项目补充规则'}<textarea aria-label="编辑管家规则" value={text} onChange={e=>setText(e.target.value)} disabled={busy} rows={14}/></label><small>清空后保存恢复默认。规则不能扩大界面中未授权的资料修改权限。</small></>}
        <footer><button disabled={busy||!rules} onClick={()=>setText('')}>清空草稿</button><button disabled={busy||!rules} className="concierge-primary" onClick={()=>void save()}><Save size={14}/>{busy?'正在处理…':'保存规则'}</button></footer>
      </>:<>
        <p>目录和接口说明由当前管家能力定义直接读取。输入需求或操作编号，查看相关定义与调用示例。</p>
        <details><summary>查看本上下文能力目录</summary><pre>{catalog?JSON.stringify(catalog,null,2):'正在读取…'}</pre></details>
        <form onSubmit={e=>{e.preventDefault();void search();}}><label>查找能力<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：剧本、单镜修改、资产"/></label><label>操作编号（可选）<input value={operationId} onChange={e=>setOperationId(e.target.value)} placeholder="从目录复制 operationId"/></label><button disabled={busy}><Search size={14}/>{busy?'正在读取…':'读取相关文档'}</button></form>
        <pre aria-label="相关能力文档">{docs?typeof docs==='string'?docs:JSON.stringify(docs,null,2):'正在读取…'}</pre>
      </>}
    </div>
  </div>;
}
