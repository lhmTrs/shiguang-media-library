import {upgradePolicy} from '../server/storyboard-video-v2/upgrade-policy.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){const key=args[i];if(key==='--check'){options.check=true;continue;}if(!['--data-dir','--instance-id','--mode','--reason','--expected-policy-id'].includes(key)||!args[i+1])throw Error('Explicit data directory, instance, mode and reason required');options[key]=args[++i];}
try{const result=await upgradePolicy({dataDir:options['--data-dir'],instanceId:options['--instance-id'],mode:options['--mode'],reason:options['--reason'],expectedPolicyId:options['--expected-policy-id'],check:options.check});console.log(JSON.stringify(result));}
catch(error){console.error(JSON.stringify({code:error.code??'VIDEO_V2_UPGRADE_POLICY_FAILED',message:error.status?error.message:'策略未能核验，未开始迁移'}));process.exitCode=1;}
