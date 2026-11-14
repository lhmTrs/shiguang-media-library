import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Projects } from '../../server/projects.mjs';
import { ProjectAssets } from '../../server/project-assets/store.mjs';
export async function creativeFixture({ onDisk = false } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creative-unit-'))), db = new Database(onDisk ? path.join(dir, 'synthetic.sqlite') : ':memory:');
  db.exec('CREATE TABLE roots(id TEXT PRIMARY KEY,path TEXT,retired INTEGER,online INTEGER); CREATE TABLE assets(id TEXT PRIMARY KEY,root_id TEXT,path TEXT,name TEXT,kind TEXT,trashed INTEGER)');
  const root = randomUUID(), media = randomUUID(), image = path.join(dir, 'synthetic.png');
  await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64'));
  db.prepare('INSERT INTO roots VALUES(?,?,0,1)').run(root, dir); db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,0)').run(media, root, image, '合成图片', 'photo');
  const lib = { db, dataDir: dir, asset: id => { const a = db.prepare('SELECT * FROM assets WHERE id=?').get(id); if (!a) throw Error('素材不存在'); return a; }, checked: async (p, id) => { const r = db.prepare('SELECT * FROM roots WHERE id=?').get(id), real = await fs.realpath(p); if (!r || path.relative(r.path, real).startsWith('..')) throw Error('路径越界'); return real; } };
  const projects = new Projects(lib).init(), store = new ProjectAssets(lib).init();
  const a = projects.save(null, { name: '合成项目甲' }), b = projects.save(null, { name: '合成项目乙' });
  return { lib, db, projects, store, a, b, media, root, dir, image, close: async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
export function addLook(a, name = '日常造型') { const l = { id: randomUUID(), name, tags: ['日常'], description: '', default_image_id: null, archived_at: null }; a.looks.push(l); a.default_look_id ??= l.id; return l; }
export function addImage(a, media, look = a.default_look_id) { const b = { id: randomUUID(), look_id: a.kind === 'character' ? look : null, media_asset_id: media, reference_type: '身份', purpose: '合成参考', locks: '脸部', ignores: '背景', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 } }; a.images.push(b); if (a.kind === 'character') a.looks.find(l => l.id === look).default_image_id ??= b.id; else a.default_image_id ??= b.id; return b; }

// Build a confirmed directory request the same way a client does.
export function confirmAttributePlan(series, method, input) {
  const preview = method === 'move' ? series.previewMove(input) : series.previewOrganize(input);
  const plan = preview.attribute_plan;
  return plan?.preview_token ? {
    ...input, attribute_preview_token: plan.preview_token, attribute_choices: plan.choices,
  } : input;
}

export function moveWithAttributePlan(series, input) {
  return series.move(confirmAttributePlan(series, 'move', input));
}
