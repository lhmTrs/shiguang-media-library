import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,digest,idOK} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';
import {folderIdentity,folderName,nameKey,sameFolder} from './folders.mjs';

const equal=(a,b)=>canonical(a)===canonical(b);
const exists=file=>fs.lstat(file).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));

// The operation table is the durable IO journal. A running receipt from another
// instance is UNKNOWN and can only be queried; it must never issue another mkdir.
export class ProjectVideoRejectArea {
  constructor(catalog){this.catalog=catalog;this.active=new Map();}
  get db(){return this.catalog.db;}
  get folders(){return this.catalog.folders;}
  tracked(fn){return this.catalog.withActivity(()=>this.catalog.media.track(()=>this.catalog.serial(fn)));}
  row(id,requestId){
    this.catalog.project(id);if(!idOK(requestId))fail('INVALID_REQUEST_ID','收纳设置请求编号无效');
    const row=this.db.prepare('SELECT * FROM project_video_operations WHERE id=? AND project_id=?').get(requestId,id);
    if(!row)fail('OPERATION_NOT_FOUND','未找到原收纳设置操作',404);
    const s=JSON.parse(row.data_json);if(s.kind!=='set-reject-area')fail('REQUEST_ID_CONFLICT','请求编号属于其他操作',409);return s;
  }
  save(id,requestId,s){this.db.prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(s),Date.now(),requestId,id);}
  dto(requestId,s){
    const notStarted=s.status==='preview',interrupted=s.status==='running'&&!this.active.has(requestId),folderRoles=s.folderRoles||this.folders.roleState(s.projectId);
    return{requestId,status:interrupted||notStarted?'unknown':s.status,phase:notStarted?'preview':'execution',folderId:folderRoles.rejectFolderId,folderRoles,roleChange:s.plan.roleChange,unboundShotIds:s.unboundShotIds||[],error:notStarted?'当前只有预览，执行尚未确认，请核对原请求；收纳处未报告准备完成':interrupted?'上次收纳设置未取得最终回执，请核对原请求':s.error||null,errorCode:notStarted?'OPERATION_NOT_STARTED':interrupted?'REJECT_AREA_INTERRUPTED':s.errorCode||null,canRecover:false};
  }
  normalize(input){
    if(!input||!idOK(input.requestId))fail('INVALID_REQUEST_ID','收纳设置请求编号无效');
    if(!Number.isSafeInteger(input.expectedRolesRevision)||input.expectedRolesRevision<0)fail('INVALID_ROLES_REVISION','请提供收纳角色修订号');
    const hasFolder=Object.hasOwn(input,'folderId'),hasCreate=Object.hasOwn(input,'create');
    if(hasFolder===hasCreate)fail('INVALID_REJECT_AREA','请选择一个现有文件夹、取消角色或新建文件夹');
    if(hasFolder){if(input.folderId!==null&&!idOK(input.folderId))fail('INVALID_REJECT_AREA','收纳处必须是当前项目的实体文件夹');return{requestId:input.requestId,expectedRolesRevision:input.expectedRolesRevision,folderId:input.folderId};}
    const create=input.create;
    if(!create||typeof create!=='object'||Array.isArray(create)||Object.keys(create).sort().join(',')!=='name,parentId'||create.parentId!=='root')fail('INVALID_REJECT_AREA','新收纳目录只能建在项目根目录');
    return{requestId:input.requestId,expectedRolesRevision:input.expectedRolesRevision,create:{parentId:'root',name:folderName(create.name)}};
  }
  sources(id,folderId,rows){
    if(!folderId)return[];
    return this.catalog.videos.sources(id).filter(s=>!this.catalog.metadata(id,s).data.removedAt&&this.folders.inSubtree(this.folders.folderId(id,s.path,rows),folderId,rows)).map(s=>({id:s.id,path:s.path,identity:s.identity,revision:this.catalog.metadata(id,s).row?.revision||0,authority:digest(this.catalog.verification.authority(id,s.id))})).sort((a,b)=>a.id.localeCompare(b.id));
  }
  affected(id,sources,adoption=this.catalog.adoption(id)){
    const shots=new Map();for(const source of sources)for(const shot of adoption.shots.get(source.id)||[]){if(!shots.has(shot.id))shots.set(shot.id,{...shot,sourceIds:[]});shots.get(shot.id).sourceIds.push(source.id);}
    return [...shots.values()].map(s=>({...s,sourceIds:s.sourceIds.sort()})).sort((a,b)=>a.id.localeCompare(b.id));
  }
  assertMetadata(id,s){
    this.catalog.project(id,true);const roles=this.folders.roleState(id);
    if(roles.revision!==s.input.expectedRolesRevision||roles.rejectFolderId!==s.plan.roleChange.beforeFolderId)fail('FOLDER_ROLES_CONFLICT','收纳角色或升级设置已变化，请重新预览',409);
    const rows=this.folders.rows(id);if(digest(rows)!==s.folderStamp)fail('FOLDER_CONFLICT','目录资料已变化，请重新预览',409);
    if(!equal(this.sources(id,s.input.create?null:s.input.folderId,rows),s.sources))fail('VIDEO_CONFLICT','收纳目录中的视频或真实授权已变化，请重新预览',409);
    if(this.catalog.adoption(id).stamp!==s.plan.adoptionStamp)fail('ADOPTION_CHANGED','采用关系已变化，请重新确认精确镜号',409);
  }
  async location(id,folderId){
    const location=await this.folders.resolve(id,folderId||'root');
    if(folderId&&!location.exists)fail('TARGET_CHANGED','收纳目录已丢失，请先核对',409);
    return{folderId:folderId||'root',projectPath:location.projectPath,target:location.target,exists:location.exists,rootStamp:location.rootStamp||null,targetIdentity:location.targetIdentity||null};
  }
  async checkLocation(id,s){
    if(!s.location)return;
    const location=await this.location(id,s.location.folderId==='root'?null:s.location.folderId);
    if(!equal(location,s.location))fail('TARGET_CHANGED','收纳目录位置或身份在确认后变化，请重新预览',409);
    this.folders.busy(id,location.target,s.input.requestId);
    if(s.input.create&&location.exists)await this.checkName(location.target,s.input.create.name);
  }
  async checkName(parent,name){if((await fs.readdir(parent)).some(n=>nameKey(n)===nameKey(name)))fail('FOLDER_EXISTS','同名文件或文件夹已存在，请显式选择现有目录或使用其他名称',409);}
  async checkSources(id,s){
    // Role conversion changes adoptions, never retires a source. Only the
    // adopted sources require file authority; empty/unadopted folders can be set
    // without probing every video or manufacturing authority for restored data.
    const affected=new Set(s.plan.affectedShots.flatMap(shot=>shot.sourceIds));
    for(const source of s.sources)if(affected.has(source.id)){
      const current=this.catalog.assertBindableForMove(id,source.id);
      await this.folders.resolve(id,this.folders.folderId(id,current.path));
      await this.catalog.media.verify(current);
    }
  }
  async preview(id,raw){
    this.catalog.project(id,true);const input=this.normalize(raw);
    return this.tracked(async()=>{
      this.catalog.project(id,true);const args=digest(input),old=this.db.prepare('SELECT * FROM project_video_operations WHERE id=?').get(input.requestId);
      if(old){const s=JSON.parse(old.data_json);if(old.project_id!==id||s.kind!=='set-reject-area'||s.args!==args)fail('REQUEST_ID_CONFLICT','请求编号已用于其他输入',409);return s.plan;}
      const roles=this.folders.roleState(id);if(input.expectedRolesRevision!==roles.revision)fail('FOLDER_ROLES_CONFLICT','收纳角色或升级设置已变化，请重新读取',409);
      const rows=this.folders.rows(id);if(input.folderId)this.folders.row(id,input.folderId);
      const afterFolderId=input.create?randomUUID():input.folderId,location=input.folderId||input.create?await this.location(id,input.folderId||null):null;
      if(location){this.folders.busy(id,location.target,input.requestId);if(input.create&&location.exists)await this.checkName(location.target,input.create.name);}
      const sources=this.sources(id,input.folderId||null,rows),adoption=this.catalog.adoption(id);
      const plan={requestId:input.requestId,ready:true,expectedRolesRevision:roles.revision,roleChange:{beforeFolderId:roles.rejectFolderId,afterFolderId,willCreate:!!input.create},affectedShots:this.affected(id,sources,adoption),adoptionStamp:adoption.stamp,rejectVideoCount:sources.length};
      const s={kind:'set-reject-area',projectId:id,args,input,status:'preview',folderStamp:digest(rows),location,sources,plan,unboundShotIds:[]};
      // Freeze identities before persisting the preview. No filesystem creation
      // occurs here, including when the project's video root does not yet exist.
      await this.checkSources(id,s);await this.checkLocation(id,s);this.assertMetadata(id,s);
      plan.previewHash=digest(s);const now=Date.now();this.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(input.requestId,id,canonical(s),now,now);return plan;
    });
  }
  async execute(id,input){
    this.catalog.project(id,true);const s=this.row(id,input?.requestId),requestId=input.requestId;
    if(input.previewHash!==s.plan.previewHash)fail('PREVIEW_REQUIRED','请确认同一请求的收纳设置预览',409);
    if(s.status!=='preview')return this.dto(requestId,s);
    if(input.confirmRoleChange!==true)fail('ROLE_CHANGE_CONFIRMATION_REQUIRED','请明确确认设置、取消或更换收纳处',409);
    if(s.plan.affectedShots.length){
      const expected=s.plan.affectedShots.map(shot=>shot.id).sort(),confirmed=input.confirmedUnbindShotIds;
      if(input.confirmUnbind!==true||!Array.isArray(confirmed)||!equal([...confirmed].sort(),expected))fail('UNBIND_CONFIRMATION_REQUIRED','请确认本次预览中完整且精确的解除镜号集合',409);
    }
    if(this.active.has(requestId))return this.dto(requestId,s);
    // Persist intent before scheduling any IO. Replays never enter perform again.
    s.status='running';s.instance=this.catalog.instance;this.save(id,requestId,s);
    const work=this.tracked(()=>this.perform(id,requestId,s)).finally(()=>this.active.delete(requestId));
    this.active.set(requestId,work);work.catch(()=>{});return this.dto(requestId,s);
  }
  async perform(id,requestId,s){
    let commitAttempted=false;
    try{
      this.assertMetadata(id,s);await this.checkLocation(id,s);await this.checkSources(id,s);this.assertMetadata(id,s);
      let newFolder;
      if(s.input.create){
        const root=await this.catalog.prepareRoot(id);await this.catalog.current(id,root);
        if(root.target!==s.location.target||s.location.exists&&!sameFolder(folderIdentity(await fs.lstat(root.target)),s.location.targetIdentity))fail('TARGET_CHANGED','新建收纳目录的项目根已变化',409);
        this.folders.busy(id,root.target,requestId);await this.checkName(root.target,s.input.create.name);this.assertMetadata(id,s);
        s.file=path.join(root.target,s.input.create.name);s.createStep={status:'planned',parent:root.target,parentIdentity:folderIdentity(await fs.lstat(root.target))};this.save(id,requestId,s);
        await this.catalog.current(id,root);this.catalog.project(id,true);
        await fs.mkdir(s.file,{mode:0o700});
        const st=await fs.lstat(s.file);if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(s.file)!==s.file)fail('TARGET_CHANGED','新建收纳目录身份已变化',409);
        s.createStep.identity=folderIdentity(st);s.createStep.status='created';this.save(id,requestId,s);
        await this.catalog.current(id,root);
        const current=await fs.lstat(s.file);if(!current.isDirectory()||current.isSymbolicLink()||!sameFolder(folderIdentity(current),s.createStep.identity))fail('TARGET_CHANGED','新建目录在登记前已变化',409);
        newFolder={name:s.input.create.name,parentId:'root',relativePath:s.input.create.name,identity:s.createStep.identity,removedAt:0};
      }else{await this.checkSources(id,s);await this.checkLocation(id,s);}
      commitAttempted=true;this.catalog.videos.tx(()=>{
        this.assertMetadata(id,s);
        if(newFolder)this.folders.write(id,s.plan.roleChange.afterFolderId,newFolder);
        this.catalog.detachSources(id,s.sources.map(source=>source.id));
        this.folders.writeSettings(id,{...this.folders.settings(id),rejectFolderId:s.plan.roleChange.afterFolderId},s.input.expectedRolesRevision);
        const result={...s,status:'ready',folderRoles:this.folders.roleState(id),unboundShotIds:s.plan.affectedShots.map(shot=>shot.id),error:null};
        this.save(id,requestId,result);
      });
    }catch(e){
      if(commitAttempted){
        // A lost commit acknowledgement cannot authorize deleting the freshly
        // registered directory. The ready receipt is committed with the role.
        try{const durable=this.row(id,requestId);if(durable.status==='ready')return this.dto(requestId,durable);}
        catch{ s.status='unknown';s.error='收纳设置落盘结果尚未核清，请查询原请求';s.errorCode='REJECT_AREA_COMMIT_UNKNOWN';this.save(id,requestId,s);return this.dto(requestId,s); }
      }
      s.status='failed';s.error=e.message;s.errorCode=e.code||'REJECT_AREA_FAILED';s.unboundShotIds=[];
      if(s.createStep){
        // Remove only the exact empty directory created by this request. Never
        // touch an old role directory or a replacement at the same pathname.
        try{
          const parent=await exists(s.createStep.parent),st=await exists(s.file);
          if(!parent||parent.isSymbolicLink()||!sameFolder(folderIdentity(parent),s.createStep.parentIdentity)||await fs.realpath(s.createStep.parent)!==s.createStep.parent)throw Error('新建目录的上级身份已变化');
          if(st){if(!s.createStep.identity||!st.isDirectory()||st.isSymbolicLink()||!sameFolder(folderIdentity(st),s.createStep.identity)||(await fs.readdir(s.file)).length)throw Error('不能证明新建目录可安全回退');await fs.rmdir(s.file);}
          s.createStep.status='rolled-back';
        }catch(rollback){s.status='unknown';s.error+='；新建目录需核对：'+rollback.message;}
      }
      // If this save also fails, the durable running receipt becomes UNKNOWN
      // when active is removed. It is never returned as a fabricated failure.
      s.folderRoles=this.folders.roleState(id);
      this.save(id,requestId,s);
    }
    return this.dto(requestId,this.row(id,requestId));
  }
}
