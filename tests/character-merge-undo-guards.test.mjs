import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creativeFixture,moveWithAttributePlan} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {canonical,digest} from '../server/project-assets/model.mjs';

async function fixture(t) {
  const f=await creativeFixture();
  t.after(f.close);
  const directory=f.projects.series,service=f.store.characterMerges;
  const drama=directory.createSeries({request_id:randomUUID(),name:'撤销范围合成剧'});
  const other=directory.createSeries({request_id:randomUUID(),name:'另一部合成剧'});
  const episode=(series,n)=>directory.createEpisode(series.id,{
    request_id:randomUUID(),season_id:null,expected_episode_no:n,
  }).project;
  const first=episode(drama,1),second=episode(drama,2),outside=episode(other,1);
  const a=await f.store.create({project_id:first.id,kind:'character',name:'陈川'});
  const b=await f.store.create({project_id:second.id,kind:'character',name:a.name});
  const context=()=>service.groups(drama.id).context_token;
  const groups=service.groups(drama.id);
  const preview=service.preview(drama.id,{
    context_token:context(),group_id:groups.items[0].group_id,primary_asset_id:a.id,
  });
  const merge=service.confirm(drama.id,{
    request_id:randomUUID(),context_token:context(),preview_token:preview.preview_token,choices:preview.choices,
  });
  const undoPreview=()=>service.undoPreview(drama.id,merge.merge_id,{context_token:context()});
  const undo=(view,accept=false)=>service.undo(drama.id,merge.merge_id,{
    request_id:randomUUID(),context_token:context(),undo_token:view.undo_token??'0'.repeat(64),accept_restore_changes:accept,
  });
  const rename=async(asset,name)=>f.store.scopedWrites.save('series',drama.id,asset.id,{
    request_id:randomUUID(),context_token:context(),expected_revision:asset.revision,asset:{...asset,name},
  });
  return {...f,directory,service,drama,other,first,second,outside,a,b,context,merge,undoPreview,undo,rename};
}

function rechecksum(backup) {
  const {format,schema_version,checksum,...content}=backup;
  backup.checksum=digest(content);
}

async function target(t) {
  const f=await creativeFixture();
  t.after(f.close);
  f.projects.save(f.a.id,{name:'恢复目标夹具甲'});
  f.projects.save(f.b.id,{name:'恢复目标夹具乙'});
  return f;
}

function businessState(store) {
  const {creative_character_merge_requests,...tables}=store.snapshot();
  return tables;
}

test('forged cross-series undo preimage is rejected before restore and blocked in the undo transaction',async t=>{
  const f=await fixture(t),clean=f.undoPreview(),backup=f.store.backup();
  const row=backup.tables.creative_character_merges.find(row=>row.id===f.merge.merge_id);
  const data=JSON.parse(row.data_json),before=data.before.creative_assets.find(row=>row.id===f.a.id);
  before.project_id=before.owner_id=f.outside.id;
  data.membership.push([f.outside.id,null]);
  row.data_json=canonical(data);
  rechecksum(backup);
  const destination=await target(t),unchanged=destination.store.backup().checksum;
  await assert.rejects(destination.store.restore(backup),/备份中包含无效/);
  assert.equal(destination.store.backup().checksum,unchanged,'invalid backup writes no destination rows');
  assert.equal(f.directory.membership(f.outside.id).series_id,f.other.id);

  // A persisted inconsistent historical record must also fail the final write
  // guard, even if it bypassed backup validation in an older installation.
  f.db.prepare('UPDATE creative_character_merges SET data_json=? WHERE id=?').run(row.data_json,row.id);
  const state=businessState(f.store),preview=f.undoPreview();
  assert.equal(preview.status,'blocked');
  assert(preview.blockers.some(row=>row.code==='CHARACTER_MERGE_SCOPE_CHANGED'));
  for(const accept of [false,true]) {
    assert.throws(()=>f.undo(clean,accept),{
      status:409,code:'CHARACTER_MERGE_UNDO_BLOCKED',
    });
    assert.deepEqual(businessState(f.store),state);
  }
  assert.equal(f.store.get(f.a.id).owner_id,f.drama.id);
  assert.equal(f.service.resolveAsset(f.second.id,f.b.id),f.a.id);
});

