// Explicit test preload only. Production does not inspect these test environment flags.
import {VideoBindingV2} from '../../../server/storyboard-video-v2/store.mjs';
const original=VideoBindingV2.prototype.upgradeCheckpoint;
VideoBindingV2.prototype.upgradeCheckpoint=async function(phase){
 original.call(this);if(phase!==process.env.VIDEO_V2_TEST_PHASE)return;
 if(process.env.VIDEO_V2_TEST_HOLD==='1'){
  process.send?.({phase});let timer;
  try{await Promise.race([new Promise(resolve=>{process.once('message',resolve);process.once('SIGTERM',resolve);}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned checkpoint timeout')),10000))]);}finally{clearTimeout(timer);}
  original.call(this);
 }else throw Object.assign(Error('owned startup checkpoint interruption'),{code:'VIDEO_V2_UPGRADE_TEST_INTERRUPTED'});
};
