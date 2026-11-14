import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { MysqlDatabase } from '../../server/mysql-db.mjs';
import { Projects } from '../../server/projects.mjs';
import { ProjectAssets } from '../../server/project-assets/store.mjs';

function confirm(service, seriesId, input) {
  try { return { result:service.confirm(seriesId, input) }; }
  catch (error) { return { status:error.status, code:error.code, message:error.message, details:error.details }; }
}

function payload(service, seriesId, primaryId) {
  const groups = service.groups(seriesId);
  const view = service.preview(seriesId, { group_id:groups.items[0].group_id,
    primary_asset_id:primaryId, context_token:groups.context_token });
  assert.equal(view.ready, true);
  return { request_id:randomUUID(), context_token:groups.context_token, preview_token:view.preview_token, choices:view.choices };
}

if (!isMainThread) {
  const { mysql, filename, dataDir, seriesId, primaryId } = workerData;
  const db = mysql ? new MysqlDatabase(mysql) : new Database(filename);
  const lib = { db, dataDir };
  const projects = new Projects(lib).init();
  const service = new ProjectAssets(lib).init().characterMerges;
  parentPort.postMessage(payload(service, seriesId, primaryId));
  parentPort.on('message', ({ input, signals }) => {
    if (!input) {
      db.close();
      parentPort.close();
      return;
    }
    const transaction = projects.series.transaction.bind(projects.series);
    if (signals) projects.series.transaction = action => {
      Atomics.store(signals, 0, 1);
      Atomics.notify(signals, 0);
      return transaction(action);
    };
    const response = confirm(service, seriesId, input);
    projects.series.transaction = transaction;
    if (signals) {
      Atomics.store(signals, 1, 1);
      Atomics.notify(signals, 1);
    }
    parentPort.postMessage(response);
  });
}

export async function assertCharacterMergeRequestRace(store, options, rejectFirst) {
  const directory = store.lib.projectSeries, service = store.characterMerges;
  const series = directory.createSeries({ request_id:randomUUID(), name:'并发回执 ' + randomUUID() });
  const episode = n => directory.createEpisode(series.id, {
    request_id:randomUUID(), season_id:null, expected_episode_no:n,
  }).project;
  const first = await store.create({ project_id:episode(1).id, kind:'character', name:'合成并发人物' });
  const second = await store.create({ project_id:episode(2).id, kind:'character', name:first.name });
  const worker = new Worker(new URL(import.meta.url), {
    workerData:{ ...options, dataDir:store.lib.dataDir, seriesId:series.id, primaryId:first.id },
  });
  const exited = once(worker, 'exit');
  void exited.catch(() => {});
  try {
    const [otherInput] = await once(worker, 'message');
    // In the rejection race the contender's preview is still valid on its
    // connection, while its scope token is stale on the first connection.
    const input = rejectFirst ? otherInput : payload(service, series.id, first.id);
    const signals = new Int32Array(new SharedArrayBuffer(8));
    const waiting = once(worker, 'message');
    void waiting.catch(() => {});
    const original = store.generationLocks;
    let launched = false;
    store.generationLocks = { assertWritable() {
      if (launched) return;
      launched = true;
      worker.postMessage({ input, signals });
      Atomics.wait(signals, 0, 0, 5000);
      assert.equal(Atomics.load(signals, 0), 1, 'second connection entered transaction acquisition');
      assert.equal(Atomics.wait(signals, 1, 0, 100), 'timed-out', 'second connection waits for the directory lock');
    } };
    let firstResponse;
    try { firstResponse = confirm(service, series.id, input); }
    finally { store.generationLocks = original; }
    const [secondResponse] = await waiting;
    assert.deepEqual(secondResponse, firstResponse);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM creative_character_merge_requests WHERE id=?').get(input.request_id).n, 1);
    if (rejectFirst) {
      assert.equal(firstResponse.code, 'CHARACTER_MERGE_STALE');
      assert.equal(firstResponse.details.request_settled, true);
      assert.equal(store.get(second.id).archived_at, 0);
      assert.equal(service.request(series.id, input.request_id).result.status, 'rejected');
      const retry = once(worker, 'message');
      worker.postMessage({ input:{ ...input, request_id:randomUUID() } });
      assert.equal((await retry)[0].result.status, 'merged', 'contender could have written without the rejected receipt');
    } else {
      assert.equal(firstResponse.result.status, 'merged');
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM creative_character_merges WHERE series_id=?').get(series.id).n, 1);
    }
    worker.postMessage({});
    assert.deepEqual(await exited, [0]);
  } finally {
    if (worker.threadId !== -1) await worker.terminate();
  }
}
