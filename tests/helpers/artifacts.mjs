// 测试产物约定：干净 checkout 构建后即可运行，不需要预置 collab/results 下的历史目录。
// - 构建产物默认用当前 checkout 的 dist；缺 index.html 时直接说明先构建。
// - 证据默认写到本次新建的临时目录：进程以 0 退出时删除，失败时保留并打印位置。
// - 显式传入的 *_DIST / *_EVIDENCE 覆盖照旧可用，覆盖的证据目录不会被删除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function builtDist(root, override) {
  const dist = path.resolve(override || path.join(root, 'dist'));
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error(`找不到构建产物 ${path.join(dist, 'index.html')}：请先运行 npm run build，或用对应的 *_DIST 环境变量指定`);
  return dist;
}

export function evidenceDir(name, override) {
  if (override) { const dir = path.resolve(override); fs.mkdirSync(dir, { recursive: true }); return dir; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-evidence-`));
  process.on('exit', code => {
    if (code === 0 && !process.exitCode) fs.rmSync(dir, { recursive: true, force: true });
    else console.error(`测试证据保留在：${dir}`);
  });
  return dir;
}
