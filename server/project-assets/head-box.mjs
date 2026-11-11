import {fault,idOK} from './model.mjs';
import {currentImageBinding,registeredPhoto} from './desktop-actions.mjs';
import {withHeadImage,imageDigest} from './image-import.mjs';

const MAX_BYTES=24*1024*1024,MAX_PIXELS=60_000_000,CACHE_MS=300_000;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const stale=()=>fault('图片绑定或原图已变化，请重新读取',409,{code:'IMAGE_BINDING_STALE'});
const transient=new Set(['NATIVE_TIMEOUT','NATIVE_HELPER_UNAVAILABLE','NATIVE_EXIT_UNSETTLED','APPLICATION_CLOSING','HOST_BUSY','ABORT_ERR']);
const platform=new Set(['DESKTOP_PLATFORM_UNAVAILABLE','DESKTOP_SESSION_UNAVAILABLE','NATIVE_COMPILER_UNAVAILABLE']);
const round=(n,scale)=>Math.round(n*scale)/scale;

// Use only face observations. A known frontal face can outrank larger profiles;
// an observation without yaw is not classified as frontal.
export function pickHeadBox(width,height,faces){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>MAX_PIXELS||!Array.isArray(faces)||faces.length>32)
    return {status:'error'};
  const valid=faces.filter(f=>f&&['x','y','w','h','confidence'].every(k=>Number.isFinite(f[k]))&&
    f.confidence>=.6&&f.x>=0&&f.y>=0&&f.w>=.015&&f.h>=.015&&f.x+f.w<=1.001&&f.y+f.h<=1.001);
  const group=f=>Number.isFinite(f.yaw)&&Math.abs(f.yaw)<=.40?2:Number.isFinite(f.yaw)&&Math.abs(f.yaw)>.8?0:1;
  const area=f=>f.w*f.h;
  valid.sort((a,b)=>group(b)-group(a)||area(b)-area(a));
  const [first,next]=valid;
  if(!first||next&&group(first)===group(next)&&area(next)>=area(first)*.78)return {status:'not_found'};
  const {x,y,w,h}=first,face={x,y,w,h},aspect=.75;
  const base=Math.min(width,height*aspect);
  const zoom=round(clamp(base/Math.max(w*width*1.55,h*height*aspect*1.55),1,3),100);
  const cropW=base/zoom,cropH=cropW/aspect;
  if(cropW<w*width||cropH<h*height)return {status:'not_found'};
  const left=clamp((x+w*.5)*width-cropW*.5,0,width-cropW);
  const top=clamp((y+h*.42)*height-cropH*.5,0,height-cropH);
  return {status:'found',width,height,face,crop:{x:width-cropW>.5?round(100*left/(width-cropW),10):50,y:height-cropH>.5?round(100*top/(height-cropH),10):50,zoom}};
}

export class ProjectAssetHeadBox {
  constructor(store,native,{enabled=process.platform==='darwin',withActivity=fn=>fn()}={}){
    this.store=store;this.native=enabled?native:null;this.withActivity=withActivity;
    this.cache=new Map();this.active=new Set();this.controller=new AbortController();
  }
  prepare(){
    if(!this.native||this.controller.signal.aborted)return;
    void this.native.track(()=>this.native.helper({prepare:true})).catch(e=>{this.prepareError=e.code||'NATIVE_FAILED';});
  }
  beginClose(){this.controller.abort();}
  async close(){
    this.beginClose();
    await Promise.all([Promise.allSettled([...this.active]),this.native?.close?.()]);
  }
  detect(binding){
    if(!this.native||platform.has(this.prepareError))return Promise.resolve({status:'unsupported'});
    if(this.prepareError)return Promise.resolve({status:'error'});
    if(this.controller.signal.aborted||this.active.size>=2)return Promise.resolve({status:'busy'});
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(2100)]);
    const work=Promise.resolve().then(()=>this.withActivity(async()=>{
      const media=registeredPhoto(this.store,binding);
      let file;
      try{file=await this.store.lib.checked(media.path,media.root_id);}catch{throw stale();}
      // EXIF is part of the verified content digest. HEIC and other decoders
      // have different output dimensions, so also key on the preview variant.
      const key='vision-face-v1:'+binding.expected_sha256+':'+/\.(heic|heif)$/i.test(file);
      const cached=this.cache.get(key);
      const verifyRegistration=()=>{
        let current;
        try{current=registeredPhoto(this.store,binding);}catch{throw stale();}
        if(current.path!==media.path||current.root_id!==media.root_id||current.registeredRootPath!==media.registeredRootPath)
          throw stale();
      };
      try{
        if(cached&&cached.until>Date.now()){
          const current=await imageDigest(file,{signal,maxBytes:MAX_BYTES});
          if(current.hash!==binding.expected_sha256)throw stale();
          verifyRegistration();return cached.result;
        }
        const result=await withHeadImage(file,binding.expected_sha256,MAX_BYTES,signal,async snapshot=>{
          const decoded=await this.native.detectFace(snapshot);
          return decoded.status==='unsupported'?{status:'unsupported'}:decoded.status==='not_found'?{status:'not_found'}:pickHeadBox(decoded.width,decoded.height,decoded.faces);
        });
        verifyRegistration();
        if(['found','not_found'].includes(result.status)){
          if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value);
          this.cache.set(key,{result,until:Date.now()+CACHE_MS});
        }
        return result;
      }catch(e){
        if(e.code==='IMAGE_BINDING_STALE'||e.status===409||e.code==='ENOENT')throw stale();
        if(e.status===415||platform.has(e.code))return {status:'unsupported'};
        if(signal.aborted||transient.has(e.code)||e.status===429)return {status:'busy'};
        return {status:'error'};
      }
    })).catch(e=>{
      if(e.code==='IMAGE_BINDING_STALE')throw e;
      return {status:signal.aborted||transient.has(e.code)||e.status===429?'busy':'error'};
    }).finally(()=>this.active.delete(work));
    this.active.add(work);
    let onAbort;
    const expired=new Promise(resolve=>{
      onAbort=()=>resolve({status:'busy'});
      if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
    });
    // Return a timely fallback without pretending that underlying work exited.
    return Promise.race([work,expired]).finally(()=>signal.removeEventListener('abort',onAbort));
  }
  async get(bindingId,revision){
    if(!idOK(bindingId))throw fault('图片绑定编号无效',400,{code:'IMAGE_SELECTION_INVALID'});
    if(revision===undefined){
      revision=this.store.db.prepare('SELECT revision FROM creative_image_bindings WHERE id=?').get(bindingId)?.revision;
      if(!revision)throw stale();
    }else{
      if(typeof revision!=='string'||!/^\d+$/.test(revision))throw fault('图片绑定版本无效');
      revision=Number(revision);
    }
    const {binding}=currentImageBinding(this.store,bindingId,revision),media=registeredPhoto(this.store,binding);
    const result=await this.detect(binding);
    const latest=currentImageBinding(this.store,bindingId,revision).binding, current=registeredPhoto(this.store,latest);
    if(latest.expected_sha256!==binding.expected_sha256||media.id!==current.id||media.path!==current.path||media.root_id!==current.root_id)throw stale();
    return {...result,bindingId,bindingRevision:revision};
  }
}
