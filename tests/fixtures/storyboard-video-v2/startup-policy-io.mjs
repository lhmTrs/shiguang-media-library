// Explicit test preload: pause inside the actual last policy open, after checkpoint.
import fs from 'node:fs/promises';
import {VideoBindingV2} from '../../../server/storyboard-video-v2/store.mjs';
const checkpoint=VideoBindingV2.prototype.upgradeCheckpoint,open=fs.open;let deleting=false,held=false;
VideoBindingV2.prototype.upgradeCheckpoint=function(phase){checkpoint.call(this,phase);if(phase==='delete')deleting=true;};
fs.open=async function(file,...args){
 if(deleting&&!held&&String(file).endsWith('/upgrade-policy.json')){
  held=true;let timer;
  try{await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('owned policy IO timeout')),10000);process.once('SIGTERM',()=>setTimeout(resolve,10));process.send?.({phase:'delete-policy-await'});});}finally{clearTimeout(timer);}
 }
 return open.call(this,file,...args);
};
