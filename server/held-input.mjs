import {Readable} from 'node:stream';
// Ownership stays with the caller: destroying this pipe must not close the
// pinned FileHandle before its mandatory post-read identity verification.
export function heldInput(handle) {
 return Readable.from((async function*(){let position=0;for(;;){const bytes=Buffer.alloc(65536);const {bytesRead}=await handle.read(bytes,0,bytes.length,position);if(!bytesRead)return;position+=bytesRead;yield bytes.subarray(0,bytesRead);}})());
}
