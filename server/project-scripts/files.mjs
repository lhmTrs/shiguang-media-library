import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {idOK} from '../project-assets/model.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export class ScriptFiles{
 constructor(dataDir){this.root=path.join(dataDir,'script-materials');}
 directory(){fs.mkdirSync(this.root,{recursive:true,mode:0o700});const st=fs.lstatSync(this.root);if(!st.isDirectory()||st.isSymbolicLink())throw Error('UNSAFE_SCRIPT_DIRECTORY');return fs.realpathSync(this.root);}
 file(id){if(!idOK(id))throw Error('INVALID_FILE_ID');return path.join(this.directory(),id);}
 read(id,expected){const file=this.file(id),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>25*1024*1024)throw Error('UNSAFE_SCRIPT_FILE');const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const a=fs.fstatSync(fd);if(a.dev!==s.dev||a.ino!==s.ino)throw Error('SCRIPT_FILE_CHANGED');const bytes=fs.readFileSync(fd),b=fs.fstatSync(fd),after=fs.lstatSync(file);if(a.ino!==after.ino||a.dev!==after.dev||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs||expected&&sha(bytes)!==expected)throw Error('SCRIPT_FILE_CHANGED');return bytes;}finally{fs.closeSync(fd);}}
 write(id,bytes,expected=sha(bytes)){const file=this.file(id);if(fs.existsSync(file)){this.read(id,expected);return;}const temp=this.file(randomUUID());let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;this.read(path.basename(temp),expected);fs.linkSync(temp,file);fs.unlinkSync(temp);this.read(id,expected);if(process.platform!=='win32'){const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
 remove(id,expected){const file=this.file(id);try{this.read(id,expected);fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
