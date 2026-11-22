const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unconfirmed=()=>Object.assign(Error('运行实例身份尚未核清，请核对原实例；未启动另一个服务'),{code:'RUNTIME_IDENTITY_UNCONFIRMED'});
export function runtimeIdentityMatches(expected,session,binding){
 return typeof expected?.libraryId==='string'&&expected.libraryId.length>0&&expected.libraryId.length<=128&&uuid.test(expected.runId||'')&&session?.app==='shiguang-local-media'&&session.instanceId===expected.libraryId&&binding?.app==='shiguang-local-media'&&binding.libraryId===expected.libraryId&&binding.runId===expected.runId;
}
async function json(response){
 if(response.status!==200||response.redirected)throw unconfirmed();const reader=response.body?.getReader();if(!reader)throw unconfirmed();let count=0,parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>4096)throw unconfirmed();parts.push(Buffer.from(value));}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw unconfirmed();}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
// Shared startup/doctor binding. It is discovery, never a shutdown completion
// claim. Cookie/token values remain private; only library/run identity returns.
export async function probeRuntimeBinding(record,{fetchImpl=globalThis.fetch,timeoutMs=1500}={}){
 if(!record||!uuid.test(record.runId||'')||typeof record.instanceId!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(record.url||''))throw unconfirmed();
 const u=new URL(record.url);if(!u.port||Number(u.port)>65535||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw unconfirmed();const origin=u.origin,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetchImpl(origin+'/api/session',{redirect:'error',signal:controller.signal});const session=await json(response),cookie=response.headers.get('set-cookie')?.split(';')[0];if(!cookie||!/^media_session=[A-Za-z0-9_-]{16,256}$/.test(cookie))throw unconfirmed();
  const binding=await json(await fetchImpl(origin+'/api/application/identity',{headers:{cookie,origin},redirect:'error',signal:controller.signal}));
  if(!runtimeIdentityMatches({libraryId:record.instanceId,runId:record.runId},session,binding))throw unconfirmed();return{libraryId:binding.libraryId,runId:binding.runId};
 }finally{clearTimeout(timer);controller.abort();}
}