test('undo rejects a new shared namesake in preview and after an otherwise clean preview',async t=>{
  const f=await fixture(t);
  await f.rename(f.store.get(f.a.id),'新主体名');
  const clean=f.undoPreview();
  assert.equal(clean.status,'clean');
  const shared=f.store.scopedWrites.create('series',f.drama.id,{
    request_id:randomUUID(),context_token:f.context(),kind:'character',name:f.b.name,on_shared:'reject',
  }).asset;
  const state=businessState(f.store),blocked=f.undoPreview();
  assert.equal(blocked.status,'blocked');
  assert(blocked.blockers.some(row=>row.code==='CHARACTER_MERGE_NAME_CONFLICT'));
  for(const accept of [false,true]) {
    assert.throws(()=>f.undo(clean,accept),{status:409,code:'CHARACTER_MERGE_UNDO_BLOCKED'});
    assert.deepEqual(businessState(f.store),state,'name conflict cannot partially restore identities or versions');
  }
  assert.equal(f.service.resolveAsset(f.second.id,f.b.id),f.a.id);
  assert.equal(f.store.get(f.b.id).archived_at>0,true);
  assert.equal(f.store.get(shared.id).name,f.b.name);

  // Once the new collision is resolved, a fresh request can restore the old
  // local identity while preserving the legal edit to the original primary.
  await f.rename(shared,'新共享人物');
  const ready=f.undoPreview();
  assert.equal(ready.status,'clean');
  assert.equal(f.undo(ready).status,'undone');
  assert.equal(f.store.get(f.a.id).name,'新主体名');
  assert.equal(f.store.get(f.b.id).project_id,f.second.id);
  const board=new StoryboardDatabase(f.lib,f.store).init();
  assert.equal(board.initialize(f.second.id,{
    source:syntheticSource(),request_id:randomUUID(),expected_revision:null,
  }).project.asset_manifest.character.find(row=>row.name===f.b.name).id,f.b.id);
  const destination=await target(t);
  assert.equal((await destination.store.restore(f.store.backup())).restored,true);
});

test('legitimate read-only history remains restorable after the old primary episode is moved and removed',async t=>{
  const f=await fixture(t),oldVersion=f.a.revision;
  const detail=f.store.scoped.detail('episode',f.first.id,f.a.id);
  f.store.scopedWrites.setOverride('episode',f.first.id,f.a.id,{
    request_id:randomUUID(),context_token:detail.context_token,field:{key:'default_look'},action:'inherit',
    write_token:detail.effective.default_look.write_token,
  });
  moveWithAttributePlan(f.directory,{
    request_id:randomUUID(),target:{series_id:f.other.id,season_id:null},
    items:[{project_id:f.first.id,episode_no:2,expected_revision:f.directory.membership(f.first.id).revision}],
  });
  assert.equal(f.undoPreview().status,'blocked');
  const moved=await target(t);
  assert.equal((await moved.store.restore(f.store.backup())).restored,true);
  assert.equal(moved.store.version(f.a.id,oldVersion).project_id,f.first.id);
  f.projects.remove(f.first.id);
  const removed=await target(t);
  assert.equal((await removed.store.restore(f.store.backup())).restored,true);
  assert.equal(removed.store.version(f.a.id,oldVersion).project_id,f.first.id);
  const service=removed.store.characterMerges;
  const preview=service.undoPreview(f.drama.id,f.merge.merge_id,{
    context_token:service.groups(f.drama.id).context_token,
  });
  assert.equal(preview.status,'blocked');
});

test('ordinary undo restores both original identities and their backup without a scope or name blocker',async t=>{
  const f=await fixture(t),view=f.undoPreview();
  assert.equal(view.status,'clean');
  assert.equal(f.undo(view).status,'undone');
  assert.equal(f.store.get(f.a.id).project_id,f.first.id);
  assert.equal(f.store.get(f.b.id).project_id,f.second.id);
  const destination=await target(t);
  assert.equal((await destination.store.restore(f.store.backup())).restored,true);
});

test('backup cannot invent a member or redirect an original owner, even when an old asset version is edited too',async t=>{
  const f=await fixture(t),original=f.store.backup(),destination=await target(t);
  const unchanged=destination.store.backup().checksum;
  for(const variant of ['member_only','same_series_owner','version_and_foreign_owner']) {
    const backup=structuredClone(original);
    const merge=backup.tables.creative_character_merges.find(row=>row.id===f.merge.merge_id);
    const data=JSON.parse(merge.data_json),before=data.before.creative_assets.find(row=>row.id===f.a.id);
    if(variant==='member_only') data.membership.push([f.outside.id,null]);
    else if(variant==='same_series_owner') before.project_id=before.owner_id=f.second.id;
    else {
      before.project_id=before.owner_id=f.outside.id;
      data.membership.push([f.outside.id,null]);
      const version=backup.tables.creative_asset_versions.find(row=>row.asset_id===before.id&&row.version===before.revision);
      const snapshot=JSON.parse(version.snapshot);
      snapshot.project_id=snapshot.owner_id=f.outside.id;
      version.snapshot=canonical(snapshot);
    }
    merge.data_json=canonical(data);
    rechecksum(backup);
    await assert.rejects(destination.store.restore(backup),/备份中包含无效/,variant);
    assert.equal(destination.store.backup().checksum,unchanged);
  }
});

test('undo checks preserved final names rather than blocking a harmless reuse of the old primary name',async t=>{
  const f=await fixture(t);
  await f.rename(f.store.get(f.a.id),'保留的新姓名');
  const detail=f.store.scoped.scope('episode',f.first.id);
  const local=f.store.scopedWrites.create('episode',f.first.id,{
    request_id:randomUUID(),context_token:detail.context_token,kind:'character',name:f.a.name,on_shared:'reject',
  }).asset;
  const view=f.undoPreview();
  assert.equal(view.status,'clean');
  assert.equal(f.undo(view).status,'undone');
  assert.equal(f.store.get(f.a.id).name,'保留的新姓名');
  assert.equal(f.store.get(local.id).name,f.a.name);
  assert.equal(f.store.get(local.id).project_id,f.first.id);
  const destination=await target(t);
  assert.equal((await destination.store.restore(f.store.backup())).restored,true);
});
