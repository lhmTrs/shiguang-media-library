import {hash,canonical,fail} from './model.mjs';
export const videoV2Protection={
 adoptionProjection(sourceProjectId){
  this.require();this.board.project(sourceProjectId);
  const selections=this.db.prepare('SELECT s.*,d.revision storyboard_revision,d.initialized_at current_initialized_at,d.document_json,p.name project_name FROM storyboard_video_v2_selections s JOIN storyboard_documents d ON d.project_id=s.target_project_id AND d.id=s.document_id AND d.initialized_at=s.initialized_at JOIN media_projects p ON p.id=s.target_project_id WHERE s.source_project_id=? ORDER BY s.target_project_id,s.shot_id').all(sourceProjectId),shots=new Map();
  const authority=[];
  for(const s of selections){const document=JSON.parse(s.document_json);let n=0,number=null;for(const scene of document.scenes)for(const shot of scene.shots){n++;if(shot.id===s.shot_id)number=String(n).padStart(2,'0');}if(!number)continue;
   const list=shots.get(s.video_id)??[];list.push({id:s.shot_id,number,projectId:s.target_project_id,projectName:s.project_name});shots.set(s.video_id,list);
   authority.push({projectId:s.target_project_id,documentId:s.document_id,initializedAt:s.initialized_at,storyboardRevision:s.storyboard_revision,selectionRevision:this.selectionRevision(s.target_project_id),shotId:s.shot_id,videoId:s.video_id,bindingId:s.binding_id,selectionSeq:s.selection_seq,kind:s.kind});
  }
  return {stamp:hash({sourceProjectId,authority}),shots,current:null};
 },
 detachVideoSources(sourceProjectId,videoIds){
  if(!videoIds.length)return;this.lock([sourceProjectId]);const projects=new Set();
  for(const videoId of new Set(videoIds)){
   const row=this.bindingRow(videoId);if(!row?.target_project_id)continue;if(row.source_project_id!==sourceProjectId)fail('VIDEO_BINDING_CONFLICT','解绑来源项目不匹配',409);
   const before=this.bindingDTO(row),selected=this.db.prepare('SELECT * FROM storyboard_video_v2_selections WHERE binding_id=?').all(row.id);
   for(const s of selected)projects.add(s.target_project_id);
   this.db.prepare('DELETE FROM storyboard_video_v2_selections WHERE binding_id=?').run(row.id);this.db.prepare('DELETE FROM storyboard_video_v2_shots WHERE binding_id=?').run(row.id);
   this.db.prepare('UPDATE storyboard_video_v2_bindings SET target_project_id=NULL,document_id=NULL,initialized_at=NULL,storyboard_revision=NULL,snapshot_json=NULL,review_json=NULL,review_revision=NULL,reviewed_at=NULL,bound_at=NULL,revision=?,updated_at=? WHERE id=?').run(row.revision+1,Date.now(),row.id);
   this.event('source-detach',{binding:row,before,after:null});
  }
  for(const projectId of projects)this.bumpSelection(projectId);
 },
 assertProjectRemovable(projectId){
  this.require();
  const provenance=this.db.prepare('SELECT id FROM storyboard_video_v2_provenance WHERE project_id=? LIMIT 1').get(projectId),binding=this.db.prepare('SELECT id FROM storyboard_video_v2_bindings WHERE source_project_id=? OR target_project_id=? LIMIT 1').get(projectId,projectId),event=this.db.prepare('SELECT id FROM storyboard_video_v2_events WHERE project_id=? LIMIT 1').get(projectId);
  if(provenance||binding||event)fail('VIDEO_BINDING_CONFLICT','项目仍被视频出处或历史绑定引用，不能永久删除',409);
 }
};
