// Private, synchronous readback is required by FileIntake's receipt API. There
// is no media/schema migration here; each request owns one fsynced JSON journal.
import fs, {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {uuid, error, stamp} from './files.mjs';

export const directoryIdentity = st => ({dev:String(st.dev), ino:String(st.ino)});
export const sameDirectory = (a,b) => a?.dev === b?.dev && a?.ino === b?.ino;

export function assertDirectories(proofs) {
  for (const {path: directory, identity,privateOnly=false} of proofs) {
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(directory) !== directory || !sameDirectory(directoryIdentity(st), identity) ||
        privateOnly && ((process.getuid && st.uid!==process.getuid()) || (process.platform!=='win32' && (st.mode&0o077))))
      throw error('TARGET_CHANGED', '收纳目录身份或上级路径已变化');
  }
}

export class MediaReceipts {
  constructor(base) { this.base=base; this.proofs=[]; }
  init() {
    // The caller supplies a canonical existing data directory. Check every new
    // level separately, so mkdir never follows a pre-existing link.
    const data=path.dirname(path.dirname(this.base));
    for (const directory of [data,path.dirname(this.base),this.base]) {
      if (!fs.existsSync(directory)) fs.mkdirSync(directory,{mode:0o700});
      const st=fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(directory)!==directory ||
          directory!==data && ((process.getuid && st.uid!==process.getuid()) || (process.platform!=='win32' && (st.mode&0o077))))
        throw error('INTAKE_PRIVATE_DIRECTORY','通用收纳回执目录必须私有且不能使用链接');
      this.proofs.push({path:directory,identity:directoryIdentity(st),privateOnly:directory!==data});
    }
    return this;
  }
  file(id) {
    if (!uuid(id)) throw error('IMPORT_NOT_FOUND','未找到这次收纳回执',404);
    assertDirectories(this.proofs); return path.join(this.base,id+'.json');
  }
  read(id) {
    const file=this.file(id); let fd;
    try {
      fd=fs.openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const st=fs.fstatSync(fd);
      if (!st.isFile() || st.size>8*1024*1024 || (process.getuid && st.uid!==process.getuid()) || (process.platform!=='win32' && (st.mode&0o077)))
        throw error('INTAKE_RECEIPT_INVALID','通用收纳回执不可读');
      const value=JSON.parse(fs.readFileSync(fd,'utf8'));
      assertDirectories(this.proofs);
      if (JSON.stringify(stamp(st))!==JSON.stringify(stamp(fs.lstatSync(file))) || !value || value.id!==id || value.version!==1)
        throw error('INTAKE_RECEIPT_INVALID','通用收纳回执身份已变化');
      return value;
    } catch(e) {
      if(e.code==='ENOENT') throw error('IMPORT_NOT_FOUND','未找到这次收纳回执',404);
      throw e;
    } finally {if(fd!==undefined) fs.closeSync(fd);}
  }
  write(value,{exclusive=false}={}) {
    const target=this.file(value.id), temporary=target+'.'+randomUUID()+'.tmp';
    const fd=fs.openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    assertDirectories(this.proofs);
    try {
      if(exclusive) {fs.linkSync(temporary,target);fs.unlinkSync(temporary);}
      else fs.renameSync(temporary,target);
      const directory=fs.openSync(this.base,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
      assertDirectories(this.proofs);
    } catch(e) {
      // Only touch our private temporary after its directory is revalidated.
      assertDirectories(this.proofs);
      try {fs.unlinkSync(temporary);} catch(cleanup) {if(cleanup.code!=='ENOENT') throw cleanup;}
      throw e;
    }
  }
  list() {
    assertDirectories(this.proofs);
    return fs.readdirSync(this.base).filter(n=>n.endsWith('.json') && uuid(n.slice(0,-5))).map(n=>this.read(n.slice(0,-5)));
  }
}
