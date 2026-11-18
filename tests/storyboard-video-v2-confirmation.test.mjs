import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmUnbind} from '../server/storyboard-video-v2/confirmation.mjs';
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',wrong='10000000-0000-4000-8000-000000000003';
const affected=[{projectId:a,shotId:'same'},{projectId:b,id:'same'}],refs=[{projectId:a,shotId:'same'},{projectId:b,shotId:'same'}];
test('cross-episode same IDs require complete distinct composite refs, not duplicated legacy strings',()=>{
 assert.doesNotThrow(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:[...refs].reverse()},affected));
 assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotIds:['same']},affected),{code:'VIDEO_UNBIND_SCOPE_REQUIRED'});
 assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotIds:['same','same']},affected),{code:'VIDEO_V2_INVALID_INPUT'});
 for(const actual of [[refs[0]],[refs[0],{projectId:wrong,shotId:'same'}]])assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:actual},affected),{code:'UNBIND_CONFIRMATION_REQUIRED'});
});
test('malformed, duplicate pairs, mutually present fields and conflicting row identities cannot authorize unbind',()=>{
 for(const actual of [[refs[0],refs[0]],[{shotId:'same'}],[{projectId:'bad',shotId:'same'}],[{...refs[0],extra:true}]])assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:actual},affected),{code:'VIDEO_V2_INVALID_INPUT'});
 assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:refs,confirmedUnbindShotIds:[]},affected),{code:'VIDEO_V2_INVALID_INPUT'});
 assert.throws(()=>confirmUnbind({confirmedUnbindShotRefs:refs},affected),{code:'UNBIND_CONFIRMATION_REQUIRED'});
 assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:[]},[{projectId:a,id:'a',shotId:'b'}]),{code:'VIDEO_BINDING_CONFLICT'});
});
test('legacy unique IDs stay compatible across episodes; empty explicit fields still validate shape and mutual exclusion',()=>{
 const unique=[{projectId:a,id:'one'},{projectId:b,shotId:'two'}];assert.doesNotThrow(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotIds:['two','one']},unique));assert.doesNotThrow(()=>confirmUnbind({confirmedUnbindShotRefs:[]},[]));assert.doesNotThrow(()=>confirmUnbind({},[]));
 assert.throws(()=>confirmUnbind({confirmedUnbindShotRefs:[],confirmedUnbindShotIds:[]},[]),{code:'VIDEO_V2_INVALID_INPUT'});assert.throws(()=>confirmUnbind({confirmedUnbindShotRefs:null},[]),{code:'VIDEO_V2_INVALID_INPUT'});
});

test('direct callers may propagate undefined optional fields as omissions while null remains malformed',()=>{
 const unique=[{projectId:a,shotId:'one'}];
 for(const omitted of [{},{confirmedUnbindShotRefs:undefined},{confirmedUnbindShotIds:undefined},{confirmedUnbindShotRefs:undefined,confirmedUnbindShotIds:undefined}]){
  assert.doesNotThrow(()=>confirmUnbind(omitted,[]));assert.throws(()=>confirmUnbind({...omitted,confirmUnbind:true},unique),{code:'UNBIND_CONFIRMATION_REQUIRED'});
 }
 assert.doesNotThrow(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:refs,confirmedUnbindShotIds:undefined},affected));
 assert.doesNotThrow(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:undefined,confirmedUnbindShotIds:['one']},unique));
 for(const field of ['confirmedUnbindShotRefs','confirmedUnbindShotIds'])for(const value of [null,false,'',{},0])assert.throws(()=>confirmUnbind({[field]:value},[]),{code:'VIDEO_V2_INVALID_INPUT'});
});
test('strict empty-impact operations still require an explicit empty set and confirmation after undefined is omitted',()=>{
 const options={requireConfirmation:true,invalidCode:'INVALID_INPUT'};
 for(const input of [{},{confirmUnbind:true},{confirmUnbind:true,confirmedUnbindShotIds:undefined},{confirmUnbind:true,confirmedUnbindShotRefs:undefined},{confirmUnbind:false,confirmedUnbindShotIds:[]}])assert.throws(()=>confirmUnbind(input,[],options),{code:'UNBIND_CONFIRMATION_REQUIRED'});
 for(const input of [{confirmUnbind:true,confirmedUnbindShotIds:[]},{confirmUnbind:true,confirmedUnbindShotRefs:[],confirmedUnbindShotIds:undefined}])assert.doesNotThrow(()=>confirmUnbind(input,[],options));
 assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotIds:null},[],options),{code:'INVALID_INPUT'});
 assert.throws(()=>confirmUnbind({confirmUnbind:true,confirmedUnbindShotRefs:[],confirmedUnbindShotIds:[]},[],options),{code:'INVALID_INPUT'});
});
