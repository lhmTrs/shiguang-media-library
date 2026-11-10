import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';

const failure=(code,message)=>Object.assign(new Error(message+'；原文件仍保留，可在访达中打开'),{code,status:503});
export const previewSourceLimit=128*1024*1024;
const outputLimit=4*1024*1024;

// Same macOS tool and 1200px bound as the library thumbnail path. The input is
// a private, verified snapshot, never the mutable selected pathname.
export async function convertHeic(input,output,{signal,media}={}) {
  signal?.throwIfAborted();
  if(media?.closing)throw failure('IMAGE_PREVIEW_CLOSING','图片预览正在关闭');
  if(process.platform!=='darwin')throw failure('IMAGE_PREVIEW_UNAVAILABLE','此系统暂不支持 HEIC 兼容预览');
  const child=spawn('/usr/bin/sips',['-s','format','jpeg','--resampleHeightWidthMax','1200',input,'--out',output],
    {stdio:'ignore',shell:false,windowsHide:true});
  let spawnError,stopped;
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.once('error',e=>{spawnError=e;});
  media?.children.add(child);media?.exits.set(child,closed);
  const stop=reason=>{stopped??=reason;child.kill('SIGTERM');};
  const abort=()=>stop(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop(failure('IMAGE_PREVIEW_TIMEOUT','图片预览转换超时，请稍后重试')),10000);
  try {
    if(signal?.aborted)abort();
    const result=await closed;
    if(stopped)throw stopped;
    if(spawnError)throw failure('IMAGE_PREVIEW_UNAVAILABLE','系统图片转换工具不可用');
    if(result.code!==0||result.signal)throw failure('IMAGE_PREVIEW_FAILED','HEIC 图片预览转换失败，请重新选择或稍后重试');
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    media?.children.delete(child);media?.exits.delete(child);
  }
}

// Two admitted requests, no wait queue or shared cancellation. Only bounded
// JPEG bytes are cached; every hit still requires the caller's source proof.
export class ImagePreviewCache {
  constructor({runner=convertHeic,maxEntries=16,maxBytes=16*1024*1024,ttlMs=600000}={}) {
    this.runner=runner;this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.ttlMs=ttlMs;
    this.entries=new Map();this.bytes=0;this.active=0;
  }
  acquire() {
    if(this.active>=2)throw Object.assign(Error('图片预览繁忙，请稍后重新读取'),{code:'IMAGE_PREVIEW_BUSY',status:429});
    this.active++;let released=false;
    return()=>{if(!released){released=true;this.active--;}};
  }
  remove(key) {const old=this.entries.get(key);if(old){this.bytes-=old.bytes.length;this.entries.delete(key);}}
  async preview(input,output,key,context) {
    context.signal?.throwIfAborted();
    for(const [k,v]of this.entries)if(v.expires<=Date.now())this.remove(k);
    const cached=this.entries.get(key);
    if(cached){this.entries.delete(key);this.entries.set(key,cached);return cached.bytes;}
    await this.runner(input,output,context);context.signal?.throwIfAborted();
    const stat=await fs.lstat(output);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<4||stat.size>outputLimit||await fs.realpath(output)!==output)
      throw failure('IMAGE_PREVIEW_FAILED','兼容预览副本无效或过大');
    const handle=await fs.open(output,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let bytes;
    try {
      const current=await handle.stat();
      if(current.dev!==stat.dev||current.ino!==stat.ino||current.size!==stat.size)throw failure('IMAGE_PREVIEW_FAILED','兼容预览副本已变化');
      bytes=await handle.readFile();
    } finally {await handle.close();}
    if(bytes.length!==stat.size||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)
      throw failure('IMAGE_PREVIEW_FAILED','系统未能生成有效 JPEG 预览');
    this.remove(key);
    if(bytes.length<=this.maxBytes&&this.maxEntries>0){
      while(this.entries.size>=this.maxEntries||this.bytes+bytes.length>this.maxBytes)this.remove(this.entries.keys().next().value);
      this.entries.set(key,{bytes,expires:Date.now()+this.ttlMs});this.bytes+=bytes.length;
    }
    return bytes;
  }
}
export const imagePreviewCache=new ImagePreviewCache();
