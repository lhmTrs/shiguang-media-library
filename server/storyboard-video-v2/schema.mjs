export const SCHEMA_VERSION=1;
// Column identity is authoritative; JSON contains only snapshots/results.
export const V2_TABLES={
 storyboard_video_v2_provenance:{id:'id',project_id:'ref',document_id:'ref',initialized_at:'integer',storyboard_revision:'integer',instance_id:'key',shot_ids_json:'text',snapshot_json:'text',input_hash:'hash',status:'short',request_id:'ref',revision:'integer',created_at:'integer',updated_at:'integer'},
 storyboard_video_v2_bindings:{id:'id',video_id:'ref',source_project_id:'ref',target_project_id:'nullableRef',document_id:'nullableRef',initialized_at:'nullableInteger',storyboard_revision:'nullableInteger',origin:'short',provenance_id:'nullableRef',snapshot_json:'nullableText',review_json:'nullableText',review_revision:'nullableInteger',reviewed_at:'nullableInteger',bound_at:'nullableInteger',revision:'integer',created_at:'integer',updated_at:'integer'},
 storyboard_video_v2_shots:{id:'id',binding_id:'ref',video_id:'ref',source_project_id:'ref',target_project_id:'ref',document_id:'ref',initialized_at:'integer',shot_id:'key',ordinal:'integer',number_at_binding:'key',duration_ms:'integer',association_seq:'integer',created_at:'integer',updated_at:'integer'},
 storyboard_video_v2_selections:{id:'id',target_project_id:'ref',document_id:'ref',initialized_at:'integer',shot_id:'key',binding_id:'ref',video_id:'ref',source_project_id:'ref',kind:'short',selection_seq:'integer',selected_at:'integer',created_at:'integer',updated_at:'integer'},
 storyboard_video_v2_events:{id:'id',binding_id:'nullableRef',provenance_id:'nullableRef',project_id:'nullableRef',document_id:'nullableRef',initialized_at:'nullableInteger',storyboard_revision:'nullableInteger',event_type:'short',sequence:'integer',before_json:'nullableText',after_json:'nullableText',created_at:'integer',updated_at:'integer'},
 storyboard_video_v2_state:{id:'stateKey',revision:'integer',sequence:'integer',data_json:'text',created_at:'integer',updated_at:'integer'},
 storyboard_video_v2_requests:{id:'id',operation:'short',scope:'key',request_hash:'hash',status:'short',result_json:'text',created_at:'integer',updated_at:'integer'}
};
export const V2_CONSTRAINTS={
 storyboard_video_v2_provenance:['UNIQUE(request_id)','INDEX v2_provenance_pin(document_id,storyboard_revision,status)'],
 storyboard_video_v2_bindings:['UNIQUE(video_id)','INDEX v2_binding_target(target_project_id,document_id,initialized_at)','INDEX v2_binding_source(source_project_id)'],
 storyboard_video_v2_shots:['UNIQUE(binding_id,shot_id)','INDEX v2_shot_candidates(target_project_id,document_id,initialized_at,shot_id,association_seq)','INDEX v2_shot_video(video_id)'],
 storyboard_video_v2_selections:['UNIQUE(target_project_id,document_id,initialized_at,shot_id)','INDEX v2_selection_video(video_id)','INDEX v2_selection_source(source_project_id)'],
 storyboard_video_v2_events:['INDEX v2_event_pin(document_id,storyboard_revision)','INDEX v2_event_binding(binding_id,sequence)'],
 storyboard_video_v2_state:[],storyboard_video_v2_requests:['INDEX v2_request_scope(scope,operation)']
};
export const v2Constraints=table=>V2_CONSTRAINTS[table]??[];
export function v2ColumnType(table,col){const t=V2_TABLES[table]?.[col.name];if(!t)throw Error('未知视频绑定v2字段');return ({id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',nullableRef:'VARCHAR(36)',key:'VARCHAR(160)',stateKey:'VARCHAR(160) PRIMARY KEY',hash:'VARCHAR(64)',short:'VARCHAR(80)',text:'LONGTEXT',nullableText:'LONGTEXT',integer:'BIGINT',nullableInteger:'BIGINT'})[t];}
export function v2Schema(mysql=false){
 const result=[];
 for(const [table,columns]of Object.entries(V2_TABLES)){
  const fields=Object.entries(columns).map(([name,t])=>`\`${name}\` ${mysql?v2ColumnType(table,{name}):['integer','nullableInteger'].includes(t)?'INTEGER':['id','stateKey'].includes(t)?'TEXT PRIMARY KEY':'TEXT'}${t.startsWith('nullable')?'':' NOT NULL'}`);
  fields.push(...v2Constraints(table).filter(c=>mysql||!c.startsWith('INDEX')));
  result.push(`CREATE TABLE IF NOT EXISTS ${table} (${fields.join(',')})${mysql?' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin':''}`);
  if(!mysql)for(const c of v2Constraints(table).filter(c=>c.startsWith('INDEX'))){const match=/^INDEX (\w+)\((.+)\)$/.exec(c);result.push(`CREATE INDEX IF NOT EXISTS ${match[1]} ON ${table}(${match[2]})`);}
 }
 return result;
}
