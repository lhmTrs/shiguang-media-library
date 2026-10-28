import { identity, namespace, id, body, fingerprint, fail, clone, integer } from './cloud-upload-protocol.mjs';
export class CloudUploadCommands {
    constructor(store) { this.store = store; }
    replay(who, input) { const old = this.store.get('cloud_upload_commands', { ...namespace(who), clientCommandId: id(input.clientCommandId) }); if (!old)
        return null; if (old.payloadFingerprint !== fingerprint(input))
        fail('IDEMPOTENCY_CONFLICT'); return clone(old.result); }
    execute(who, input, fn) { identity(who); id(input.clientCommandId); integer(input.expectedVersion ?? 0); body(input); const key = { ...namespace(who), clientCommandId: input.clientCommandId }, payloadFingerprint = fingerprint(input); return this.store.transaction(() => { const old = this.store.get('cloud_upload_commands', key); if (old) {
        if (old.payloadFingerprint !== payloadFingerprint)
            fail('IDEMPOTENCY_CONFLICT');
        return clone(old.result);
    } const result = body(fn()); this.store.hook('before-command-receipt'); this.store.insert('cloud_upload_commands', { ...key, targetKind: input.targetKind, targetId: input.targetId, action: input.action, payloadFingerprint, expectedVersion: input.expectedVersion ?? 0, result, resultVersion: result.version ?? 0 }); return result; }); }
}
