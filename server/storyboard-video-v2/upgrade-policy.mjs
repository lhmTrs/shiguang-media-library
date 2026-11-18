import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './model.mjs';
import {privateDirectory,readPrivateJson,writePrivateJson,validateUpgradePolicy} from './upgrade-files.mjs';

// Explicit maintenance action. It never opens a database or reads connection credentials.
export async function upgradePolicy({dataDir,instanceId,mode,reason,expectedPolicyId,check=false}){
 if(!path.isAbsolute(dataDir??'')||typeof instanceId!=='string'||!instanceId.trim())fail('VIDEO_V2_UPGRADE_POLICY_INVALID','必须明确数据目录和库实例',400);
 const root=await fs.realpath(dataDir),actual=(await fs.readFile(path.join(root,'mysql-source-id'),'utf8')).trim();
 if(actual!==instanceId)fail('VIDEO_V2_UPGRADE_INSTANCE_MISMATCH','指定目录的库实例不匹配，未写策略',409);
 const directory=path.join(root,'video-binding-v2');
 if(check){let current=null;try{await fs.lstat(directory);await privateDirectory(directory);current=await readPrivateJson(path.join(directory,'upgrade-policy.json'));}catch(e){if(e.code!=='ENOENT')throw e;}if(current)validateUpgradePolicy(current,instanceId);return {instanceId,policy:current};}
 const policy={format:'shiguang-video-v2-upgrade-policy',schemaVersion:1,instanceId,policyId:randomUUID(),mode,reason,createdAt:Date.now()};validateUpgradePolicy(policy,instanceId);
 await privateDirectory(directory);const file=path.join(directory,'upgrade-policy.json'),current=await readPrivateJson(file);if(current)validateUpgradePolicy(current,instanceId);
 if((current?.policyId??null)!==(expectedPolicyId??null))fail('VIDEO_V2_UPGRADE_POLICY_CHANGED','策略已变化，须明确原策略编号',409);
 const audit={...policy,previousPolicyId:current?.policyId??null};await writePrivateJson(path.join(directory,'policy-audit-'+policy.policyId+'.json'),audit);await writePrivateJson(file,policy);return {instanceId,policy};
}
