import assert from'node:assert/strict';
import{createFakeExecutor}from'../fakes.mjs';
const raw=Object.create(Buffer.prototype);let iteratorCalls=0;
Object.defineProperty(raw,Symbol.iterator,{value:function*(){iteratorCalls++;yield* Buffer.from('{"bpm":120}');}});
let rejected=false;try{createFakeExecutor({raw});}catch(e){rejected=e.code==='INVALID_REQUEST';}
console.log(JSON.stringify({bufferPredicate:Buffer.isBuffer(raw),realTypedArray:ArrayBuffer.isView(raw),iteratorCalls,rejected}));
assert.equal(iteratorCalls,0,'non-view masquerading as Buffer must be rejected before iterable fallback');
assert.equal(rejected,true,'raw supports real bytes, not caller iterables');
