import {verifyShutdownReceipt} from '../server/application-shutdown.mjs';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safeFailure=()=>({phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});
function localOrigin(value){
 if(typeof value!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(value))throw Error('INVALID_LOCAL_URL');
 const u=new URL(value);
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||Number(u.port)<1||Number(u.port)>65535||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('INVALID_LOCAL_URL');
 return u.origin;
}
async function boundedJSON(response){
 const reader=response.body?.getReader();if(!reader)throw Error('INVALID_RESPONSE');let size=0,chunks=[];
 try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096)throw Error('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Import/construction do not read server.json, open paths or call fetch.
// readReceipt is a trusted integration adapter, NOT a request-supplied file path.
// This preparation module has no production cross-process receipt reader yet.
export function createShutdownClient({fetchImpl=globalThis.fetch,readReceipt,budgetMs=10000,pollMs=25}={}){
 if(!Number.isInteger(budgetMs)||budgetMs<20||budgetMs>30000||!Number.isInteger(pollMs)||pollMs<5||pollMs>1000)throw Error('INVALID_CLIENT_CONFIG');
 let current=null,pending=null;
 function stop(command){
  let origin;
  try{if(!command||Object.keys(command).sort().join()!=='libraryId,requestId,runId,url'||!uuid.test(command.runId)||!uuid.test(command.requestId)||typeof command.libraryId!=='string'||!command.libraryId||command.libraryId.length>128||command.runId===command.libraryId)throw Error();origin=localOrigin(command.url);}catch{return Promise.resolve(safeFailure());}
  const expected={libraryId:command.libraryId,runId:command.runId,requestId:command.requestId};const key=JSON.stringify([origin,...Object.values(expected)]);
  if(current)return key===current?pending:Promise.resolve({phase:'UNKNOWN',code:'SHUTDOWN_CONFLICT'});
  if(typeof fetchImpl!=='function'||typeof readReceipt!=='function')return Promise.resolve({phase:'UNSUPPORTED',code:'RECEIPT_OBSERVER_UNAVAILABLE'});
  current=key;const deadline=performance.now()+budgetMs;
  const bounded=async operation=>{
   const controller=new AbortController();let timer;
   try{
    if(performance.now()>=deadline)throw Error('TIMEOUT');
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('TIMEOUT'));},Math.max(0,deadline-performance.now()));});
    const result=await Promise.race([Promise.resolve().then(()=>{if(performance.now()>=deadline)throw Error('TIMEOUT');return operation(controller.signal);}),timeout]);
    // A timer cannot preempt synchronous code or a microtask chain. A late
    // resolved operation still fails even if it wins the Promise.race.
    if(performance.now()>=deadline)throw Error('TIMEOUT');
    return result;
   }finally{clearTimeout(timer);controller.abort();}
  };
  const requestJSON=(route,init={})=>bounded(async signal=>{const response=await fetchImpl(origin+route,{...init,redirect:'error',signal});if(response.redirected||![200,202].includes(response.status))throw Error('REQUEST_REFUSED');return{status:response.status,headers:response.headers,json:await boundedJSON(response)};});
  pending=(async()=>{
   try{
    const session=await requestJSON('/api/session');const identity=session.json;
    if(session.status!==200||identity.app!=='shiguang-local-media'||identity.instanceId!==expected.libraryId||identity.runId!==expected.runId||typeof identity.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(identity.token))throw Error('WRONG_IDENTITY');
    const token=identity.token;const cookie=session.headers.get('set-cookie')?.split(';')[0];if(!cookie||!/^media_session=[A-Za-z0-9_-]{16,256}$/.test(cookie))throw Error('INVALID_SESSION');
    const result=await requestJSON('/api/application/shutdown',{method:'POST',headers:{'content-type':'application/json','x-local-token':token,cookie,origin},body:JSON.stringify({runId:expected.runId,requestId:expected.requestId})});
    if(result.status!==202||result.json.phase!=='ACCEPTED'||result.json.runId!==expected.runId||result.json.requestId!==expected.requestId)throw Error('NOT_ACCEPTED');
    while(performance.now()<deadline){
     const receipt=await bounded(()=>readReceipt());
     const valid=receipt&&Buffer.byteLength(JSON.stringify(receipt))<=4096&&verifyShutdownReceipt(receipt,expected,token);
     if(valid&&performance.now()<deadline)return {phase:'CLOSED_KNOWN',runId:expected.runId,requestId:expected.requestId};
     await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(0,deadline-performance.now()))));
    }
    return safeFailure();
   }catch{return safeFailure();}
  })();return pending;
 }
 return Object.freeze({stop});
}
