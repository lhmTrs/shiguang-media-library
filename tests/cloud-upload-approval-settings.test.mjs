import test from "node:test";
import assert from "node:assert/strict";
import { CloudManagement } from "../server/cloud-management.mjs";
import { CloudAuthError } from "../server/cloud-auth.mjs";

const value = { thresholdMb: 128, thresholdBytes: 128000000, version: 1, configured: true };
function fixture(proxy) { return new CloudManagement({}, { cloudAuth: { epoch: 0, proxy } }); }

test("approval settings only use fixed GET/PUT paths, allowlisted input and response DTO", async () => {
  const calls=[]; const management=fixture(async (...args) => { calls.push(args);return { ...value, secret: "synthetic-hidden" }; });
  assert.deepEqual(await management.uploadApprovalSettings(), value);
  assert.deepEqual(await management.updateUploadApprovalSettings({ thresholdMb:128, expectedVersion:0 }), value);
  assert.deepEqual(calls.map(c=>c.slice(0,2)), [["GET","/system/upload-approval-settings"],["PUT","/system/upload-approval-settings"]]);
  assert.deepEqual(calls[1][2].body, { thresholdMb:128, expectedVersion:0 });
  assert.equal(calls[1][2].bearer,true); assert.equal(calls[1][2].epoch,0);
  for(const payload of [{thresholdMb:0,expectedVersion:0},{thresholdMb:2049,expectedVersion:0},{thresholdMb:1.1,expectedVersion:0},{thresholdMb:"100",expectedVersion:0},{thresholdMb:100,expectedVersion:-1},{thresholdMb:100,expectedVersion:0.5},{thresholdMb:100,expectedVersion:0,owner:true}])
    await assert.rejects(management.updateUploadApprovalSettings(payload),e=>e.code==="INVALID_REQUEST");
  assert.equal(calls.length,2);
});
test("approval writes preserve 409 conflicts without retry or overwrite", async () => {
  let calls=0; const management=fixture(async ()=>{calls++;throw new CloudAuthError("synthetic conflict",{code:"VERSION_CONFLICT",status:409});});
  await assert.rejects(management.updateUploadApprovalSettings({thresholdMb:128,expectedVersion:0}),e=>e.code==="VERSION_CONFLICT" && e.status===409);
  assert.equal(calls,1);
});
test("approval response rejects inconsistent bytes and never echoes unknown fields", async ()=>{
  const management=fixture(async()=>({...value,thresholdBytes:134217728}));
  await assert.rejects(management.uploadApprovalSettings(),e=>e.code==="RESPONSE_INVALID");
});
test("queued approval writes stay bound to originating identity", async ()=>{
  let release;let arrived;const ready=new Promise(r=>arrived=r);const gate=new Promise(r=>release=r);let calls=0;
  const auth={epoch:0,getState:()=>({state:"logged-in"}),proxy:async()=>{calls++;arrived();await gate;return value;}};
  const management=new CloudManagement({}, {cloudAuth:auth});
  const first=management.updateUploadApprovalSettings({thresholdMb:128,expectedVersion:0});await ready;
  const second=management.updateUploadApprovalSettings({thresholdMb:129,expectedVersion:1});
  const result=Promise.allSettled([first,second]);auth.epoch=1;release();
  const settled=await result;assert.ok(settled.every(r=>r.status==="rejected"&&r.reason.code==="STALE"));assert.equal(calls,1);
});
