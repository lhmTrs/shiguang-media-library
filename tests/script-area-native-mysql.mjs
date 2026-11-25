// Explicit opt-in native daemon. This file never reads system MySQL configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startOwnedNativeMysql,activateAndRestart} from './helpers/mysql-activate.mjs';
import {assertOwnedMysqlTarget} from './helpers/mysql-target-guard.mjs';
import {Library} from '../server/library.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {ProjectScripts} from '../server/project-scripts/store.mjs';
import {AREA_TABLES} from '../server/project-scripts/area-schema.mjs';
import {areaBackup} from '../server/project-scripts/backup.mjs';
const binary=process.env.SCRIPT_AREA_MYSQLD;assert.ok(binary&&path.isAbsolute(binary),'Set SCRIPT_AREA_MYSQLD to an explicitly selected native daemon');
const owned=await startOwnedNativeMysql(binary);let lib,storage,fresh;
const checks=[];const check=(name,fn)=>{fn();checks.push(name);console.log('PASS '+name);};
try{
 const database=await owned.schema('script_area'),config=owned.config(database);assertOwnedMysqlTarget(config,owned.config(database));
 const data=path.join(owned.directory,'app');await fs.mkdir(data,{mode:0o700});storage=await new MysqlStorage(data).init();lib=await new Library(data).init();storage.attach(lib);
 let projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),scripts=new ProjectScripts(assets).init(),area=scripts.area;
 const p=projects.save(null,{name:'合成原生数据库'}).id;scripts.put(p,{title:'剧本',content:'第一行合成正文\n第二行合成正文',expected_revision:0});let d=area.draft(p),input={expected_revision:d.revision,contentDigest:d.contentDigest,requestId:randomUUID()};const v=area.freeze(p,input,'version').version,snapshot=area.freeze(p,{...input,requestId:randomUUID()},'snapshot').snapshot;
 const m=area.upload(p,{requestId:randomUUID(),originalFilename:'合成.txt'},Buffer.from('合成资料正文')).material;
 const graph={schemaVersion:1,kind:'single',title:'合成图',sources:[{key:'A',sourceId:v.id}],lanes:[{id:'a',name:'甲',hero:true}],nodes:[{id:'n',lane:'a',row:1,kind:'self',label:['合成'],refs:[{source:'A',start:1,quote:'合成正文'}]}],edges:[]},mapInput={graph,binding:{target:{kind:'version',id:v.id}},requestId:randomUUID()},map=area.createMap(p,mapInput);
 const before=areaBackup(area);
 const next=await activateAndRestart({storage,lib,config,rebuild:l=>{const projects=new Projects(l).init(),assets=new ProjectAssets(l).init(),scripts=new ProjectScripts(assets).init();return {projects,assets,scripts,area:scripts.area};}});lib=next.lib;storage=next.storage;({projects,assets,scripts,area}=next.owners);
 check('SQLite to MySQL actual restart preserves sources, material file manifest, map, receipt and numbering',()=>assert.deepEqual(areaBackup(area),before));
 check('native MySQL project version unique key',()=>{const r=area.db.prepare('SELECT * FROM script_sources WHERE id=?').get(v.id);assert.throws(()=>area.db.prepare('INSERT INTO script_sources(id,project_id,kind,version_no,payload) VALUES(?,?,?,?,?)').run(randomUUID(),r.project_id,r.kind,r.version_no,r.payload),e=>e.code==='ER_DUP_ENTRY');});
 check('native MySQL replay survives later draft edit; snapshot/source immutable',()=>{scripts.put(p,{title:'新版',content:'后来的正文',expected_revision:1});assert.equal(area.freeze(p,input,'version').version.id,v.id);assert.equal(area.sourceObject(p,snapshot.id).content,'第一行合成正文\n第二行合成正文');assert.throws(()=>area.freeze(p,{...input,requestId:randomUUID()},'version'),e=>e.status===409);assert.equal(area.createMap(p,mapInput).map.id,map.map.id);});
 const connection=await owned.connection(database);
 try{await connection.query("CREATE TRIGGER refuse_script_map BEFORE INSERT ON script_maps FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='owned synthetic rollback'");const previous=areaBackup(area);assert.throws(()=>area.createMap(p,{...mapInput,requestId:randomUUID()}),/owned synthetic rollback/);assert.deepEqual(areaBackup(area),previous);await connection.query('DROP TRIGGER refuse_script_map');checks.push('actual MySQL rollback leaves no map or idempotency receipt');}finally{await connection.end();}
 const backup=assets.backup();const freshName=await owned.schema('script_restore');const freshConfig=owned.config(freshName);assertOwnedMysqlTarget(freshConfig,owned.config(freshName));fresh=new MysqlDatabase(freshConfig);const freshDir=path.join(owned.directory,'restored-app');await fs.mkdir(freshDir,{mode:0o700});const flib={db:fresh,dataDir:freshDir};new Projects(flib).init();const fa=new ProjectAssets(flib).init(),fscripts=new ProjectScripts(fa).init();await fa.restore(backup);assert.deepEqual(areaBackup(fscripts.area),backup.script_area);assert.deepEqual(fscripts.area.files.read(m.id,m.sha256),Buffer.from('合成资料正文'));checks.push('native MySQL fresh restore preserves metadata, original bytes and archived excerpts');
 area.materialChange(p,m.id,{requestId:randomUUID(),expected_revision:1},true);assert.throws(()=>area.source(p,m.id),e=>e.status===404);checks.push('native MySQL tombstone stops new reads');
 for(const table of Object.keys(AREA_TABLES))fresh.exec('DROP TABLE '+table);fscripts.init();const baseline=fscripts.area.versions(p).items;assert.equal(baseline.length,1);assert.equal(baseline[0].kind,'legacy');assert.equal(baseline[0].versionNo,null);const bid=baseline[0].id;fscripts.init();assert.equal(fscripts.area.versions(p).items[0].id,bid);checks.push('native MySQL existing old-draft schema upgrades once with unnumbered baseline and private backup');
 console.log(JSON.stringify({checks,version:owned.inventory.server.version,isolated:true,formalPort:false}));
}finally{for(const db of [fresh,lib?.db])if(db?.kind==='mysql'&&!db.closed)await db.closeNormally();else if(db?.open)db.close();await owned.finish();}
