// Owned helper exits naturally after publishing a lock, emulating a stale owner.
import {privateDirectory,acquireUpgradeFileLock} from '../../../server/storyboard-video-v2/upgrade-files.mjs';
const [directory,instanceId]=process.argv.slice(2);await privateDirectory(directory);
if(!await acquireUpgradeFileLock(directory,instanceId))throw Error('owned helper lock unexpectedly busy');
console.log('OWNED_LOCK_PUBLISHED');
