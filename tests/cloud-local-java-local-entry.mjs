// Fixture-only bootstrap: never launch against a configured or existing data directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../server/library.mjs';
const root=await fs.realpath(process.env.E2E_PRIVATE_ROOT);
const data=await fs.realpath(process.env.MEDIA_DATA_DIR);
assert(data.startsWith(root+path.sep));
for(const [key,value] of Object.entries({MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',MEDIA_CLOUD_AUDIO_ENABLED:'1',NODE_ENV:'production'})) assert.equal(process.env[key],value);
assert.notEqual(process.env.SHIGUANG_AUDIO_ANALYSIS,'1');
await assert.rejects(fs.stat(path.join(data,'mysql-connection.json')),{code:'ENOENT'});
// Disable metadata/probe/background tool enqueue only. Real scan, SQLite indexing,
// CloudAuth, HTTP routes, uploader, Receiver and no-replace Installer stay unchanged.
Library.prototype.enqueue=function(){ };
await import('../server/index.mjs');
