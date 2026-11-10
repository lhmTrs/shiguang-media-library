import path from 'node:path';
import fs from 'node:fs';
const internal=new Set(['picture','video','system_picture','system_video','system_music','system_sfx']);
const hidden=new Set(['picture','video','system_picture','system_video']);
export function managedRootPolicy(directory){
  let base=path.resolve(directory);
  // Match ManagedIntakeCatalog.init: canonicalize the existing parent only.
  // The managed directory itself must never be accepted through a symlink.
  try {base=path.join(fs.realpathSync(path.dirname(base)),path.basename(base));}
  catch(e) {if(e.code!=='ENOENT') throw e;}
  return root=>{const name=path.basename(root.path);const managed=path.dirname(path.resolve(root.path))===base&&internal.has(name);return{managed,hidden:managed&&hidden.has(name)};};
}
// This is only navigation policy. Library queries/counts still include managed
// roots and their asset IDs; original bindings are never rewritten or retired.
export function protectManagedRoots(app,lib,directory){const policy=managedRootPolicy(directory);
  app.use('/api/roots/:id',(req,res,next)=>{if(['PATCH','DELETE'].includes(req.method)||req.method==='POST'&&/^\/(retire|relocate|removal-preview)\/?$/i.test(req.path)){
    const root=lib.allRoots().find(r=>r.id===req.params.id);if(root&&policy(root).managed)return res.status(403).json({code:'MANAGED_ROOT_PROTECTED',error:'这是拾光托管目录，不能删除、注销或更改位置；素材与项目关联保留'});
  }next();});return roots=>roots.filter(root=>!policy(root).hidden);
}
