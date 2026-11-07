import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
// Real setup/npm child-process flow and disk writes, with dependency probes and
// project build/doctor/start commands replaced by disposable test fixtures.
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sg-setup-current-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'scripts'));await fs.mkdir(path.join(root,'dist'));
 await fs.copyFile(new URL('../scripts/setup.mjs',import.meta.url),path.join(root,'scripts/setup.mjs'));
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',scripts:{build:'node scripts/build.mjs'}}));
 for(const name of ['express','mysql2','typescript','vite','better-sqlite3']){const dir=path.join(root,'node_modules',name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({type:'module',exports:name==='mysql2'?{'./promise':'./index.js'}:'./index.js'}));await fs.writeFile(path.join(dir,'index.js'),name==='better-sqlite3'?'export default class Database {close(){}}':'export default {}');}
 await fs.writeFile(path.join(root,'scripts/build.mjs'),`import fs from 'node:fs/promises';await fs.appendFile('flow.log','build\\n');const source=await fs.readFile('source.txt','utf8');if(source==='FAIL')process.exit(17);await fs.writeFile('dist/index.html',source);`);
 for(const [name,label] of [['doctor','doctor'],['portable','start']])await fs.writeFile(path.join(root,`scripts/${name}.mjs`),`import fs from 'node:fs/promises';await fs.appendFile('flow.log','${label}\\n');`);
 await fs.writeFile(path.join(root,'dist/index.html'),'OLD PAGE');await fs.writeFile(path.join(root,'source.txt'),'CURRENT SOURCE');
 return {root,run:()=>exec(process.execPath,['scripts/setup.mjs','--start'],{cwd:root,timeout:20000,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH}})};
}
test('W01 existing dist is replaced by current source before doctor/start (fixture build)',async t=>{const f=await fixture(t);await f.run();assert.equal(await fs.readFile(path.join(f.root,'dist/index.html'),'utf8'),'CURRENT SOURCE');assert.equal(await fs.readFile(path.join(f.root,'flow.log'),'utf8'),'build\ndoctor\nstart\n');});
test('W01 failed build with old dist stops before doctor/start and exits nonzero',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.root,'source.txt'),'FAIL');await assert.rejects(f.run(),e=>e.code===1);assert.equal(await fs.readFile(path.join(f.root,'flow.log'),'utf8'),'build\n');assert.equal(await fs.readFile(path.join(f.root,'dist/index.html'),'utf8'),'OLD PAGE');});
test('W01 missing dist is built and follows the same successful sequence',async t=>{const f=await fixture(t);await fs.rm(path.join(f.root,'dist'),{recursive:true});await fs.mkdir(path.join(f.root,'dist'));await f.run();assert.equal(await fs.readFile(path.join(f.root,'dist/index.html'),'utf8'),'CURRENT SOURCE');assert.equal(await fs.readFile(path.join(f.root,'flow.log'),'utf8'),'build\ndoctor\nstart\n');});
