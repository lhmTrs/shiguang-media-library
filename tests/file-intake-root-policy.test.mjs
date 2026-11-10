import test from 'node:test';import assert from'node:assert/strict';import express from'express';import{managedRootPolicy,protectManagedRoots}from'../server/file-intake/root-policy.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
test('only configured internal roots hide; normal same-name folders elsewhere remain visible',()=>{const policy=managedRootPolicy('/synthetic/personal_item');assert.deepEqual(policy({path:'/synthetic/personal_item/picture'}),{managed:true,hidden:true});assert.deepEqual(policy({path:'/synthetic/personal_item/system_sfx'}),{managed:true,hidden:false});assert.deepEqual(policy({path:'/other/picture'}),{managed:false,hidden:false});assert.deepEqual(policy({path:'/synthetic/personal_item/picture/nested'}),{managed:false,hidden:false});});
test('HTTP destructive root management refuses internal roots but leaves read/scan and user folders intact',async t=>{const app=express(),roots=[{id:'internal',path:'/synthetic/personal_item/video'},{id:'user',path:'/elsewhere/video'}],visible=protectManagedRoots(app,{allRoots:()=>roots},'/synthetic/personal_item');assert.deepEqual(visible(roots),[roots[1]]);app.use((_req,res)=>res.json({ok:true}));const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;for(const [method,suffix]of [['DELETE',''],['PATCH',''],['POST','/retire'],['POST','/relocate'],['POST','/removal-preview']]){const r=await fetch(base+'/api/roots/internal'+suffix,{method});assert.equal(r.status,403);assert.equal((await r.json()).code,'MANAGED_ROOT_PROTECTED');}for(const [method,url]of [['POST','internal/scan'],['GET','internal'],['DELETE','user']]){const r=await fetch(base+'/api/roots/'+url,{method});assert.equal(r.status,200);await r.json();}});

test('all Express case/trailing-slash aliases of destructive handlers preserve managed roots; user roots still work',async t=>{
  const app=express(),roots=[{id:'internal',path:'/synthetic/personal_item/system_sfx'},{id:'user',path:'/elsewhere/system_sfx'}],called=[];
  protectManagedRoots(app,{allRoots:()=>roots},'/synthetic/personal_item');
  const routes=[['post','/retire'],['post','/relocate'],['post','/removal-preview'],['patch',''],['delete','']];
  for(const [method,suffix] of routes) app[method]('/api/roots/:id'+suffix,(req,res)=>{called.push(req.params.id+':'+suffix);res.json({ok:true});});
  app.post('/api/roots/:id/scan',(_req,res)=>res.json({ok:true}));
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  assert.notEqual(server.address().port,4317);
  const base='http://127.0.0.1:'+server.address().port;
  for(const [method,suffix] of routes) for(const alias of new Set([suffix,suffix+'/',suffix.toUpperCase(),suffix.toUpperCase()+'/'])) {
    const blocked=await fetch(base+'/API/ROOTS/internal'+alias,{method:method.toUpperCase()});
    assert.equal(blocked.status,403,method+' '+alias);assert.equal((await blocked.json()).code,'MANAGED_ROOT_PROTECTED');
    assert.ok(called.every(id=>id.startsWith('user:')));
    const allowed=await fetch(base+'/API/ROOTS/user'+alias,{method:method.toUpperCase()});assert.equal(allowed.status,200);await allowed.json();
  }
  const scan=await fetch(base+'/API/ROOTS/internal/SCAN/',{method:'POST'});assert.equal(scan.status,200);await scan.json();
});

test('canonical parent aliases hide/protect the accepted managed base without claiming same-name external roots or following base links',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-root-policy-test-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const real=path.join(dir,'real'),other=path.join(dir,'other'),alias=path.join(dir,'alias');
  await fs.mkdir(real);await fs.mkdir(other);await fs.symlink(real,alias);
  const configured=path.join(alias,'personal_item'),canonical=path.join(real,'personal_item');
  const policy=managedRootPolicy(configured),pinnedPolicy=managedRootPolicy(canonical);
  for(const name of ['picture','video','system_picture','system_video','system_music','system_sfx']) {
    const root={path:path.join(canonical,name)};
    assert.deepEqual(policy(root),{managed:true,hidden:!['system_music','system_sfx'].includes(name)});
    assert.deepEqual(pinnedPolicy(root),policy(root));
    assert.deepEqual(policy({path:path.join(other,'personal_item',name)}),{managed:false,hidden:false});
  }
  // App wiring passes the catalog's canonical path, keeping the original base
  // pinned even if the configured parent alias is retargeted later.
  await fs.unlink(alias);await fs.symlink(other,alias);
  assert.deepEqual(pinnedPolicy({path:path.join(canonical,'picture')}),{managed:true,hidden:true});
  assert.deepEqual(pinnedPolicy({path:path.join(other,'personal_item','picture')}),{managed:false,hidden:false});
  await fs.symlink(other,canonical);
  assert.deepEqual(managedRootPolicy(canonical)({path:path.join(other,'picture')}),{managed:false,hidden:false});
});
