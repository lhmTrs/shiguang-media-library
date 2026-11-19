// 本测试文件自己的临时目录：由这里 mkdtemp 创建并记下目录身份；用例通过才删，失败、取消或无法核验时保留作证据。
// 设 SHIGUANG_KEEP_TEST_TMP=1 可全部保留。不扫描、不接受外部传入的路径，只处理自己创建的 os.tmpdir() 直接子目录。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function tempDirectories(test, prefix) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*-$/.test(prefix)) throw Error('临时目录前缀无效');
  const dirs = [], results = new Map();
  let parent;
  const root = async () => parent ??= await fs.realpath(os.tmpdir());
  test.afterEach(t => results.set(t.name, t.passed));
  test.after(async () => {
    const keepAll = process.env.SHIGUANG_KEEP_TEST_TMP === '1', kept = [];
    for (const dir of dirs) {
      if (keepAll || results.get(dir.name) !== true) {kept.push({path: dir.path, reason: keepAll ? 'keep-all' : 'not-passed'}); continue;}
      const left = await removeOwned(dir);
      if (left) kept.push(left);
    }
    console.log(JSON.stringify({tempDirectories: prefix, created: dirs.length, removed: dirs.length - kept.length, kept}));
  });
  // 先改名到只有本进程知道的名字，再核对身份。改名之后无论核对失配还是删除失败，都留在隔离名下并报告真实位置，
  // 不改回原名：原路径此时可能已被别的进程占用，改回去会覆盖它。返回 null 表示已删除，否则返回保留位置和原因。
  async function removeOwned(dir) {
    const moving = path.join(dir.parent, '.' + path.basename(dir.path) + '.removing-' + crypto.randomUUID());
    try {
      const now = await fs.lstat(dir.path);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== dir.dev || now.ino !== dir.ino) return {path: dir.path, reason: 'identity-changed'};
      await fs.rename(dir.path, moving);
    } catch (e) { return {path: dir.path, reason: 'not-moved:' + (e.code || e.message)}; }
    try {
      const moved = await fs.lstat(moving);
      if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== dir.dev || moved.ino !== dir.ino || await fs.realpath(path.dirname(moving)) !== dir.parent) return {path: moving, reason: 'identity-changed-after-move'};
      await fs.rm(moving, {recursive: true, force: true});
      return null;
    } catch (e) { return {path: moving, reason: 'remove-failed:' + (e.code || e.message)}; }
  }
  /** 为用例 t 新建一个临时目录，返回真实路径。 */
  return async t => {
    const base = await root(), made = await fs.realpath(await fs.mkdtemp(path.join(base, prefix)));
    const stat = await fs.lstat(made);
    if (path.dirname(made) !== base || !path.basename(made).startsWith(prefix) || !stat.isDirectory() || stat.isSymbolicLink()) throw Error('临时目录位置无法核验：' + made);
    dirs.push({name: t.name, path: made, parent: base, dev: stat.dev, ino: stat.ino});
    return made;
  };
}
