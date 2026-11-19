// 只清理本测试文件自己用 mkdtemp 建的临时目录：用例通过就删，失败或取消时保留作证据。
// 设 SHIGUANG_KEEP_TEST_TMP=1 可全部保留。只删以 os.tmpdir()/<prefix> 开头的目录，不扫描、不碰别的路径。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function tempDirectories(test, prefix) {
  const dirs = [], results = new Map();
  test.afterEach(t => results.set(t.name, t.passed));
  test.after(async () => {
    const root = path.join(await fs.realpath(os.tmpdir()), prefix), keepAll = process.env.SHIGUANG_KEEP_TEST_TMP === '1';
    const kept = [];
    for (const {name, base} of dirs) {
      if (keepAll || results.get(name) !== true || !base.startsWith(root)) {kept.push(base); continue;}
      await fs.rm(base, {recursive: true, force: true});
    }
    console.log(JSON.stringify({tempDirectories: prefix, created: dirs.length, removed: dirs.length - kept.length, kept}));
  });
  return (t, base) => {dirs.push({name: t.name, base}); return base;};
}
