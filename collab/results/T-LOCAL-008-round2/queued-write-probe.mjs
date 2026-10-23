import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Library } from '../../../server/library.mjs';
import { CloudAuth } from '../../../server/cloud-auth.mjs';
import { CloudManagement } from '../../../server/cloud-management.mjs';
import { startManagementCloud } from '../../../tests/cloud-management-mock.mjs';

const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gpt-management-queue-')));
let lib,cloud;
try {
  cloud=await startManagementCloud();lib=await new Library(path.join(base,'data')).init();
  const auth=await new CloudAuth(lib,{dataDir:lib.dataDir}).init();
  const configure=cert=>auth.configure({origin:cloud.origin,caPath:cloud.caCert,certPath:cert.cert,keyPath:cert.key});
  await configure(cloud.clientOwner);await auth.login({username:'owner',password:cloud.password});
  const mgmt=new CloudManagement(lib,{cloudAuth:auth});
  let reached,release;
  const arrived=new Promise(r=>{reached=r;});const gate=new Promise(r=>{release=r;});
  const proxy=auth.proxy.bind(auth);let first=true;
  auth.proxy=async (...args)=>{
    const value=await proxy(...args);
    if(first) {first=false;reached();await gate;}
    return value;
  };
  const a=mgmt.createAccount({username:'queue-first',displayName:'First'})
    .then(()=>({completed:true}),e=>({code:e.code}));
  await arrived;
  const b=mgmt.createAccount({username:'queue-after-switch',displayName:'Must not execute for new identity'})
    .then(()=>({completed:true}),e=>({code:e.code}));
  await auth.logout();await configure(cloud.clientAdmin);
  await auth.login({username:'admin',password:cloud.password});
  release();
  const outcomes=await Promise.all([a,b]);
  const created=[...cloud.state.accounts.values()].some(a=>a.username==='queue-after-switch');
  const result={outcomes,newIdentity:auth.getState().username,queuedOldWriteCreatedAccount:created,reproduced:created};
  console.log(JSON.stringify(result,null,2));
  await fs.writeFile(new URL('./queued-write-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
} finally {
  lib?.db.close();
  if(cloud) {await cloud.close();await fs.rm(cloud.dir,{recursive:true,force:true});}
  await fs.rm(base,{recursive:true,force:true});
}
