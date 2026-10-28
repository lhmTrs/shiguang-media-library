import assert from'node:assert/strict';
import{runProtocolHarness}from'../harness.mjs';
import{createCase,NORMAL_RAW}from'../scenarios.mjs';
import{createFakeExecutor}from'../fakes.mjs';
const c=createCase('normal'),options={raw:NORMAL_RAW};const executor=createFakeExecutor(options);let getterCalls=0;
Object.defineProperty(options,'hang',{get(){getterCalls++;return false;}});
const result=await runProtocolHarness(c.scenario,{...c.adapters,executor});
console.log(JSON.stringify({frozenFake:Object.isFrozen(executor),getterCalls,code:result.code}));
assert.equal(getterCalls,0,'fake must not retain mutable caller options that inject callbacks after registration');
