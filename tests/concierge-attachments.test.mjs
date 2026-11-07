import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable,PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ConciergeAttachments} from '../server/concierge/attachments.mjs';
const exec=promisify(execFile), model={inputModalities:['text','image']};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t){const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'concierge-attachment-'))),root=path.join(parent,'copies'),a=await new ConciergeAttachments(root).init();t.after(async()=>{await a.close();await fs.rm(parent,{recursive:true,force:true});});return {a,root,parent};}
async function put(a,bytes,name='note.txt',scope='global'){const id=randomUUID();await a.prepare(scope,{id,name,size:bytes.length,mime:'application/octet-stream'});return {id,dto:await a.upload(scope,id,Readable.from([bytes]))};}
function zip(entries){const local=[],central=[];let offset=0;for(const [name,text] of Object.entries(entries)){const n=Buffer.from(name),b=Buffer.from(text);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);local.push(h,n,b);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+b.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);}
function pdf(){const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const text='BT /F1 12 Tf 20 150 Td (Synthetic PDF) Tj ET';objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);let s='%PDF-1.4\n',offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(s));s+=`${i+1} 0 obj\n${o}\nendobj\n`;}const x=Buffer.byteLength(s);s+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(s);}

test('stream copy / inputs / preview / sent retention survive restart; original unchanged',async t=>{
 const {a,root,parent}=await fixture(t),original=path.join(parent,'original.txt');await fs.writeFile(original,'原文');const originalHash=createHash('sha256').update(await fs.readFile(original)).digest('hex');
 const id=randomUUID();await a.prepare('global',{id,name:'原文.txt',size:6,mime:'text/plain'});await assert.rejects(a.inputs('global',[id],{model}),/尚未准备/);
 const dto=await a.upload('global',id,(await fs.open(original)).createReadStream());assert.equal(dto.status,'ready');const result=await a.inputs('global',[id],{model});assert.match(result.input[0].text,/原文/);assert.equal(result.attachments[0].id,id);
 await a.markSent('global',[id]);await assert.rejects(a.remove('global',id),/已发送/);await a.close();const b=await new ConciergeAttachments(root).init();try{assert.equal((await b.get('global',id)).sent,true);assert.match((await b.inputs('global',[id],{model})).input[0].text,/原文/);}finally{await b.close();}
 assert.equal(createHash('sha256').update(await fs.readFile(original)).digest('hex'),originalHash);
});
test('validation, pending quotas, duplicate identity and cross-scope isolation',async t=>{
 const {a}=await fixture(t),scope=randomUUID(),id=randomUUID();
 await assert.rejects(a.inputs(scope,[],{model:{}}),/模型不支持/);
 await assert.rejects(a.prepare('../outside',{id,name:'a.txt',size:1,mime:''}),/范围/);
 for(const name of ['../a.txt','bad.exe','x.svg'])await assert.rejects(a.prepare(scope,{id,name,size:1,mime:''}));
 await assert.rejects(a.prepare(scope,{id,name:'a.txt',size:26*1024**2,mime:''}),/大小/);
 await a.prepare(scope,{id,name:'a.txt',size:1,mime:''});assert.equal((await a.prepare(scope,{id,name:'a.txt',size:1,mime:''})).id,id);
 await assert.rejects(a.prepare(scope,{id,name:'b.txt',size:1,mime:''}),/其他文件/);await assert.rejects(a.get('global',id));
 for(let i=0;i<9;i++)await a.prepare(scope,{id:randomUUID(),name:`${i}.txt`,size:1,mime:''});
 await assert.rejects(a.prepare(scope,{id:randomUUID(),name:'11.txt',size:1,mime:''}),/最多10/);
 const other=randomUUID();await a.prepare(other,{id:randomUUID(),name:'a.mp4',size:256*1024**2,mime:''});await a.prepare(other,{id:randomUUID(),name:'b.mp4',size:256*1024**2,mime:''});await assert.rejects(a.prepare(other,{id:randomUUID(),name:'c.txt',size:1,mime:''}),/512/);
});
test('oversize, short stream and stream errors produce readable failed DTO; no retry',async t=>{
 const {a}=await fixture(t);for(const [size,data]of [[1,Buffer.from('xx')],[3,Buffer.from('x')]]){const id=randomUUID();await a.prepare('global',{id,name:'a.txt',size,mime:''});const dto=await a.upload('global',id,Readable.from([data]));assert.equal(dto.status,'failed');assert.match(dto.error,/大小/);await assert.rejects(a.inputs('global',[id],{model}),/尚未准备/);await assert.rejects(a.upload('global',id,Readable.from([data])),/重新添加/);await a.remove('global',id);}
 const id=randomUUID();await a.prepare('global',{id,name:'broken.txt',size:1,mime:''});const stream=Readable.from((async function*(){throw Error('synthetic disconnect');})());assert.match((await a.upload('global',id,stream)).error,/disconnect/);
});
test('image inputs require model image modality; preview returns checked file handle',async t=>{
 const {a}=await fixture(t),{id,dto}=await put(a,png,'pic.png');assert.equal(dto.status,'ready');
 for(const model of [{},{inputModalities:['text']},{inputModalities:['image']}])await assert.rejects(a.inputs('global',[id],{model}),/模型不支持/);
 const result=await a.inputs('global',[id],{model});assert.equal(result.input[1].type,'localImage');const opened=await a.openPreview('global',id);try{assert.equal(opened.mime,'image/png');assert.equal(opened.size,png.length);assert.deepEqual(await opened.handle.readFile(),png);}finally{await opened.handle.close();}
 await a.remove('global',id);assert.equal((await a.list('global')).length,0);
});
test('same-size content tampering, hard links and symlinks never become sendable',async t=>{
 const {a,root,parent}=await fixture(t);let {id}=await put(a,Buffer.from('abc'));const file=path.join(root,'global',id,'source.txt');await fs.writeFile(file,'xyz');await assert.rejects(a.inputs('global',[id],{model}),/哈希|身份/);
 await a.remove('global',id);({id}=await put(a,Buffer.from('abc')));const f=path.join(root,'global',id,'source.txt'),outside=path.join(parent,'outside');await fs.writeFile(outside,'secret');await fs.unlink(f);await fs.symlink(outside,f);await assert.rejects(a.inputs('global',[id],{model}),/普通文件|路径/);await assert.rejects(a.remove('global',id),/身份/);assert.equal(await fs.readFile(outside,'utf8'),'secret');
 await fs.unlink(f);await fs.link(outside,f);await assert.rejects(a.inputs('global',[id],{model}),/普通文件/);
});
test('root/scope directory substitution refused; original outside tree preserved',async t=>{
 const {a,root,parent}=await fixture(t),{id}=await put(a,Buffer.from('abc'));await fs.rename(path.join(root,'global'),path.join(root,'saved'));await fs.symlink(path.join(root,'saved'),path.join(root,'global'));await assert.rejects(a.get('global',id),/符号链接|真实路径/);
 const link=path.join(parent,'rootlink');await fs.symlink(root,link);const b=new ConciergeAttachments(link);await assert.rejects(b.init(),/符号链接|真实路径/);await b.close();
});
test('PDF and Office existing local tools parse bounded text without execution',async t=>{
 const {a,parent}=await fixture(t);const marker=path.join(parent,'executed');
 const p=await put(a,pdf(),'sample.pdf');assert.equal(p.dto.status,'ready',p.dto.error);assert.match((await a.inputs('global',[p.id],{model})).input[0].text,/Synthetic PDF/);
 for(const [name,entries,expected]of [
  ['sample.docx',{'word/document.xml':'<w:document xmlns:w="urn:word"><w:p><w:r><w:t>合成剧本</w:t></w:r></w:p></w:document>','word/vbaProject.bin':`touch ${marker}`},/合成剧本/],
  ['sample.pptx',{'ppt/slides/slide1.xml':'<a:p xmlns:a="urn:ppt"><a:t>Slide one</a:t></a:p>'},/Slide one/],
  ['sample.xlsx',{'xl/sharedStrings.xml':'<sst><si><t>Shared text</t></si></sst>','xl/worksheets/sheet1.xml':'<worksheet><row><c><v>0</v></c></row></worksheet>'},/Shared text/],
 ]){const r=await put(a,zip(entries),name);assert.equal(r.dto.status,'ready',r.dto.error);assert.match((await a.inputs('global',[r.id],{model})).input[0].text,expected);}
 await assert.rejects(fs.access(marker));
});
test('bad documents, XML entities, zip traversal, missing tools and tool output bounds are readable failures',async t=>{
 const {a}=await fixture(t);
 for(const [name,b]of [['bad.pdf',Buffer.from('oops')],['bad.docx',zip({'word/document.xml':'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'})],['bad.pptx',zip({'../escape':'x','ppt/slides/slide1.xml':'<x>data</x>'})],['bad.xlsx',zip({'xl/worksheets/sheet1.xml':'<bad>'})]]){const {dto}=await put(a,b,name);assert.equal(dto.status,'failed');assert.ok(dto.error);}
 await assert.rejects(a.tool('unzip',['-p','/definitely/missing'],{max:2,timeout:1000}),/无法解析/);
 await assert.rejects(a.tool('unzip',['-h'],{max:5}),/输出超限/);
 await assert.rejects(a.tool('missing-concierge-tool',[]),/缺少本机/);
});
test('synthetic video uses <=12 frames with explicit times and audio not analyzed',async t=>{
 const {a,parent}=await fixture(t),video=path.join(parent,'synthetic.mp4');await exec('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x48:r=2','-f','lavfi','-i','sine=frequency=400','-t','13','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',video]);
 const {id,dto}=await put(a,await fs.readFile(video),'synthetic.mp4');assert.equal(dto.status,'ready',dto.error);assert.equal(dto.analysis.frames.length,12);assert.equal(dto.analysis.audioAnalyzed,false);assert.equal(dto.analysis.hasAudio,true);assert.equal(dto.analysis.frames[0].timeSeconds,0);
 const inputs=await a.inputs('global',[id],{model});assert.equal(inputs.input.filter(i=>i.type==='localImage').length,dto.analysis.frames.length);assert.match(inputs.input.map(i=>i.text??'').join(''),/音轨未分析/);
 await assert.rejects(a.inputs('global',[id],{model:{inputModalities:['text']}}),/模型不支持/);
});
test('close cancels an active upload and waits for settlement',async t=>{
 const {a}=await fixture(t),id=randomUUID();await a.prepare('global',{id,name:'wait.txt',size:5,mime:''});const stream=new PassThrough(),upload=a.upload('global',id,stream);await new Promise(resolve=>setTimeout(resolve,30));await a.close();assert.equal((await upload).status,'failed');await assert.rejects(a.list('global'),/关闭/);
});
test('HTTP preparation body may carry scope; ready content is immutable and copied DTO is isolated',async t=>{
 const {a}=await fixture(t),scope=randomUUID(),id=randomUUID();await a.prepare(scope,{scope,id,name:'locked.txt',size:3,mime:'text/plain'});await a.upload(scope,id,Readable.from([Buffer.from('abc')]));
 await assert.rejects(a.upload(scope,id,Readable.from([Buffer.from('xyz')])),/重新添加/);assert.match((await a.inputs(scope,[id],{model})).input[0].text,/abc/);
 const dto=await a.get(scope,id);dto.status='pending';assert.equal((await a.get(scope,id)).status,'ready');
});
test('text truncation is explicit, binary/invalid-image/playlist disguise cannot become ready',async t=>{
 const {a}=await fixture(t),r=await put(a,Buffer.from('长'.repeat(200001)));assert.equal(r.dto.analysis.truncated,true);assert.equal(r.dto.analysis.characters,200001);assert.equal((await a.inputs('global',[r.id],{model})).input[0].text.endsWith('长'.repeat(200000)),true);
 for(const [name,b]of [['binary.txt',Buffer.from([0,1,2])],['corrupt.png',Buffer.from('89504e470d0a1a0a','hex')],['disguise.mp4',Buffer.from('#EXTM3U\nfile:///etc/passwd\n')]]){const {dto}=await put(a,b,name);assert.equal(dto.status,'failed');assert.ok(dto.error);}
});
test('Office XML expanded-byte bound is enforced with actual unzip; timeout and missing parser give failed metadata',async t=>{
 const {a}=await fixture(t);const big=await put(a,zip({'word/document.xml':'<doc>'+('a'.repeat(4*1024**2))+'</doc>'}),'big.docx');assert.equal(big.dto.status,'failed');assert.match(big.dto.error,/输出超限/);
 await assert.rejects(a.tool('unzip',['-h'],{timeout:0}),/超时/);
 const original=a.tool;a.tool=async()=>{throw Error('缺少本机 pdftotext 工具，附件未准备');};try{const p=await put(a,pdf(),'missing-tool.pdf');assert.equal(p.dto.status,'failed');assert.match(p.dto.error,/缺少本机/);}finally{a.tool=original;}
});
test('interrupted persisted upload is clearly failed after re-open and only unsent copy may be removed',async t=>{
 const {a,root}=await fixture(t),id=randomUUID();await a.prepare('global',{id,name:'interrupted.txt',size:1,mime:''});const file=path.join(root,'global',id,'attachment.json'),m=JSON.parse(await fs.readFile(file,'utf8'));m.status='uploading';await fs.writeFile(file,JSON.stringify(m));const dto=await a.get('global',id);assert.equal(dto.status,'failed');assert.match(dto.error,/先前上传未完成/);await a.remove('global',id);
});
