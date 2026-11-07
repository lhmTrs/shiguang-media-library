import path from 'node:path';
import fs from 'node:fs/promises';
import {ConciergeStore} from './store.mjs';
import {ConciergeService} from './service.mjs';
import {ConciergeAttachments} from './attachments.mjs';
import {createConciergeCapabilities} from './capabilities.mjs';
import {conciergeRouter} from './router.mjs';
export async function createConcierge({lib,dataDir,sendMedia,withActivity,transportFactory}){
  const root=path.join(await fs.realpath(dataDir),'concierge'),store=new ConciergeStore(lib).init();
  const attachments=new ConciergeAttachments(path.join(root,'attachments'));
  const service=await new ConciergeService(store,attachments,createConciergeCapabilities(),{root,withActivity,transportFactory}).init();
  return{service,router:conciergeRouter(service,{sendMedia,withActivity}),beginClose:()=>service.beginClose(),close:()=>service.close()};
}
