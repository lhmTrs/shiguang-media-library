import test from'node:test';import assert from'node:assert/strict';
import{runProtocolHarness}from '../harness.mjs';
import{createCase}from '../scenarios.mjs';
import{evaluatePostconditions,pickPostconditions}from '../contracts.mjs';
test('branded fake cannot run a replaced arbitrary execute callback',async()=>{
 const c=createCase('normal'),original=c.adapters.executor.execute;let replacedCalls=0,replacementRejected=false;
 try{c.adapters.executor.execute=async function(...args){replacedCalls++;return original.apply(this,args);};}catch{replacementRejected=true;}
 const result=await runProtocolHarness(c.scenario,c.adapters);
 console.log(JSON.stringify({replacedCalls,code:result.code,replacementRejected}));
 assert.equal(replacedCalls,0,'brand must not admit replaced callbacks');
 assert.ok(replacementRejected||result.code==='ADAPTER_NOT_FAKE');
});
test('success contract rejects nonzero or signalled exit and invalid byte counts',()=>{
 const raw={exit:{confirmed:true,code:7,signal:'SIGTERM'},job:{state:'cleaned',dirRemoved:true,ownerRemoved:true},processGroup:{own:true,groupGone:true,unknownDescendants:'declared_none'},stdio:{closed:true,stdoutBytes:null,stderrBytes:-1},dispose:{called:true,calls:1,pending:false}};
 const post=pickPostconditions(raw),check=evaluatePostconditions(post,{success:true});console.log(JSON.stringify({post,check}));
 assert.equal(check.ok,false,'successful process must have code0/no signal and finite nonnegative bounded bytes');
});
