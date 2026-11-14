import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isRecord } from '../project-attributes/model.mjs';
import { imageDigest } from './image-import.mjs';
import { canonical, digest, fault, idOK, normalize } from './model.mjs';

const MEDIA_TTL = 15 * 60 * 1000;
const PREVIEW_TTL = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 1_100_000;
const invalid = message => fault(message, 422);
const readOnly = () => fault('只能从本集向未归档的全剧共享资产追加资料', 403, { code: 'ASSET_SCOPE_READ_ONLY' });
const impactChanged = (message = '追加影响已变化，请重新预览') => fault(message, 409, { code: 'ASSET_IMPACT_CHANGED' });
const mediaChanged = () => impactChanged('图片已变化或回执已过期，请重新验图并预览');
const active = child => child.archived_at === null;
const sameFile = (a, b) => a.isFile() && b.isFile() &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const ownFields = (input, required, optional = []) => isRecord(input) &&
  required.every(key => Object.hasOwn(input, key)) &&
  Object.keys(input).every(key => required.includes(key) || optional.includes(key));

function appendItem(item) {
  if (item?.type === 'look' && ownFields(item, ['type', 'name'], ['description'])) {
    const description = Object.hasOwn(item, 'description') ? item.description : '';
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || item.name.includes('\0') ||
        typeof description !== 'string' || description.length > 100000 || description.includes('\0')) {
      throw invalid('造型名称或说明格式无效');
    }
    return { type: 'look', name: item.name.trim(), description };
  }
  if (item?.type === 'image' && ownFields(item, ['type', 'look_id', 'media_receipt_id'])) return item;
  throw invalid('请选择一项要追加的造型或图片');
}

