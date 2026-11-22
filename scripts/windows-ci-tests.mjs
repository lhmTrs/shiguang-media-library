// Explicit portable subset; never expand to all tests or bypass known restrictions.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {CI_FILES} from './ci-stable-tests.mjs';
const included=['font-scale.test.mjs','global-feedback.test.mjs','project-usage-pending.test.mjs','read-cache.test.mjs','search-aliases.test.mjs','storyboard-model.test.mjs','tag-facet-cache.test.mjs','tag-usage.test.mjs'];
const excluded=CI_FILES.filter(f=>!included.includes(f)).map(file=>({file,reason:'依赖POSIX句柄、可执行探测脚本或目录刷盘/权限契约；阶段1后另行验证，不冒充可移植通过'}));
const output=path.resolve(process.argv[2]||'reports/windows-probe');await fs.mkdir(output,{recursive:true});
const report={platform:process.platform,node:process.version,included,excluded,results:[],fullNpmTest:false};
try{for(const file of included){if(!CI_FILES.includes(file)||/^(cloud-|device-enrollment|asset-merge-routes|asset-repair-routes)/.test(file))throw Error('unsafe selection');const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-timeout=120000','tests/'+file],{stdio:['ignore','ignore','ignore'],windowsHide:true});const [code,signal]=await once(child,'exit');report.results.push({file,code,signal,passed:code===0&&signal===null});}}finally{await fs.writeFile(path.join(output,'tests.json'),JSON.stringify(report,null,2));await fs.appendFile(path.join(output,'摘要.md'),'\n## 可移植现有测试子集\n\n'+report.results.map(r=>'- '+r.file+'：'+(r.passed?'通过':'失败')).join('\n')+'\n\n明确排除：\n'+excluded.map(r=>'- '+r.file+'：'+r.reason).join('\n')+'\n');}
process.exitCode=report.results.length===included.length&&report.results.every(r=>r.passed)?0:1;
