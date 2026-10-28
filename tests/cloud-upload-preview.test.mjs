import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFixture, rows } from './cloud-upload-batch-mysql-fixture.mjs';
import { uuid, groupFingerprint } from '../server/cloud-upload-protocol.mjs';
const create = f => f.preview.create(f.who, f.input());
function select(f, p, changes = [], representatives = []) { return f.preview.selection(f.who, p.previewId, { clientCommandId: uuid(), expectedVersion: p.version, changes, representatives }); }
function confirm(f, p, sha, rep) { const g = f.preview.group(f.who, p.previewId, sha, rep); return select(f, p, [], [{ sha256: sha, representativeAssetId: rep, expectedGroupVersion: g.groupVersion, confirmedFingerprint: g.fingerprint }]); }
test('120 stable ordinals survive uploaded exclusions; empty pages still advance', async (t) => {
    const f = await sqliteFixture(t, rows(120)), p = await create(f), frozen = f.preview.rows(p.previewId);
    const first = f.preview.page(f.who, p.previewId, { limit: 50 });
    assert.equal(first.items.length, 50);
    for (const r of frozen.slice(0, 60))
        f.preview.cacheEligibility(f.who, r.sha256, r.sourceVersion, { classification: 'UPLOADED', serverStateVersion: 1, admissionEpoch: 0 });
    let page = f.preview.page(f.who, p.previewId, { limit: 100, scanBudget: 50 });
    assert.equal(page.items.length, 0);
    assert.equal(page.scanComplete, false);
    assert.equal(page.lastScannedOrdinal, 49);
    assert.ok(page.nextCursor);
    const collected = [];
    while (page.nextCursor) {
        page = f.preview.page(f.who, p.previewId, { cursor: page.nextCursor, limit: 20, scanBudget: 30 });
        collected.push(...page.items.map(r => r.ordinal));
    }
    assert.deepEqual(collected, Array.from({ length: 60 }, (_, i) => i + 60));
    const continued = f.preview.page(f.who, p.previewId, { cursor: first.nextCursor });
    assert.deepEqual(continued.items.map(r => r.ordinal), Array.from({ length: 60 }, (_, i) => i + 60));
});
test('cursor rejects malformed, foreign preview/filter and obsolete version', async (t) => {
    const f = await sqliteFixture(t, rows(120)), p = await create(f), page = f.preview.page(f.who, p.previewId, { limit: 1 }), other = await create(f);
    for (const token of ['garbage', page.nextCursor + 'x'])
        assert.throws(() => f.preview.page(f.who, p.previewId, { cursor: token }), { code: 'PREVIEW_STALE' });
    assert.throws(() => f.preview.page(f.who, other.previewId, { cursor: page.nextCursor }), { code: 'PREVIEW_STALE' });
    assert.throws(() => f.preview.page(f.who, p.previewId, { cursor: page.nextCursor, filter: 'all' }), { code: 'PREVIEW_STALE' });
    select(f, p, [{ assetId: f.preview.rows(p.previewId)[119].assetId, included: false }]);
    assert.throws(() => f.preview.page(f.who, p.previewId, { cursor: page.nextCursor }), { code: 'PREVIEW_STALE' });
});
test('scope overlap deduplicates stable asset identity and refuses contradictory copies', async (t) => {
    const source = rows(2), f = await sqliteFixture(t, [...source, source[0]]), p = await create(f);
    assert.equal(p.totalFrozen, 2);
    f.sourceRows = [source[0], { ...source[0], fileName: 'changed.wav' }];
    await assert.rejects(create(f), { code: 'SOURCE_CHANGED' });
});
test('two conflict groups on different pages confirm independently; unrelated changes preserve A', async (t) => {
    const source = rows(120);
    source[0].sha256 = source[100].sha256 = 'a'.repeat(64);
    source[0].fileName = 'A.wav';
    source[100].fileName = 'A2.wav';
    source[1].sha256 = source[101].sha256 = 'b'.repeat(64);
    source[1].fileName = 'B.wav';
    source[101].fileName = 'B2.wav';
    const f = await sqliteFixture(t, source);
    let p = await create(f);
    assert.equal(f.preview.group(f.who, p.previewId, source[0].sha256).confirmationVersion, null);
    p = confirm(f, p, source[0].sha256, source[0].assetId);
    const A = f.preview.group(f.who, p.previewId, source[0].sha256);
    p = confirm(f, p, source[1].sha256, source[101].assetId);
    assert.deepEqual(f.preview.group(f.who, p.previewId, source[0].sha256), A);
    const B = f.preview.group(f.who, p.previewId, source[1].sha256);
    p = select(f, p, [{ assetId: source[3].assetId, included: false }]);
    assert.deepEqual(f.preview.group(f.who, p.previewId, source[0].sha256), A);
    p = f.preview.revise(f.who, p.previewId, p.version, source[0].assetId, { fileName: 'changed.wav' });
    assert.equal(f.preview.group(f.who, p.previewId, source[0].sha256).confirmationVersion, null);
    assert.deepEqual(f.preview.group(f.who, p.previewId, source[1].sha256), B);
    const b = f.batches.create(f.who, { clientCommandId: uuid(), previewId: p.previewId, expectedPreviewVersion: p.version, manifestFingerprint: p.manifestFingerprint, startPaused: false, representativeConfirmations: [] });
    const items = f.batches.rows(b.batchId);
    assert.equal(items.find(r => r.sha256 === source[0].sha256).state, 'NEEDS_CONFIRMATION');
    assert.equal(items.find(r => r.sha256 === source[1].sha256).state, 'QUEUED');
});
test('only affected group invalidates for member/source/type/name/category/target and representative changes', async (t) => {
    for (const patch of [{ sourceVersion: { ...rows(1)[0].sourceVersion, mtimeMs: 101 } }, { mediaKind: 'SFX' }, { fileName: 'other.wav' }, { category: 'C' }, { subcategory: 'C' }, { target: { visibility: 'GROUP', groupId: uuid() } }]) {
        const source = rows(3), f = await sqliteFixture(t, source);
        let p = await create(f);
        const unaffected = f.preview.group(f.who, p.previewId, source[1].sha256);
        p = f.preview.revise(f.who, p.previewId, p.version, source[0].assetId, patch);
        assert.equal(f.preview.group(f.who, p.previewId, source[0].sha256).confirmationVersion, null);
        assert.deepEqual(f.preview.group(f.who, p.previewId, source[1].sha256), unaffected);
    }
    const source = rows(3, { sameSha: true }), f = await sqliteFixture(t, source);
    let p = await create(f);
    const initial = f.preview.group(f.who, p.previewId, source[0].sha256);
    p = select(f, p, [{ assetId: source[2].assetId, included: false }]);
    assert.equal(f.preview.group(f.who, p.previewId, source[0].sha256).confirmationVersion, null);
    p = confirm(f, p, source[0].sha256, source[1].assetId);
    const g = f.preview.group(f.who, p.previewId, source[0].sha256);
    assert.ok(g.groupVersion > initial.groupVersion);
    assert.equal(g.confirmationVersion, g.groupVersion);
    assert.equal(g.representativeAssetId, source[1].assetId);
});
test('ordinary files auto-prove; start uses persisted proofs with empty refs, rejects forged refs and duplicates', async (t) => {
    const f = await sqliteFixture(t, rows(60)), p = await create(f);
    for (const r of f.preview.rows(p.previewId)) {
        assert.equal(r.groupVersion, r.confirmationVersion);
        assert.equal(r.representativeFingerprint, groupFingerprint(p.previewId, r.sha256, [r], r.assetId));
    }
    const input = { clientCommandId: uuid(), previewId: p.previewId, expectedPreviewVersion: p.version, manifestFingerprint: p.manifestFingerprint, startPaused: false, representativeConfirmations: [] };
    assert.equal(f.batches.create(f.who, input).totalItems, 60);
    const r = f.preview.rows(p.previewId)[0];
    assert.throws(() => f.batches.create(f.who, { ...input, clientCommandId: uuid(), representativeConfirmations: [{ sha256: r.sha256, groupVersion: 0, fingerprint: '0'.repeat(64) }] }), { code: 'REPRESENTATIVE_STALE' });
    assert.throws(() => select(f, p, [{ assetId: r.assetId, included: false }, { assetId: r.assetId, included: true }]), { code: 'INVALID_REQUEST' });
});
test('UNKNOWN is not NEW; eligibility cache expires and never leaks across account', async (t) => {
    const f = await sqliteFixture(t, rows(1)), p = await create(f), r = f.preview.rows(p.previewId)[0];
    assert.equal(f.preview.page(f.who, p.previewId).items[0].selectable, false);
    f.preview.cacheEligibility(f.who, r.sha256, r.sourceVersion, { classification: 'NEW', serverStateVersion: 1, admissionEpoch: 0 });
    assert.equal(f.preview.page(f.who, p.previewId).items[0].selectable, true);
    f.clock = 32000;
    assert.equal(f.preview.page(f.who, p.previewId).items[0].classification, 'UNKNOWN');
    f.clock = 999;
    assert.equal(f.preview.page(f.who, p.previewId).items[0].classification, 'UNKNOWN');
    const old = f.who;
    f.who = { ...old, accountId: uuid(), epoch: 2 };
    assert.throws(() => f.preview.page(f.who, p.previewId), { code: 'NOT_FOUND' });
    assert.throws(() => f.preview.page(old, p.previewId), { code: 'AUTH_CHANGED' });
});
test('representative confirmation command replay does not advance versions and forged confirmation rolls back', async (t) => {
    const source = rows(2, { sameSha: true, conflict: true }), f = await sqliteFixture(t, source), p = await create(f), g = f.preview.group(f.who, p.previewId, source[0].sha256, source[1].assetId), input = { clientCommandId: uuid(), expectedVersion: p.version, changes: [], representatives: [{ sha256: source[0].sha256, representativeAssetId: source[1].assetId, expectedGroupVersion: g.groupVersion, confirmedFingerprint: g.fingerprint }] };
    const result = f.preview.selection(f.who, p.previewId, input);
    assert.deepEqual(f.preview.selection(f.who, p.previewId, input), result);
    f.reopen();
    assert.deepEqual(f.preview.selection(f.who, p.previewId, input), result);
    assert.equal(f.preview.group(f.who, p.previewId, source[0].sha256).groupVersion, 1);
    assert.throws(() => f.preview.selection(f.who, p.previewId, { ...input, clientCommandId: uuid(), expectedVersion: result.version, representatives: [{ ...input.representatives[0], expectedGroupVersion: 1, confirmedFingerprint: '0'.repeat(64) }] }), { code: 'REPRESENTATIVE_STALE' });
    assert.equal(f.preview.owned(f.who, p.previewId).version, result.version);
});
test('category/path override cannot bypass safe metadata validation', async (t) => {
    const f = await sqliteFixture(t, rows(1));
    for (const categoryOverride of [{ category: '../private', subcategory: '' }, { category: '', subcategory: 'bad' }])
        await assert.rejects(f.preview.create(f.who, { ...f.input(), categoryOverride }), { code: 'INVALID_REQUEST' });
});
