// Playback consumes the server's canonical ordered runs; it never allocates shots.
export type PreviewRun={kind:'video'|'black';startMs:number;endMs:number;sourceId?:string;sourceInMs?:number};
export type PreviewSource={id:string;name:string;durationMs:number;mediaUrl:string;available?:boolean};
export type PlayerSnapshot={positionMs:number;playing:boolean;buffering:boolean;error:string;runIndex:number};
type Slot={element:HTMLVideoElement;source:PreviewSource;off:()=>void;preload:boolean};
export class VideoPreviewPlayer{
 private slots:Slot[]=[];private active:Slot|null=null;private runs:PreviewRun[]=[];private sources=new Map<string,PreviewSource>();private duration=0;
 private position=0;private runIndex=-1;private wants=false;private waiting=false;private failure='';private disposed=false;private validPlan=false;private intent=0;private frame=0;private clock=0;private target:number|null=null;private targetAssigned=false;
 constructor(private host:HTMLElement,private changed:(state:PlayerSnapshot)=>void){}
 get snapshot():PlayerSnapshot{return{positionMs:Math.round(this.position),playing:this.wants,buffering:this.waiting,error:this.failure,runIndex:this.runIndex};}
 private emit(){if(!this.disposed)this.changed(this.snapshot);}
 private schedule(){cancelAnimationFrame(this.frame);if(this.wants&&!this.disposed)this.frame=requestAnimationFrame(t=>this.tick(t));}
 private clearSlot(slot:Slot){slot.off();slot.element.muted=true;slot.element.pause();slot.element.removeAttribute('src');slot.element.load();slot.element.remove();this.slots=this.slots.filter(s=>s!==slot);if(this.active===slot)this.active=null;}
 private fail(message:string){this.intent++;this.wants=false;this.waiting=false;this.failure=message;cancelAnimationFrame(this.frame);for(const slot of this.slots)slot.element.pause();this.emit();}
 private create(source:PreviewSource,preload:boolean):Slot{
  const url=new URL(source.mediaUrl,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))throw Error('视频读取地址无效，请重新读取方案');
  const element=document.createElement('video');element.playsInline=true;element.preload='auto';element.muted=true;element.controls=false;element.playbackRate=1;element.setAttribute('aria-label',preload?'静音预加载视频':'当前预览视频');element.hidden=preload;
  const slot:Slot={element,source,preload,off:()=>{}};
  const valid=()=>!this.disposed&&this.slots.includes(slot);
  const ready=()=>{if(!valid()||this.active!==slot)return;if(this.target!==null)this.prepare(slot);else if(!element.seeking&&element.readyState>=2){this.waiting=false;this.emit();if(this.wants)this.begin(slot);}};
  const waiting=()=>{if(!valid()||this.active!==slot||!this.wants)return;this.intent++;this.waiting=true;this.clock=0;element.pause();this.emit();};
  const stalled=()=>{if(element.readyState<2)waiting();};
  const playing=()=>{if(!valid()||this.active!==slot)return;if(!this.wants){element.pause();return;}if(element.paused)return;if(this.target!==null){this.prepare(slot);return;}this.waiting=false;this.clock=0;this.emit();this.schedule();};
  const error=()=>{if(valid())this.fail('视频“'+source.name+'”无法读取或编码不受浏览器支持，请核对原文件后重新导入或重试。');};
  const ended=()=>{if(!valid()||this.active!==slot||!this.wants||this.target!==null)return;const run=this.runs[this.runIndex];const expected=(run.sourceInMs??0)+run.endMs-run.startMs;if(element.currentTime*1000<expected-150){this.fail('视频提前结束，原文件或解码时长与方案不一致，请重新导入。');return;}this.move(run.endMs,true);};
  const rate=()=>{if(element.playbackRate!==1)element.playbackRate=1;};
  const handlers:[string,EventListener][]=[['loadedmetadata',ready],['loadeddata',ready],['canplay',ready],['seeked',ready],['waiting',waiting],['stalled',stalled],['seeking',waiting],['playing',playing],['error',error],['ended',ended],['ratechange',rate]];
  for(const [name,fn]of handlers)element.addEventListener(name,fn);slot.off=()=>{for(const [name,fn]of handlers)element.removeEventListener(name,fn);};
  this.slots.push(slot);this.host.append(element);element.src=url.href;element.load();return slot;
 }
 setPlan(runs:PreviewRun[],sources:PreviewSource[],durationMs:number,positionMs=0){
  this.pause();this.validPlan=false;for(const slot of [...this.slots])this.clearSlot(slot);this.runs=runs;this.sources=new Map(sources.map(s=>[s.id,s]));this.duration=durationMs;this.failure='';
  if(!Number.isSafeInteger(durationMs)||durationMs<0||runs.length>10000||(!runs.length&&durationMs!==0)||runs.some((r,i)=>!Number.isSafeInteger(r.startMs)||!Number.isSafeInteger(r.endMs)||r.startMs!==(i?runs[i-1].endMs:0)||r.endMs<=r.startMs||!['video','black'].includes(r.kind)||r.kind==='video'&&(!r.sourceId||!Number.isSafeInteger(r.sourceInMs)||(r.sourceInMs??-1)<0))||runs.length&&runs.at(-1)!.endMs!==durationMs){this.fail('预览时间方案无效，请重新读取');return;}
  this.validPlan=true;this.move(positionMs,false);
 }
 private prepare(slot:Slot){
  if(this.active!==slot||this.disposed||this.target===null)return;const el=slot.element;if(el.readyState<1)return;
  if(!Number.isFinite(el.duration)){this.fail('浏览器无法读取视频时长，请重新导入受支持的视频。');return;}
  const target=this.target/1000;
  if(target>el.duration+0.05){this.fail('视频区间超出浏览器可读取范围，请重新校准。');return;}
  if(!this.targetAssigned){this.targetAssigned=true;try{el.currentTime=target;}catch{this.fail('无法定位视频区间，请重试或重新校准。');return;}}
  if(el.seeking||el.readyState<2)return;
  if(Math.abs(el.currentTime-target)>0.075){this.fail('浏览器未能定位到目标区间，请重试或重新校准。');return;}this.target=null;this.waiting=false;this.emit();if(this.wants)this.begin(slot);
 }
 private begin(slot:Slot){
  if(!this.wants||this.active!==slot||this.target!==null||this.disposed)return;const token=this.intent;const el=slot.element;el.muted=false;el.playbackRate=1;
  void el.play().then(()=>{if(this.disposed||this.active!==slot||!this.wants){el.muted=true;el.pause();return;}if(token!==this.intent)return;this.waiting=el.seeking||el.readyState<2;this.clock=0;this.emit();this.schedule();}).catch(()=>{if(!this.disposed&&token===this.intent&&this.active===slot&&this.wants)this.fail('浏览器未能开始播放，请点击播放重试；若仍失败，请检查视频编码。');});
 }
 private preload(){
  const next=this.runs.slice(this.runIndex+1).find(r=>r.kind==='video'),source=next?.sourceId?this.sources.get(next.sourceId):null;
  for(const s of [...this.slots])if(s!==this.active&&s.source.id!==source?.id)this.clearSlot(s);
  if(source&&source.id!==this.active?.source.id&&!this.slots.some(s=>s.source.id===source.id)){
   if(source.available===false)return;try{this.create(source,true);}catch(e){this.fail((e as Error).message);}
  }
 }
 private move(position:number,wants:boolean){
  if(this.disposed)return;this.intent++;cancelAnimationFrame(this.frame);this.wants=wants;this.position=Math.min(this.duration,Math.max(0,Number.isFinite(position)?position:0));this.clock=0;this.target=null;this.targetAssigned=false;
  const index=this.runs.findIndex(r=>this.position>=r.startMs&&this.position<r.endMs);this.runIndex=index;
  if(index<0){this.wants=false;this.waiting=false;for(const slot of this.slots){slot.element.pause();slot.element.muted=true;slot.element.hidden=true;}this.emit();return;}
  const run=this.runs[index];
  if(run.kind==='black'){
   for(const slot of this.slots){slot.element.pause();slot.element.muted=true;slot.element.hidden=true;}this.active=null;this.waiting=false;this.emit();this.preload();this.schedule();return;
  }
  const source=this.sources.get(run.sourceId!);if(!source||source.available===false){this.fail('本段视频来源不可用，请重新确认或导入；没有用黑场替代文件错误。');return;}
  const end=(run.sourceInMs??0)+run.endMs-run.startMs;if(!Number.isSafeInteger(source.durationMs)||source.durationMs<=0||!Number.isSafeInteger(end)||end>source.durationMs||(run.sourceInMs??-1)<0){this.fail('视频源区间无效，请重新校准。');return;}
  for(const slot of this.slots){slot.element.pause();slot.element.muted=true;slot.element.hidden=true;}
  let slot=this.slots.find(s=>s.source.id===source.id);
  try{if(!slot){for(const s of [...this.slots])if(s!==this.active)this.clearSlot(s);if(this.slots.length>=2)this.clearSlot(this.slots[0]);slot=this.create(source,false);}}
  catch(e){this.fail((e as Error).message);return;}
  const previous=this.active;this.active=slot;slot.preload=false;slot.element.hidden=false;slot.element.setAttribute('aria-label','当前预览视频');if(previous&&previous!==slot){previous.preload=true;previous.element.setAttribute('aria-label','静音预加载视频');}
  this.target=(run.sourceInMs??0)+this.position-run.startMs;this.waiting=true;this.emit();this.prepare(slot);this.preload();this.schedule();
 }
 private tick(now:number){
  if(this.disposed||!this.wants)return;const run=this.runs[this.runIndex];if(!run)return;
  if(run.kind==='black'){if(this.clock)this.position=Math.min(run.endMs,this.position+now-this.clock);this.clock=now;}
  else if(this.active&&this.target===null&&!this.waiting&&!this.active.element.seeking&&this.active.element.readyState>=2&&!this.active.element.paused){this.position=Math.max(run.startMs,Math.min(run.endMs,run.startMs+this.active.element.currentTime*1000-(run.sourceInMs??0)));}
  if(this.position>=run.endMs-1){this.move(run.endMs,true);return;}this.emit();this.schedule();
 }
 play(){if(this.disposed||!this.validPlan)return;const failed=!!this.failure;this.failure='';if(failed){for(const slot of [...this.slots])this.clearSlot(slot);this.move(this.position>=this.duration?0:this.position,true);return;}if(this.position>=this.duration)this.move(0,true);else{this.intent++;this.wants=true;this.clock=0;const run=this.runs[this.runIndex];if(run?.kind==='video'){if(!this.active||this.active.source.id!==run.sourceId){this.move(this.position,true);return;}if(this.target!==null)this.prepare(this.active);else this.begin(this.active);}else this.schedule();this.emit();}}
 pause(){this.intent++;this.wants=false;this.clock=0;cancelAnimationFrame(this.frame);for(const slot of this.slots)slot.element.pause();this.emit();}
 seek(positionMs:number){this.failure='';this.move(positionMs,this.wants);}
 retry(){this.failure='';const position=this.position;for(const slot of [...this.slots])this.clearSlot(slot);this.move(position,false);}
 dispose(){if(this.disposed)return;this.pause();this.disposed=true;for(const slot of [...this.slots])this.clearSlot(slot);cancelAnimationFrame(this.frame);}
}
