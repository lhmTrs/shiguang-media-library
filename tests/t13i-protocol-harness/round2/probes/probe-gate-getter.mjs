import assert from 'node:assert/strict';
import {runProtocolHarness} from '../harness.mjs';
import {createCase} from '../scenarios.mjs';
const c=createCase('normal');let getterCalls=0;
Object.defineProperty(c.scenario,'mode',{get(){getterCalls++;return 'real';}});
const r=await runProtocolHarness(c.scenario,c.adapters);
console.log(JSON.stringify({getterCalls,code:r.code,sideEffects:r.sideEffects}));
assert.equal(getterCalls,0,'reject accessor scenario without invoking caller code');
