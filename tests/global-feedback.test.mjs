import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/feedback-store.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
const {createFeedbackStore, describeFeedback, feedbackText} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
function setup() {
  let time = 0, sequence = 0;
  const timers = new Map();
  const store = createFeedbackStore({now: () => time, schedule: (fn, ms) => {const id = ++sequence; timers.set(id, {at: time + ms, fn}); return id;}, cancel: id => timers.delete(id)});
  const tick = ms => {const end = time + ms; for (;;) {const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; time = next[1].at; timers.delete(next[0]); next[1].fn();} time = end;};
  return {store, tick, items: () => store.getSnapshot().items};
}

test('severity defaults expire then leave for 240ms, without extending for duplicates', () => {
  for (const [kind, delay] of [['error',8000],['warning',6000],['success',4000],['info',4000]]) {
    const {store,tick,items} = setup();
    const id = store.publish({kind,message:'合成反馈'});
    tick(delay - 1); assert.equal(items()[0].leaving, false);
    assert.equal(store.publish({kind,message:'合成反馈'}), id); assert.equal(items()[0].count,2);
    tick(1); assert.equal(items()[0].leaving,true); tick(239); assert.equal(items().length,1); tick(1); assert.equal(items().length,0);
  }
});
test('hover, focus and hidden pauses compose and resume only the remaining lifetime', () => {
  const {store,tick,items} = setup(); const id=store.publish({kind:'error',message:'失败'});
  tick(3000); store.pause(id,'hover',true); store.pause(id,'focus',true); store.setHidden(true);
  tick(20000); store.pause(id,'hover',false); store.pause(id,'focus',false); tick(20000); assert.equal(items()[0].leaving,false);
  store.setHidden(false); tick(4999); assert.equal(items()[0].leaving,false); tick(1); assert.equal(items()[0].leaving,true);
});
test('queue is bounded and begins its lifetime only after becoming visible', () => {
  const {store,tick,items}=setup(); for(let i=0;i<4;i++)store.publish({message:'错误'+i,kind:'error'});
  assert.equal(items().length,3); assert.equal(store.getSnapshot().waiting,1);
  store.dismiss(items()[0].id); tick(240); assert.equal(items()[2].message,'错误3');
  tick(7999); assert.equal(items().find(i=>i.message==='错误3').leaving,false); tick(1); assert.equal(items().find(i=>i.message==='错误3').leaving,true);
  store.clear(); for(let i=0;i<30;i++)store.publish({message:'突发错误'+i,kind:'error'});
  assert.equal(items().length,3); assert.equal(store.getSnapshot().waiting,8);
});
test('cooldown suppresses repeated dismissed errors but allows distinct errors', () => {
  const {store,tick}=setup();const id=store.publish({message:'失败',kind:'error'});store.dismiss(id);tick(240);
  assert.equal(store.publish({message:'失败',kind:'error'}),null);assert.ok(store.publish({message:'另一失败',kind:'error'}));
  tick(10000);assert.ok(store.publish({message:'失败',kind:'error'}));
});
test('classification keeps safe cancellation/progress quiet and does not treat busy as success', () => {
  assert.equal(describeFeedback({message:'已取消本次操作',kind:'auto'}),null);
  assert.equal(describeFeedback({message:'正在读取任务',kind:'auto'}),null);
  assert.equal(describeFeedback({message:'HOST_BUSY',kind:'error'}).kind,'warning');
  const cases=[['请选择图片','input'],['Failed to fetch','connection'],['请先登录','account'],['UNKNOWN','conflict'],['原文件缺失','file'],['HTTP 503','service'],['操作失败','operation']];
  for(const [message,category] of cases)assert.equal(describeFeedback({message,kind:'error'}).category,category);
  assert.equal(describeFeedback({message:'图片保存失败',kind:'auto'}).kind,'error');
  assert.equal(describeFeedback({message:'已保存资料',kind:'auto'}).kind,'success');
});
test('display text bounds noise and redacts common credential formats', () => {
  const secret='sk-'+'x'.repeat(32);const text=feedbackText('Bearer abc.def password=secret api_key=other '+secret);
  for(const value of ['abc.def','secret','other',secret])assert.ok(!text.includes(value));
  assert.equal(feedbackText('x'.repeat(3000)).length,600);
});
