import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import{randomUUID}from'node:crypto';import{IntakePreferences,preferenceTarget}from'../server/file-intake/preferences.mjs';
test('preferences persist by library and type, never source paths, unconfirmed mode or character identities',async t=>{const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-pref-'))),libraryId=randomUUID(),projectId=randomUUID();const p=await new IntakePreferences({dataDir,libraryId}).init();await p.remember([{kind:'video',scope:'project',projectId,folderId:'root',mode:'move',path:'/private/synthetic',characterId:randomUUID()},{kind:'photo',scope:'library',directory:''},{kind:'music',scope:'library',directory:'配乐/轻快'},{kind:'sfx',scope:'library',directory:''}]);const current=p.snapshot([{id:projectId}]);assert.equal(Object.keys(current.targets).length,4);assert.deepEqual(current.targets.video,{kind:'video',scope:'project',projectId,folderId:'root'});assert.equal(JSON.stringify(current).includes('/private'),false);assert.equal(JSON.stringify(current).includes('move'),false);const restored=await new IntakePreferences({dataDir,libraryId}).init();assert.deepEqual(restored.snapshot([{id:projectId}]),current);assert.equal(restored.snapshot([{id:projectId,archived:true}]).targets.video,undefined);assert.deepEqual((await new IntakePreferences({dataDir,libraryId:randomUUID()}).init()).snapshot([]).targets,{});await p.close();t.diagnostic('Synthetic preferences retained '+dataDir);});
test('bad categories and symlinked preference files cannot provide authority',async t=>{for(const directory of ['/etc','../outside','a/../../b','a/b/c','a\\b','\0pending'])assert.equal(preferenceTarget({kind:'sfx',scope:'library',directory}),null);const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-pref-link-'))),p=await new IntakePreferences({dataDir,libraryId:'owned'}).init(),outside=path.join(dataDir,'outside.json');await fs.writeFile(outside,'{"secret":"not a preference"}',{mode:0o600});await fs.symlink(outside,p.file);const read=await new IntakePreferences({dataDir,libraryId:'owned'}).init();assert.deepEqual(read.snapshot().targets,{});assert.ok(read.snapshot().warning);await read.remember([{kind:'music',scope:'library',directory:''}]);assert.equal(await fs.readFile(outside,'utf8'),'{"secret":"not a preference"}');assert.equal((await fs.lstat(p.file)).isSymbolicLink(),false);t.diagnostic('Synthetic fixture retained '+dataDir);});

test('v1 routing migrates; accepted library choices preserve project history and share a theme without replacing it on first load',async t=>{
  const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-pref-v2-')));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const libraryId=randomUUID(),a=randomUUID(),b=randomUUID(),folderA=randomUUID(),folderB=randomUUID(),projects=[{id:a},{id:b}];
  const open=()=>new IntakePreferences({dataDir,libraryId}).init();
  const first=await open();
  await fs.writeFile(first.file,JSON.stringify({version:1,libraryId,targets:{
    video:{kind:'video',scope:'project',projectId:a,folderId:folderA},music:{kind:'music',scope:'library',directory:'配乐'},
  }}),{mode:0o600});
  const prefs=await open();
  assert.deepEqual(prefs.snapshot(projects).routingPreferences.lastVideoFolderByProject,{[a]:folderA});
  await Promise.all([
    prefs.remember([{kind:'video',scope:'project',projectId:b,folderId:folderB},{kind:'photo',scope:'project',projectId:b},{kind:'sfx',scope:'library',directory:'脚步'}],{mode:'move',standardNames:true}),
    prefs.setTheme({themeId:'midnight',onlyIfUnset:true}),
  ]);
  await prefs.remember([{kind:'video',scope:'library',directory:'外景'},{kind:'photo',scope:'library',directory:'照片'}]);
  assert.deepEqual(await prefs.setTheme({themeId:'forest',onlyIfUnset:true}),{themeId:'midnight'});
  assert.throws(()=>prefs.setTheme({themeId:'unknown'}),{code:'INTAKE_INVALID_INPUT'});
  const restored=await open();
  assert.equal(restored.themeId,'midnight');
  assert.deepEqual(restored.snapshot(projects,(_p,id)=>id===folderB).routingPreferences,{
    lastProjectId:{photo:b,video:b},lastVideoFolderByProject:{[a]:'root',[b]:folderB},
    lastLibraryDirectory:{photo:'照片',video:'外景',music:'配乐',sfx:'脚步'},lastAudioKind:'sfx',mode:'move',standardNames:true,standardNamesChosen:true,revealWhenDone:false,
  });
  assert.equal(restored.snapshot([{id:b,archived:true}]).routingPreferences.lastProjectId.video,null);
});

test('standard naming defaults on until an explicit confirmed boolean choice survives restart',async t=>{
  const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-naming-choice-')));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const libraryId=randomUUID(),projectId=randomUUID(),folderId=randomUUID(),projects=[{id:projectId}];
  const open=()=>new IntakePreferences({dataDir,libraryId}).init();
  const first=await open();
  assert.equal(first.routing.standardNames,true);
  assert.equal(first.routing.standardNamesChosen,false);
  const legacy={
    version:2,libraryId,themeId:'midnight',
    targets:{video:{kind:'video',scope:'project',projectId,folderId}},
    routingPreferences:{
      lastProjectId:{photo:projectId,video:projectId},lastVideoFolderByProject:{[projectId]:folderId},
      lastLibraryDirectory:{photo:'照片',video:'外景',music:'配乐',sfx:'脚步'},
      lastAudioKind:'sfx',mode:'move',standardNames:false,revealWhenDone:true,
    },
  };
  await fs.writeFile(first.file,JSON.stringify(legacy),{mode:0o600});
  const migrated=await open(),expected={...legacy.routingPreferences,standardNames:true,standardNamesChosen:false};
  assert.deepEqual(migrated.snapshot(projects).routingPreferences,expected);
  assert.equal(migrated.themeId,'midnight');
  await migrated.setTheme({themeId:'dark'});
  const unrelated=await open();
  assert.deepEqual(unrelated.snapshot(projects).routingPreferences,expected);
  await unrelated.remember([legacy.targets.video]);
  assert.deepEqual((await open()).snapshot(projects).routingPreferences,expected);
  await unrelated.remember([legacy.targets.video],{standardNames:false});
  const chosen=await open();
  assert.deepEqual(chosen.snapshot(projects).routingPreferences,{...expected,standardNames:false,standardNamesChosen:true});
  await chosen.setTheme({themeId:'forest'});
  await chosen.remember([{kind:'music',scope:'library',directory:'配乐'}]);
  const restarted=await open();
  assert.equal(restarted.routing.standardNames,false);
  assert.equal(restarted.routing.standardNamesChosen,true);
  await restarted.remember([legacy.targets.video],{standardNames:true});
  assert.equal((await open()).routing.standardNames,true);
  assert.equal((await open()).routing.standardNamesChosen,true);
});
