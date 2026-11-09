import {useFeedbackToast} from '../global-feedback';
import {useEffect,useRef,useState} from 'react';
import {Mic,Upload,Trash2} from 'lucide-react';
import type {PromptRequest} from '../PromptTemplateWorkspace';

type Clip={id:string;name:string;bytes:number;ext:string;mime:string;sha256:string};
type Profile={version:1;description:string;clip:Clip|null};
const empty=():Profile=>({version:1,description:'',clip:null});
const encode=(file:File)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('语音文件读取失败，请重新选择'));reader.onabort=()=>reject(Error('语音文件读取已取消'));reader.readAsDataURL(file);});

export function CharacterVoice({assetId,revision,value,disabled,active,request,onChange,onBusy}:{assetId:string;revision:number;value?:string;disabled:boolean;active:boolean;request:PromptRequest;onChange:(value:string)=>void;onBusy:(busy:boolean)=>void}){
  let profile=empty(),invalid=false;try{if(value)profile=JSON.parse(value);}catch{invalid=true;}
  const [error,setError]=useState(''),[uploading,setUploading]=useState(false),[duration,setDuration]=useState<number|null>(null);
  useFeedbackToast(error, {source: '项目资产', active: active});
  const input=useRef<HTMLInputElement>(null),audio=useRef<HTMLAudioElement>(null),alive=useRef(true),working=useRef(false),latest=useRef(profile);latest.current=profile;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;audio.current?.pause();};},[]);
  useEffect(()=>{if(!active)audio.current?.pause();},[active]);
  useEffect(()=>{setError('');setDuration(null);},[profile.clip?.id]);
  const change=(p:Profile)=>onChange(JSON.stringify(p));
  async function add(file?:File){
    if(!file||working.current||disabled)return;
    if(file.size<1||file.size>10*1024*1024){setError('语音文件最多10 MiB，请选择较短的声音参考');return;}
    if(!/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)){setError('请选择 MP3、WAV、M4A、AAC、OGG 或 FLAC 语音文件');return;}
    working.current=true;setUploading(true);setError('');onBusy(true);
    try{const base64=await encode(file);if(!alive.current)return;const r=await request<{clip:Clip}>('/project-assets/assets/'+assetId+'/voice',{name:file.name,base64,expected_revision:revision},'POST',{signal:AbortSignal.timeout(60000)});if(alive.current)change({...latest.current,clip:r.clip});}
    catch(e){if(alive.current)setError((e as Error).message||'添加语音失败，当前资料已保留');}
    finally{working.current=false;if(alive.current)setUploading(false);onBusy(false);}
  }
  return <section className="ca-voice" aria-label="角色语音">
    <div className="ca-section-head"><div><h3><Mic size={18}/>角色语音</h3><p className="ca-muted">保存声音参考和声音说明，方便保持角色声线一致。</p></div></div>
    <label className="ca-field"><span>声音说明</span><textarea aria-label="声音说明" rows={5} maxLength={5000} disabled={disabled||uploading} placeholder="例如：成年男性，中低音，语速平稳，略带沙哑；情绪克制，避免播音腔。" value={profile.description} onChange={e=>change({...profile,description:e.target.value})}/></label>
    <input ref={input} type="file" hidden accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,audio/*" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';void add(file);}}/>
    {profile.clip?<article className="ca-voice-card"><div><strong>{profile.clip.name}</strong><small>{(profile.clip.bytes/1024/1024).toFixed(2)} MiB{duration!==null?' · '+duration.toFixed(1)+' 秒':''}</small></div><audio ref={audio} key={profile.clip.id} aria-label="试听角色语音" controls preload="metadata" src={'/api/project-assets/assets/'+assetId+'/voice/'+profile.clip.id} onLoadedMetadata={e=>setDuration(Number.isFinite(e.currentTarget.duration)?e.currentTarget.duration:null)} onError={()=>setError('语音暂时无法试听：副本可能缺失、已变化或当前浏览器不支持此编码。声音说明及当前关联仍保留。')}/><div className="ca-actions"><button type="button" disabled={disabled||uploading} onClick={()=>input.current?.click()}><Upload size={15}/>替换语音</button><button type="button" disabled={disabled||uploading} onClick={()=>{audio.current?.pause();change({...profile,clip:null});setError('');}}><Trash2 size={15}/>移除语音关联</button></div></article>:<div className="ca-voice-empty"><Mic size={28}/><p>添加一段角色的声音参考</p><button type="button" disabled={disabled||uploading} onClick={()=>input.current?.click()}><Upload size={15}/>添加语音文件</button></div>}
    {uploading&&<p role="status">正在添加角色语音…</p>}{(error||invalid)&&<p role="alert" className="ca-voice-error">{error||'原角色语音资料无法解析，请先保留资料并重新载入。'}</p>}
    <p className="ca-muted">支持 MP3 / WAV / M4A / AAC / OGG / FLAC，单个文件最多10 MiB。添加后点击上方“保存资料”。文件保存本机副本，替换或移除关联会保留历史副本。</p>
  </section>;
}
