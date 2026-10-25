/**
 * T-LOCAL-014B：受控安装器的文件系统对抗测试。
 *
 * 只使用临时 MEDIA_DATA_DIR / 临时下载根 / 合成 WAV；不扫描真实素材，不写用户目录。
 * 覆盖：根与分类/文件名边界、两级目录、同名不同字节的确定后缀、同名同内容复用、
 * 根目录 inode 替换、分类目录符号链接、产物 inode 替换、取消与暂存清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CloudAudioInstallError,
  CloudAudioInstaller,
  validateCategories,
  validateFileName,
} from "../server/cloud-audio-install.mjs";

function wavBytes(seed = 1, length = 128) {
  const data = Buffer.alloc(length, seed);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-install-")));
  const root = path.join(base, "素材库");
  const dataDir = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const work = path.join(base, "work");
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, dataDir, work, installer: new CloudAudioInstaller({ dataDir }) };
}

async function artifact(work, buffer) {
  const file = path.join(work, `${crypto.randomBytes(8).toString("hex")}.part`);
  await fs.writeFile(file, buffer, { mode: 0o600 });
  const stat = await fs.stat(file);
  return { path: file, identity: { dev: stat.dev, ino: stat.ino }, bytes: buffer.length, sha256: sha(buffer) };
}

function publish(installer, item, root, extra = {}) {
  return installer.publish({
    artifactPath: item.path,
    artifactIdentity: item.identity,
    expectedBytes: item.bytes,
    expectedSha256: item.sha256,
    mimeType: "audio/wav",
    fileName: "环境音.wav",
    category: "音效",
    subcategory: "环境",
    rootPath: root.path,
    rootIdentity: { dev: root.dev, ino: root.ino },
    ...extra,
  });
}

async function filesUnder(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(dir);
  return found;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CloudAudioInstallError, `应抛 CloudAudioInstallError，实际 ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("根目录：绝对、真实目录、无符号链接；拒绝相对路径/数据目录/符号链接根", async (t) => {
  const { base, root, installer } = await setup(t);
  const inspected = await installer.inspectRoot(root);
  assert.equal(inspected.path, root);
  assert.ok(Number.isInteger(inspected.dev) && Number.isInteger(inspected.ino));

  await expectCode(installer.inspectRoot("relative/root"), "INVALID_ROOT");
  await expectCode(installer.inspectRoot(path.join(base, "missing")), "INVALID_ROOT");
  await expectCode(installer.inspectRoot(path.dirname(root)), "ROOT_UNSAFE"); // 含 dataDir
  const link = path.join(base, "link-root");
  await fs.symlink(root, link);
  await expectCode(installer.inspectRoot(link), "ROOT_UNSAFE");
});

test("文件名与分类：拒绝遍历/绝对/控制字符/保留名/无音频扩展名/超长", async () => {
  for (const bad of ["../x.wav", "a/b.wav", "a\\b.wav", "/etc/x.wav", "C:\\x.wav", "CON.wav", "x.wav.", "x.txt", ".hidden.wav", "x\u0001.wav", ""])
    assert.throws(() => validateFileName(bad), (error) => error.code === "INVALID_NAME", bad);
  assert.deepEqual(validateFileName("正常 音乐.wav"), { name: "正常 音乐.wav", ext: "wav" });

  for (const bad of ["../x", "a/b", "a\\b", "/abs", "C:", ".", "..", ".hidden", "CON", "x.", "x ", "未分类", " 空格"])
    assert.throws(() => validateCategories(bad, ""), (error) => error.code === "INVALID_CATEGORY", bad);
  assert.throws(() => validateCategories("", "子类"), (error) => error.code === "INVALID_CATEGORY");
  assert.deepEqual(validateCategories("音效", "环境"), { category: "音效", subcategory: "环境" });
  assert.deepEqual(validateCategories("", ""), { category: "", subcategory: "" });
});

test("发布：只创建两级分类目录，0600 源复制为 0644，无暂存残留", async (t) => {
  const { root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const buffer = wavBytes(7);
  const item = await artifact(work, buffer);
  const result = await publish(installer, item, rootInfo);
  const expected = path.join(root, "音效", "环境", "环境音.wav");
  assert.equal(result.path, expected);
  assert.equal(result.created, true);
  assert.equal(result.bytes, buffer.length);
  assert.equal(await fs.readFile(expected).then(sha), item.sha256);
  assert.equal((await fs.stat(expected)).mode & 0o777, 0o644);
  const entries = await fs.readdir(path.join(root, "音效", "环境"));
  assert.deepEqual(entries, ["环境音.wav"]);
  assert.equal((await fs.stat(path.join(root, "音效"))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(root, "音效"))).mode & 0o777, 0o755);
});

test("同名不同字节：确定性的 () 后缀，不覆盖原文件", async (t) => {
  const { root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const first = await artifact(work, wavBytes(1, 64));
  const second = await artifact(work, wavBytes(2, 64));
  const a = await publish(installer, first, rootInfo);
  const b = await publish(installer, second, rootInfo);
  const c = await publish(installer, first, rootInfo);
  assert.equal(a.path, path.join(root, "音效", "环境", "环境音.wav"));
  assert.equal(b.path, path.join(root, "音效", "环境", "环境音 (2).wav"));
  // 同内容再次发布命中“同名同内容复用”，不产生第三份副本。
  assert.equal(c.path, a.path);
  assert.equal(c.created, false);
  assert.equal(await fs.readFile(a.path).then(sha), first.sha256);
  assert.equal(await fs.readFile(b.path).then(sha), second.sha256);
});

test("发布前快照：按实际候选路径同步调用；复用既有文件时不调用", async (t) => {
  const { root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const first = await artifact(work, wavBytes(1, 64));
  const second = await artifact(work, wavBytes(2, 64));
  const a = await publish(installer, first, rootInfo);
  const seen = [];
  const b = await publish(installer, second, rootInfo, {
    snapshotPreexisting(candidate) {
      seen.push(candidate);
      return { id: "old-row" };
    },
  });
  assert.deepEqual(seen, [path.join(root, "音效", "环境", "环境音 (2).wav")]);
  assert.equal(b.created, true);
  assert.deepEqual(b.prePublication, { id: "old-row" });
  // 同内容复用路径不创建新文件，不需要也不应调用发布前快照。
  const c = await publish(installer, first, rootInfo, {
    snapshotPreexisting() {
      throw new Error("复用路径不得调用发布前快照");
    },
  });
  assert.equal(c.created, false);
  assert.equal(c.path, a.path);
});

test("同名同内容：校验后复用既有文件，created=false，不改写内容", async (t) => {  const { root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const buffer = wavBytes(5);
  const first = await artifact(work, buffer);
  const second = await artifact(work, buffer);
  const a = await publish(installer, first, rootInfo);
  const before = await fs.stat(a.path);
  const b = await publish(installer, second, rootInfo);
  const after = await fs.stat(a.path);
  assert.equal(b.path, a.path);
  assert.equal(b.created, false);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(a.path).then(sha), sha(buffer));
});

test("根目录被替换为新 inode：发布前固定 ROOT_CHANGED，不写新根", async (t) => {
  const { base, root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const item = await artifact(work, wavBytes(3));
  await fs.rename(root, path.join(base, "old-root"));
  await fs.mkdir(root);
  await expectCode(publish(installer, item, rootInfo), "ROOT_CHANGED");
  assert.deepEqual(await filesUnder(root), []);
});

test("分类目录是符号链接：拒绝，不跟随写入", async (t) => {
  const { base, root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, "音效"));
  await fs.symlink(outside, path.join(root, "音效", "环境"));
  const item = await artifact(work, wavBytes(4));
  await assert.rejects(publish(installer, item, rootInfo), (error) => ["TARGET_CHANGED", "ROOT_UNSAFE"].includes(error.code));
  assert.deepEqual(await fs.readdir(outside), [], "绝不能跟随分类符号链接写到外部目录");
});

test("源产物在打开前被替换：SOURCE_CHANGED，不发布", async (t) => {
  const { root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const item = await artifact(work, wavBytes(6));
  await fs.rm(item.path);
  await fs.writeFile(item.path, wavBytes(6), { mode: 0o600 });
  await expectCode(publish(installer, item, rootInfo), "SOURCE_CHANGED");
  assert.deepEqual(await filesUnder(root), []);
});

test("取消：复制前/复制中固定 CANCELLED，删除本站暂存，不发布半成品", async (t) => {
  const { root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const item = await artifact(work, wavBytes(8));
  const aborted = new AbortController();
  aborted.abort();
  await expectCode(publish(installer, item, rootInfo, { signal: aborted.signal }), "CANCELLED");
  assert.deepEqual(await filesUnder(root), []);

  const controller = new AbortController();
  let calls = 0;
  await expectCode(
    publish(installer, item, rootInfo, {
      signal: controller.signal,
      assertContext: () => {
        calls += 1;
        if (calls >= 2) controller.abort();
      },
    }),
    "CANCELLED",
  );
  assert.deepEqual(await filesUnder(root), []);
  assert.deepEqual(await fs.readdir(work), [item.path.split(path.sep).pop()], "只应留下调用方源产物");
});

test("碰撞查找的 await 期间上下文变化：发布前拒绝，不留目标文件", async (t) => {
  const { base, root, work, installer } = await setup(t);
  const rootInfo = await installer.inspectRoot(root);
  const item = await artifact(work, wavBytes(12));
  const original = fs.readdir;
  let changed = false;
  fs.readdir = async function (dir, ...args) {
    const result = await original.call(this, dir, ...args);
    if (dir === root) changed = true;
    return result;
  };
  try {
    await assert.rejects(
      publish(installer, item, rootInfo, {
        category: "",
        subcategory: "",
        assertContext: () => {
          if (changed) throw new Error("Fixture context changed");
        },
      }),
      /Fixture context changed/,
    );
  } finally {
    fs.readdir = original;
  }
  assert.deepEqual(await filesUnder(root), [], "上下文变化后不能留下目标文件或暂存文件");
  assert.equal(changed, true);
  await fs.rm(base, { recursive: true, force: true });
});
