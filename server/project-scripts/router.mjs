import express from 'express';
import {scriptError} from './area.mjs';
const multipart=async req=>{
 const type=req.headers['content-type']??'',boundary=/^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i.exec(type);if(!boundary)throw scriptError('SCRIPT_UNSUPPORTED_MEDIA','请使用单文件表单',415);
 const marker=Buffer.from('--'+(boundary[1]??boundary[2]));if(marker.length>204)throw scriptError('SCRIPT_INVALID_INPUT','表单边界无效');let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>25*1024*1024+65536)throw scriptError('SCRIPT_PAYLOAD_TOO_LARGE','资料最大25 MiB',413);chunks.push(chunk);}const data=Buffer.concat(chunks),fields={};let file=null,pos=0;
 if(!data.subarray(0,marker.length).equals(marker))throw scriptError('SCRIPT_INVALID_INPUT','表单格式无效');pos=marker.length;
 while(!data.subarray(pos,pos+2).equals(Buffer.from('--'))){if(data.subarray(pos,pos+2).toString()!=='\r\n')throw scriptError('SCRIPT_INVALID_INPUT','表单格式无效');pos+=2;const hEnd=data.indexOf('\r\n\r\n',pos);if(hEnd<0||hEnd-pos>8192)throw scriptError('SCRIPT_INVALID_INPUT','表单头无效');const headers=data.subarray(pos,hEnd).toString('utf8'),dis=/^content-disposition: form-data; name="([a-zA-Z]+)"(?:; filename="([^"\r\n]*)")?\r?$/im.exec(headers);if(!dis)throw scriptError('SCRIPT_INVALID_INPUT','表单字段无效');const end=data.indexOf(Buffer.concat([Buffer.from('\r\n'),marker]),hEnd+4);if(end<0)throw scriptError('SCRIPT_INVALID_INPUT','表单未完成');const bytes=data.subarray(hEnd+4,end),name=dis[1];if(name==='file'){if(file||dis[2]===undefined)throw scriptError('SCRIPT_INVALID_INPUT','只允许一个文件');file={bytes,originalFilename:dis[2],contentType:/^content-type:\s*([^\r\n]+)\r?$/im.exec(headers)?.[1]?.trim()};}else{if(!['ownerType','requestId'].includes(name)||name in fields||bytes.length>200)throw scriptError('SCRIPT_INVALID_INPUT','表单字段重复或无效');fields[name]=bytes.toString('utf8');}pos=end+2+marker.length;
 }
 if(!file||pos+2!==data.length&&data.subarray(pos+2).toString()!=='\r\n')throw scriptError('SCRIPT_INVALID_INPUT','表单格式无效');return {...file,...fields};
};
export function scriptAreaRouter(area,{libraryId,asyncRoute=fn=>fn}){
 const router=express.Router();
 router.use((req,res,next)=>{res.set('Cache-Control','no-store');try{const h=req.get('x-shiguang-library-id'),content=['GET','HEAD'].includes(req.method)&&/^\/projects\/[^/]+\/materials\/[^/]+\/content$/.test(req.path),q=content?req.query.libraryId:undefined;if(h&&q&&h!==q)throw scriptError('SCRIPT_SCOPE_CHANGED','库身份不一致',409);const id=h??q;if(!id)throw scriptError('SCRIPT_INVALID_INPUT','缺少库身份');if(id!==libraryId())throw scriptError('SCRIPT_SCOPE_CHANGED','当前库已变化',409);next();}catch(e){next(e);}});
 router.use(express.json({limit:'600kb'}));
 const route=(method,url,fn,created=false)=>router[method]('/projects/:projectId'+url,asyncRoute(async(req,res,next)=>{try{area.context(req.params.projectId);const result=await fn(req,res);if(!res.headersSent){const {replayed,...body}=result;res.status(created&&!replayed?201:200).json(body);}}catch(e){next(e);}}));
 const p=r=>r.params.projectId;
 route('get','/draft',r=>area.draft(p(r)));
 route('get','/versions',r=>area.versions(p(r),r.query));
 route('get','/versions/:id',r=>{const s=area.sourceObject(p(r),r.params.id);if(s.kind==='snapshot')throw scriptError('SCRIPT_NOT_FOUND','版本不存在',404);return s;});
 route('post','/versions',r=>area.freeze(p(r),r.body,'version'),true);
 route('get','/draft/snapshots',r=>area.snapshots(p(r),r.query));
 route('get','/draft/snapshots/:id',r=>area.sourceObject(p(r),r.params.id,'snapshot'));
 route('post','/draft/snapshots',r=>area.freeze(p(r),r.body,'snapshot'),true);
 route('get','/sources/:id',r=>area.source(p(r),r.params.id,r.query));
 route('get','/materials',r=>area.materials(p(r),r.query));
 route('get','/materials/:id',r=>area.materialDTO(area.material(p(r),r.params.id),p(r)));
 route('post','/materials',async r=>{const before=area.context(p(r)),f=await multipart(r);if(before.seriesId!==area.context(p(r)).seriesId)throw scriptError('SCRIPT_SCOPE_CHANGED','上传期间项目归属已变化',409);return area.upload(p(r),f,f.bytes);},true);
 route('get','/materials/:id/content',(r,res)=>{const m=area.material(p(r),r.params.id),bytes=area.files.read(m.id,m.sha256),dis=r.query.disposition??'attachment';if(!['inline','attachment'].includes(dis))throw scriptError('SCRIPT_INVALID_INPUT','下载方式无效');res.set({'Content-Type':m.contentType,'Content-Length':String(bytes.length),'X-Content-Type-Options':'nosniff','Content-Disposition':`${dis}; filename="material.${m.originalFilename.split('.').pop().replace(/[^a-z0-9]/ig,'')}"; filename*=UTF-8''${encodeURIComponent(m.originalFilename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`});res.end(r.method==='HEAD'?undefined:bytes);});
 route('post','/materials/:id/move',r=>area.materialChange(p(r),r.params.id,r.body));
 route('post','/materials/:id/delete',r=>area.materialChange(p(r),r.params.id,r.body,true));
 route('post','/maps/dry-run',r=>area.assets.tx(()=>{area.context(p(r),true);return area.render(p(r),r.body);}));
 route('post','/maps',r=>area.createMap(p(r),r.body),true);
 route('get','/maps',r=>area.maps(p(r),r.query));
 route('get','/maps/requests/:id',r=>area.mapRequest(p(r),r.params.id));
 route('get','/maps/:id',r=>area.mapRead(p(r),r.params.id));
 router.use((_req,_res,next)=>next(scriptError('SCRIPT_NOT_FOUND','剧本区接口不存在',404)));
 router.use((e,req,res,next)=>{if(res.headersSent)return next(e);const code=e.code?.startsWith('SCRIPT_')?e.code:e.type==='entity.too.large'?'SCRIPT_PAYLOAD_TOO_LARGE':e instanceof SyntaxError?'SCRIPT_INVALID_INPUT':'SCRIPT_STORAGE_UNAVAILABLE',status=e.status??(code==='SCRIPT_STORAGE_UNAVAILABLE'?503:400),message=e.code?.startsWith('SCRIPT_')?e.message:code==='SCRIPT_STORAGE_UNAVAILABLE'?'剧本区存储暂不可用':'剧本区请求无效';res.status(status).json({code,message,error:message,...(e.details?{details:e.details}:{}),...(e.issues?{issues:e.issues}:{})});});
 return router;
}
