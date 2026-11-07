import {fault,idOK,canonical} from '../project-assets/model.mjs';
import {scriptSchema} from './schema.mjs';
const LIMIT=200000;
function text(input){if(!input||typeof input.title!=='string'||input.title.length>200||typeof input.content!=='string'||input.content.length>LIMIT||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.title+input.content))throw fault('剧本格式无效：标题最多200字，正文最多200000字');return{title:input.title,content:input.content};}
export class ProjectScripts{
 constructor(assets){this.assets=assets;this.lib=assets.lib;}
 get db(){return this.assets.db;}
 init(){this.db.exec(scriptSchema(this.db.kind==='mysql'));this.assets.scripts=this;return this;}
 project(id,lock=false){const p=this.assets.project(id,lock);if(p.project_kind!=='normal')throw fault('公共人物库不保存项目剧本',400);return p;}
 dto(row,id){return row?{project_id:row.id,title:row.title,content:row.content,revision:row.revision,updated_at:row.updated_at}:{project_id:id,title:'',content:'',revision:0,updated_at:null};}
 get(id){this.project(id);return this.dto(this.db.prepare('SELECT * FROM project_scripts WHERE id=?').get(id),id);}
 put(id,input){
  const value=text(input);if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw fault('剧本修订号无效');
  if(this.lib.migrating)throw fault('数据库正在迁移，请稍后保存剧本',423);
  return this.assets.tx(()=>{this.project(id,true);const old=this.db.prepare('SELECT * FROM project_scripts WHERE id=?').get(id);if((old?.revision??0)!==input.expected_revision)throw fault('剧本已经更新，本地输入仍保留，请核对最新版本后保存',409,{current_revision:old?.revision??0});const now=Math.max(Date.now(),(old?.updated_at??0)+1),revision=(old?.revision??0)+1;
   if(old){const result=this.db.prepare('UPDATE project_scripts SET title=?,content=?,revision=?,updated_at=? WHERE id=? AND revision=?').run(value.title,value.content,revision,now,id,old.revision);if(result.changes!==1)throw fault('剧本已经更新，本地输入仍保留',409);}
   else this.db.prepare('INSERT INTO project_scripts(id,title,content,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,value.title,value.content,revision,now,now);
   return this.get(id);
  });
 }
 snapshot(){return this.db.prepare('SELECT * FROM project_scripts ORDER BY id').all();}
 validateRows(rows,projects){
  if(!Array.isArray(rows)||rows.length>10000)throw fault('剧本备份记录数量无效');const ids=new Set(),normal=new Set(projects.filter(p=>p.project_kind==='normal').map(p=>p.id));
  for(const row of rows){if(!row||canonical(Object.keys(row).sort())!==canonical(['id','title','content','revision','created_at','updated_at'].sort())||!idOK(row.id)||!normal.has(row.id)||ids.has(row.id)||![row.revision,row.created_at,row.updated_at].every(Number.isSafeInteger)||row.revision<1||row.created_at<0||row.updated_at<row.created_at)throw fault('剧本备份字段或项目归属无效');text(row);ids.add(row.id);}
  return rows;
 }
 // Caller owns the same project/backup transaction. Old backups do not erase new scripts.
 restoreRows(rows){for(const row of rows){this.project(row.id,true);const old=this.db.prepare('SELECT * FROM project_scripts WHERE id=?').get(row.id);if(old){if(canonical(old)!==canonical(row))throw fault('目标项目已有不同剧本，未覆盖',409);}else this.db.prepare('INSERT INTO project_scripts(id,title,content,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(row.id,row.title,row.content,row.revision,row.created_at,row.updated_at);}}
}
