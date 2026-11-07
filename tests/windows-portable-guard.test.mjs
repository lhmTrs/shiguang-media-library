import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url));
// Real CLI source is evaluated in a private VM. process.platform and all IO are
// explicitly mocked; no original CLI is executed against a real running App.
const harness=`
import fs from 'node:fs/promises';import vm from 'node:vm';import path from 'node:path';import{fileURLToPath}from'node:url';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8')),source=await fs.readFile(process.argv[3],'utf8');
const operations={fs:0,config:0,fetch:0,spawn:[],signal:[],listeners:[],imports:[],logs:[],errors:[]};
const fakeProcess={platform:config.platform,argv:['node',process.argv[3],...config.args],env:{MEDIA_DATA_DIR:'/synthetic/never-read-real-config',MEDIA_PLATFORM:'darwin',SHIGUANG_PLATFORM:'darwin',...config.env},execPath:'/synthetic/node',exitCode:0,kill:(...args)=>{operations.signal.push(args);throw Error('UNEXPECTED_SIGNAL');},on:(name)=>operations.listeners.push(name),exit:code=>{throw Error('UNEXPECTED_EXIT:'+code);}};
const fakeFS={readFile:async()=>{operations.fs++;operations.config++;return JSON.stringify({pid:999999,url:'http://127.0.0.1:45123',instanceId:'synthetic-library'});}};
const fakeSpawn=(file,args,options)=>{operations.spawn.push({file,args,options});const child={on(name,fn){if(name==='exit')queueMicrotask(()=>fn(0));return child;},kill(signal){operations.signal.push(['child',signal]);}};return child;};
const context=vm.createContext({process:fakeProcess,console:{log:value=>operations.logs.push(String(value)),error:value=>operations.errors.push(String(value))},URL,AbortSignal,fetch:async()=>{operations.fetch++;return{ok:true,headers:{get:()=>null},json:async()=>({app:'wrong-app',instanceId:'synthetic-library'})};},setTimeout:(fn)=>{queueMicrotask(fn);return 1;},clearTimeout:()=>{}});
const cache=new Map();async function link(specifier){operations.imports.push(specifier);if(cache.has(specifier))return cache.get(specifier);let exports;if(specifier==='node:path')exports={default:path};else if(specifier==='node:url')exports={fileURLToPath};else if(specifier==='node:child_process')exports={spawn:fakeSpawn};else if(specifier==='node:fs/promises')exports={default:fakeFS};else if(specifier==='../server/runtime.mjs')exports={dataDirectory:()=>{operations.config++;return'/synthetic/data';}};else throw Error('UNEXPECTED_IMPORT:'+specifier);const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});cache.set(specifier,m);await m.link(()=>{});await m.evaluate();return m;}
const module=new vm.SourceTextModule(source,{context,identifier:'file:///synthetic/scripts/'+config.script,initializeImportMeta:(meta,module)=>{meta.url=module.identifier;},importModuleDynamically:specifier=>link(specifier)});await module.link(specifier=>link(specifier));await module.evaluate();await new Promise(r=>setImmediate(r));console.log(JSON.stringify({mock:true,actualHost:process.platform,simulatedPlatform:config.platform,exitCode:fakeProcess.exitCode,operations}));
`;
async function run(t,script,platform,args=[]){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-windows-cli-guard-')));await fs.mkdir(path.join(root,'home'),{mode:0o700});await fs.mkdir(path.join(root,'tmp'),{mode:0o700});const runner=path.join(root,'runner.mjs'),config=path.join(root,'config.json');await fs.writeFile(runner,harness);await fs.writeFile(config,JSON.stringify({script,platform,args}));
 const child=spawn(process.execPath,['--experimental-vm-modules',runner,config,path.join(repo,'scripts',script)],{cwd:root,env:{PATH:process.env.PATH,HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp')},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const pid=child.pid;const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});await fs.writeFile(path.join(root,'stdout.log'),stdout);await fs.writeFile(path.join(root,'stderr.log'),stderr);await fs.writeFile(path.join(root,'exit.json'),JSON.stringify({pid,...exit,groupKnown:true,retained:true}));t.diagnostic(JSON.stringify({root,pid,actualExitCode:exit.code,actualSignal:exit.signal,mock:true,actualHost:process.platform,simulatedPlatform:platform,retention:'RETAIN_ALL'}));assert.equal(exit.code,0,stderr);return JSON.parse(stdout.trim());
}
function noIO(value){const o=value.operations;assert.equal(o.fs,0);assert.equal(o.config,0);assert.equal(o.fetch,0);assert.deepEqual(o.spawn,[]);assert.deepEqual(o.signal,[]);assert.deepEqual(o.listeners,[]);}

test('W04 Windows stop refuses before runtime import/FS/config/fetch/PID/signal, no env or argv bypass',async t=>{
 const value=await run(t,'stop-portable.mjs','win32',['--platform=darwin']);assert.equal(value.mock,true);assert.equal(value.exitCode,1);noIO(value);assert.deepEqual(value.operations.imports,[]);assert.match(value.operations.errors.join('\n'),/WINDOWS_SAFE_SHUTDOWN_UNSUPPORTED/);assert.equal(value.operations.logs.length,0);
});
test('W04 Windows foreground refuses before dependency imports/spawn/signal registration',async t=>{
 const value=await run(t,'portable.mjs','win32',['--foreground','--open','--platform=darwin']);assert.equal(value.exitCode,1);noIO(value);assert.deepEqual(value.operations.imports,[]);assert.match(value.operations.errors.join('\n'),/WINDOWS_SAFE_SHUTDOWN_UNSUPPORTED/);
});
test('W04 Windows ordinary background launch remains the original spawn branch (mock)',async t=>{
 const value=await run(t,'portable.mjs','win32',['--open']);const o=value.operations;assert.equal(value.exitCode,0);assert.equal(o.spawn.length,1);assert.equal(o.spawn[0].file,'/synthetic/node');assert.deepEqual(o.spawn[0].args,['/synthetic/scripts/launch.mjs','--open']);assert.equal(o.spawn[0].options.env.MEDIA_PORTABLE,'1');assert.equal(o.spawn[0].options.env.MEDIA_SKIP_IMPORT,'1');assert.equal(o.spawn[0].options.stdio,'inherit');assert.deepEqual(o.signal,[]);assert.deepEqual(o.listeners,[]);assert.equal(o.fs+o.config+o.fetch,0);assert.deepEqual(o.errors,[]);
});
test('W04 non-Windows foreground retains original server spawn and signal handlers without emitting signals',async t=>{
 const value=await run(t,'portable.mjs','darwin',['--foreground']);const o=value.operations;assert.equal(value.exitCode,0);assert.equal(o.spawn.length,1);assert.deepEqual(o.spawn[0].args,['/synthetic/server/index.mjs']);assert.deepEqual(o.listeners,['SIGINT','SIGTERM']);assert.deepEqual(o.signal,[]);assert.deepEqual(o.errors,[]);
});
test('W04 non-Windows stop keeps record/session identity refusal path, never signals mismatched peer',async t=>{
 const value=await run(t,'stop-portable.mjs','linux');const o=value.operations;assert.equal(value.exitCode,1);assert.equal(o.fs,1);assert.equal(o.config,2);assert.equal(o.fetch,1);assert.deepEqual(o.spawn,[]);assert.deepEqual(o.signal,[]);assert.ok(o.imports.includes('../server/runtime.mjs'));assert.match(o.errors.join('\n'),/服务身份不匹配/);
});