export class ScopedAssetAppend {
  #key = randomBytes(32);

  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.now = now;
  }

  get db() { return this.store.db; }
  get reads() { return this.store.scoped; }
  get writes() { return this.store.scopedWrites; }

  #snapshot(read) {
    const db = this.db;
    if (db.kind === 'mysql') db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return db.transaction(read)();
  }

  #signature(kind, encoded) {
    return createHmac('sha256', this.#key).update('scoped-asset-append/v1/' + kind + '/' + encoded).digest();
  }

  #sign(kind, payload) {
    const encoded = Buffer.from(canonical(payload)).toString('base64url');
    return encoded + '.' + this.#signature(kind, encoded).toString('hex');
  }

  #open(kind, token) {
    const error = kind === 'media' ? mediaChanged : impactChanged;
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw error();
    const [encoded, signature] = token.split('.');
    if (!timingSafeEqual(this.#signature(kind, encoded), Buffer.from(signature, 'hex'))) throw error();
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.expires_at <= this.now()) throw error();
    return payload;
  }

  #target(scope, assetId) {
    this.store.characterMerges.assertCurrent(scope, assetId);
    const item = this.reads.detailInTransaction(scope, assetId);
    if (item.owner.type !== 'series' || item.asset.archived_at) throw readOnly();
    return item.asset;
  }

  #episode(type, id, token) {
    if (type !== 'episode') throw readOnly();
    const scope = this.reads.scope(type, id);
    this.reads.assertContextToken(scope, token);
    return scope;
  }

  #look(asset, lookId, onInvalid) {
    if (asset.kind === 'character') {
      const look = asset.looks.find(child => child.id === lookId && active(child));
      if (!look) throw onInvalid();
      return look;
    }
    if (lookId !== null) throw onInvalid();
    return null;
  }

  #targetIdentity(scope, assetId, lookId) {
    return { episode_id: scope.id, series_id: scope.series_id, asset_id: assetId,
      look_id: lookId, context_token: scope.context_token };
  }

  #checkTarget(payload, scope, assetId, lookId, onMismatch) {
    if (payload.episode_id !== scope.id || payload.asset_id !== assetId || payload.look_id !== lookId) throw onMismatch();
    this.reads.assertContextToken(scope, payload.context_token);
    if (payload.series_id !== scope.series_id) throw onMismatch();
  }

  // The upload handler calls this again at its existing guard points.
  uploadTarget(type, id, assetId, { context_token, look_id }) {
    const scope = this.#episode(type, id, context_token);
    const asset = this.#target(scope, assetId);
    const look = this.#look(asset, look_id, () => invalid('请选择已保存且未归档的造型'));
    return { scope, asset, look };
  }

  #mediaRow(mediaId, lock = false) {
    const suffix = lock ? this.store.lock() : '';
    return this.db.prepare(`SELECT a.id,a.root_id,a.path,a.name,a.kind,a.trashed,
      r.path root_path,r.online,r.retired FROM assets a LEFT JOIN roots r ON r.id=a.root_id
      WHERE a.id=?${suffix}`).get(mediaId);
  }

  async #inspectMedia(mediaId, expected) {
    const row = this.#mediaRow(mediaId);
    if (!row || row.kind !== 'photo') {
      throw expected ? mediaChanged() : invalid('请选择素材库里的图片');
    }
    if (Number(row.trashed) || !row.root_path || Number(row.retired) || Number(row.online) === 0) throw mediaChanged();
    let file, verified, stat;
    try {
      file = await this.store.lib.checked(row.path, row.root_id);
      stat = await lstat(file, { bigint: true });
      verified = await imageDigest(file);
      if (!sameFile(await lstat(file, { bigint: true }), stat)) throw mediaChanged();
    } catch (error) {
      if (error.status || error.code || error.message === '路径超出登记目录') throw mediaChanged();
      throw error;
    }
    if (!verified.stat.size || expected && verified.hash !== expected ||
        canonical(this.#mediaRow(mediaId)) !== canonical(row)) throw mediaChanged();
    return { row, file, stat, sha256: verified.hash };
  }

  #assertCurrentFile({ row, file, stat }) {
    let fd;
    try {
      if (realpathSync(row.root_path) !== row.root_path || realpathSync(row.path) !== file ||
          !sameFile(lstatSync(file, { bigint: true }), stat)) throw mediaChanged();
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!sameFile(fstatSync(fd, { bigint: true }), stat) || !sameFile(lstatSync(file, { bigint: true }), stat) ||
          realpathSync(row.path) !== file || realpathSync(row.root_path) !== row.root_path) throw mediaChanged();
    } catch {
      throw mediaChanged();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  async mediaReceipt(type, id, assetId, input) {
    if (!ownFields(input, ['context_token', 'look_id', 'media_asset_id']) || !idOK(input.media_asset_id)) {
      throw invalid('请选择要追加的素材库图片');
    }
    const target = this.#snapshot(() => this.uploadTarget(type, id, assetId, input));
    const proof = await this.#inspectMedia(input.media_asset_id);
    const payload = this.#snapshot(() => {
      const current = this.uploadTarget(type, id, assetId, input);
      if (target.look?.revision !== current.look?.revision ||
          canonical(this.#mediaRow(proof.row.id)) !== canonical(proof.row)) throw mediaChanged();
      this.#assertCurrentFile(proof);
      return { ...this.#targetIdentity(current.scope, current.asset.id, input.look_id),
        media_asset_id: proof.row.id, sha256: proof.sha256, expires_at: this.now() + MEDIA_TTL };
    });
    return {
      media_receipt_id: this.#sign('media', payload), media_asset_id: proof.row.id, file_name: proof.row.name,
      preview_url: '/api/project-assets/media/' + encodeURIComponent(proof.row.id) + '/preview',
      expires_at: payload.expires_at,
    };
  }

  #audience(seriesId) {
    const seasons = this.db.prepare(`SELECT id,season_no,label,revision FROM project_series_seasons
      WHERE series_id=? ORDER BY id`).all(seriesId);
    const episodes = this.db.prepare(`SELECT p.id,p.name,m.season_id,m.episode_no,m.revision
      FROM project_series_members m JOIN media_projects p ON p.id=m.id AND p.project_kind='normal'
      WHERE m.series_id=? ORDER BY p.id`).all(seriesId);
    return { seasons, episodes };
  }

  #plan(scope, asset, item, childId) {
    // Existing invariants make a missing default equivalent to having no
    // active candidates for that field, so every season/episode inherits it.
    // Validate the existing DTO rather than silently repairing old data.
    normalize(asset);
    let key, look = null, before;
    if (item.type === 'look') {
      if (asset.kind !== 'character') throw invalid('只有人物可以追加造型');
      if (asset.looks.length >= 200) throw invalid('造型数量已达上限');
      key = 'default_look';
      before = asset.default_look_id;
    } else {
      if (asset.images.length >= 1000) throw invalid('图片数量已达上限');
      look = this.#look(asset, item.look_id, mediaChanged);
      key = 'default_image';
      before = look ? look.default_image_id : asset.default_image_id;
    }
    const setsSeriesDefault = before === null;
    const fields = setsSeriesDefault ? [{ key, ...(key === 'default_image' && { look_id: look?.id ?? null }), before, after: childId }] : [];
    const audience = this.#audience(scope.series_id);
    const impact = {
      seasons: audience.seasons.map(row => ({ id: row.id, name: row.label?.trim() || `第 ${row.season_no} 季`, fields })),
      episodes: audience.episodes.map(row => ({ id: row.id, name: row.name, fields })),
      explicit_shots: [],
      blockers: [],
    };
    return {
      setsSeriesDefault, impact,
      fingerprint: digest({ audience, fields, before, asset_revision: asset.revision, look_revision: look?.revision ?? null }),
    };
  }

  async preview(type, id, assetId, input) {
    if (!ownFields(input, ['context_token', 'item'])) throw invalid('追加预览请求格式无效');
    const item = appendItem(input.item), childId = randomUUID();
    const initial = this.#snapshot(() => {
      const scope = this.#episode(type, id, input.context_token);
      const asset = this.#target(scope, assetId);
      if (item.type === 'look') return { result: this.#previewResult(scope, asset, item, childId) };
      const media = this.#open('media', item.media_receipt_id);
      this.#checkTarget(media, scope, asset.id, item.look_id, mediaChanged);
      this.#look(asset, item.look_id, mediaChanged);
      return { media };
    });
    if (initial.result) return initial.result;
    const { media } = initial;
    const proof = await this.#inspectMedia(media.media_asset_id, media.sha256);
    return this.#snapshot(() => {
      const scope = this.#episode(type, id, input.context_token);
      this.#checkTarget(media, scope, assetId, item.look_id, mediaChanged);
      if (media.expires_at <= this.now() || canonical(this.#mediaRow(media.media_asset_id)) !== canonical(proof.row)) throw mediaChanged();
      this.#assertCurrentFile(proof);
      return this.#previewResult(scope, this.#target(scope, assetId), {
        type: 'image', look_id: media.look_id, media_asset_id: media.media_asset_id, sha256: media.sha256,
      }, childId, media.expires_at);
    });
  }

  #previewResult(scope, asset, item, childId, mediaExpires = Infinity) {
    const plan = this.#plan(scope, asset, item, childId);
    const preview_token = this.#sign('preview', {
      ...this.#targetIdentity(scope, asset.id, item.look_id ?? null), item, child_id: childId,
      fingerprint: plan.fingerprint, expires_at: Math.min(this.now() + PREVIEW_TTL, mediaExpires),
    });
    return { preview_token, sets_series_default: plan.setsSeriesDefault, impact: plan.impact };
  }

  async commit(type, id, assetId, input) {
    if (type !== 'episode') throw readOnly();
    if (!ownFields(input, ['request_id', 'context_token', 'preview_token'], ['allow_series_default']) ||
        !idOK(input.request_id) ||
        Object.hasOwn(input, 'allow_series_default') && typeof input.allow_series_default !== 'boolean') {
      throw invalid('追加确认请求格式无效');
    }
    const operation = 'append:' + assetId;
    const priorResult = () => this.#snapshot(() => {
      const { prior } = this.writes.receipt(type, id, operation, input);
      return prior ? this.writes.visibleReceipt(this.reads.scope(type, id), prior) : null;
    });
    const prior = priorResult();
    if (prior) return prior;

    const preview = this.#snapshot(() => {
      const scope = this.#episode(type, id, input.context_token);
      const payload = this.#open('preview', input.preview_token);
      this.#checkTarget(payload, scope, assetId, payload.item.look_id ?? null, impactChanged);
      this.#target(scope, assetId);
      return payload;
    });
    let proof = null;
    if (preview.item.type === 'image') {
      try { proof = await this.#inspectMedia(preview.item.media_asset_id, preview.item.sha256); }
      catch (error) {
        // The same request may have committed while this one was checking the
        // file. A committed receipt remains replayable if the file later changes.
        const committed = priorResult();
        if (committed) return committed;
        throw error;
      }
    }
    return this.writes.mutation(type, id, operation, input, scope => {
      const payload = this.#open('preview', input.preview_token);
      this.#checkTarget(payload, scope, assetId, payload.item.look_id ?? null, impactChanged);
      this.writes.lockProjects(this.reads.scope('series', scope.series_id));
      const asset = this.#target(scope, assetId);
      const locked = this.store.head(asset.id, true);
      if (locked.revision !== asset.revision || locked.owner_type !== 'series' ||
          locked.owner_id !== scope.series_id || locked.archived_at) throw impactChanged();
      if (proof && canonical(this.#mediaRow(proof.row.id, true)) !== canonical(proof.row)) throw mediaChanged();
      const plan = this.#plan(scope, asset, payload.item, payload.child_id);
      if (plan.fingerprint !== payload.fingerprint || payload.expires_at <= this.now()) throw impactChanged();
      if (plan.setsSeriesDefault && input.allow_series_default !== true) {
        throw fault('请确认追加项将成为全剧默认', 422, { code: 'ASSET_DEFAULT_CONFIRMATION_REQUIRED' });
      }
      if (proof) this.#assertCurrentFile(proof);
      this.#append(scope, asset, payload, proof, plan);
      const detail = this.reads.detailInTransaction(scope, assetId);
      if (proof) this.#assertCurrentFile(proof);
      return { ...detail, appended: { type: payload.item.type, id: payload.child_id },
        sets_series_default: plan.setsSeriesDefault, impact: plan.impact };
    }, { beforeCommit: () => { if (proof) this.#assertCurrentFile(proof); } });
  }

  #append(scope, asset, { item, child_id: id }, proof, plan) {
    const now = Math.max(this.now(), Number(asset.updated_at) + 1), revision = Number(asset.revision) + 1;
    const source = canonical({ type: 'episode_append', episode_id: scope.id, episode_name: scope.project.name, appended_at: now });
    let defaultLook = asset.default_look_id, defaultImage = asset.default_image_id;
    if (item.type === 'look') {
      const order = asset.looks.length ? Number(asset.looks.at(-1).sort_order) + 1 : 0;
      const data = canonical({ name: item.name, description: item.description, tags: [] });
      this.db.prepare(`INSERT INTO creative_looks (id,asset_id,data_json,default_image_id,sort_order,revision,archived_at,source_json,created_at,updated_at)
        VALUES(?,?,?,NULL,?,1,NULL,?,?,?)`).run(id, asset.id, data, order, source, now, now);
      if (plan.setsSeriesDefault) defaultLook = id;
    } else {
      const order = asset.images.length ? Number(asset.images.at(-1).sort_order) + 1 : 0;
      const binding = {
        reference_type: '', purpose: '', locks: '', ignores: '', confirmed: false,
        crop: { x: 50, y: 50, zoom: 1 }, last_known_name: proof.row.name,
      };
      if (asset.kind === 'character') Object.assign(binding, {
        crop_source: 'untouched', crop_manually_edited: false,
        was_card_default: plan.setsSeriesDefault && item.look_id === defaultLook,
      });
      this.db.prepare(`INSERT INTO creative_image_bindings
        (id,asset_id,look_id,media_asset_id,expected_sha256,data_json,sort_order,revision,archived_at,source_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,NULL,?,?,?)`).run(id, asset.id, item.look_id, proof.row.id, proof.sha256,
        canonical(this.store.imageData(binding)), order, source, now, now);
      if (plan.setsSeriesDefault) {
        if (item.look_id === null) defaultImage = id;
        else this.db.prepare('UPDATE creative_looks SET default_image_id=?,revision=revision+1,updated_at=? WHERE id=? AND asset_id=?')
          .run(id, now, item.look_id, asset.id);
      }
    }
    this.db.prepare('UPDATE creative_assets SET default_look_id=?,default_image_id=?,revision=?,updated_at=? WHERE id=?')
      .run(defaultLook, defaultImage, revision, now, asset.id);
    const summary = item.type === 'look' ? '本集追加造型' : '本集追加图片';
    this.db.prepare(`INSERT INTO creative_asset_versions (id,asset_id,version,snapshot,summary,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), asset.id, revision, canonical(this.store.get(asset.id)), summary, now, now);
  }
}
