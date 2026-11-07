import test from "node:test";
import assert from "node:assert/strict";
import { createFolderPicker, folderPickerAvailable } from "../server/folder-picker.mjs";

test("native folder capability supports Windows and Mac but not containers", () => {
  for (const platform of ["win32", "darwin"]) {
    assert.equal(folderPickerAvailable(platform, {}), true);
    assert.equal(folderPickerAvailable(platform, { MEDIA_CONTAINER: "1" }), false);
  }
  assert.equal(folderPickerAvailable("linux", {}), false);
});

test("Windows fixed STA dialog preserves Unicode, spaces, metacharacters and UNC paths", async () => {
  for (const selected of ["D:\\素材\\音效 & 音乐 '1'", "\\\\nas\\音乐库\\音效", "D:\\"]) {
    let calls = 0;
    const choose = createFolderPicker({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, run: async (file, args, options) => {
      calls++;
      assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert(args.includes("-STA"));
      assert(args.includes("-NoProfile"));
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /FolderBrowserDialog/);
      assert.match(script, /UTF8Encoding/);
      assert.match(script, /\$dialog\.Dispose\(\)/);
      assert(!script.includes(selected));
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 120000);
      assert.equal(options.maxBuffer, 16384);
      return { stdout: "\uFEFF" + JSON.stringify({ path: selected }) + "\r\n" };
    } });
    assert.deepEqual(await choose(), { cancelled: false, path: selected });
    assert.equal(calls, 1);
  }
});

test("Windows cancellation returns no path and opens no second dialog", async () => {
  const choose = createFolderPicker({ platform: "win32", env: {}, run: async () => ({ stdout: '{"path":null}' }) });
  assert.deepEqual(await choose(), { cancelled: true });
});

test("Mac keeps the native picker, preserves spaces and handles cancellation", async () => {
  for (const [stdout, expected] of [["/tmp/素材 /\n", { cancelled: false, path: "/tmp/素材 /" }], ["\n", { cancelled: true }]]) {
    const choose = createFolderPicker({ platform: "darwin", env: {}, run: async (file, args) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.match(args[1], /on error number -128/);
      return { stdout };
    } });
    assert.deepEqual(await choose(), expected);
  }
});

test("malformed and relative dialog output cannot register a directory", async () => {
  for (const stdout of ["bad", "null", "[]", '{"path":"relative"}', '{"path":false}', '{"path":{}}', '{"path":"D:\\\\media","extra":true}', JSON.stringify({ path: "D:\\bad\0path" })]) {
    const choose = createFolderPicker({ platform: "win32", env: {}, run: async () => ({ stdout }) });
    await assert.rejects(choose(), /填写文件夹绝对路径/);
  }
});

test("missing PowerShell or timeout is safe, does not leak stderr, and permits retry", async () => {
  let calls = 0;
  const choose = createFolderPicker({ platform: "win32", env: {}, run: async () => {
    if (++calls === 1) throw Object.assign(Error("private stderr marker"), { killed: true });
    return { stdout: '{"path":null}' };
  } });
  await assert.rejects(choose(), error => !error.message.includes("private stderr") && /绝对路径/.test(error.message));
  assert.deepEqual(await choose(), { cancelled: true });
});

test("concurrent selection is refused until the first native dialog settles", async () => {
  let settle;
  const choose = createFolderPicker({ platform: "win32", env: {}, run: () => new Promise(resolve => { settle = resolve; }) });
  const first = choose();
  await assert.rejects(choose(), /窗口已打开/);
  settle({ stdout: '{"path":null}' });
  assert.deepEqual(await first, { cancelled: true });
});

test("unsupported platforms and invalid system roots never execute a command", async () => {
  let calls = 0;
  const run = async () => { calls++; throw Error("should not execute"); };
  await assert.rejects(createFolderPicker({ platform: "linux", env: {}, run })(), /不支持/);
  await assert.rejects(createFolderPicker({ platform: "win32", env: { MEDIA_CONTAINER: "1" }, run })(), /不支持/);
  await assert.rejects(createFolderPicker({ platform: "win32", env: { SystemRoot: "relative" }, run })(), /绝对路径/);
  assert.equal(calls, 0);
});

test("Windows directory paths require a full drive or server/share UNC, not current-drive or device paths", async () => {
  const invalid = ["\\current-drive\\media", "/current-drive/media", "C:relative", "\\\\server", "\\\\server\\", "\\\\server\\\\share", "//server/share", "\\\\?\\C:\\media", "\\\\.\\C:\\media", "\\??\\C:\\media", "\\\\?\\UNC\\server\\share", "C:\\a\\..\\media", "\\\\server\\share\\.\\media", "C:\\media:stream", "C:\\bad\nname", "C:\\bad\rname", "C:\\bad\tname", "C:\\bad\x7fname"];
  for (const selected of invalid) {
    const choose = createFolderPicker({ platform: "win32", env: {}, run: async () => ({ stdout: JSON.stringify({ path: selected }) }) });
    await assert.rejects(choose(), error => /填写文件夹绝对路径/.test(error.message) && !error.message.includes(selected), JSON.stringify(selected));
  }
});

test("Windows directory validation preserves full drive/UNC case, Unicode, spaces and exact length boundary", async () => {
  const valid = ["d:\\素材 空格\\MiXeD & '项目'", "E:/素材/音乐", "\\\\NaS\\中文共享", "\\\\NaS\\中文共享\\音效 空格", "D:\\" + "x".repeat(8189)];
  for (const selected of valid) {
    const choose = createFolderPicker({ platform: "win32", env: {}, run: async () => ({ stdout: JSON.stringify({ path: selected }) }) });
    assert.deepEqual(await choose(), { cancelled: false, path: selected });
  }
  const tooLong = "D:\\" + "x".repeat(8190);
  await assert.rejects(createFolderPicker({ platform: "win32", env: {}, run: async () => ({ stdout: JSON.stringify({ path: tooLong }) }) })(), /绝对路径/);
});

test("Windows SystemRoot must be fully drive-rooted and rejects unsafe roots before invoking the runner", async () => {
  let calls = 0;
  for (const SystemRoot of ["C:Windows", "\\Windows", "\\\\server\\share", "\\\\?\\C:\\Windows", "\\\\.\\C:\\Windows", "C:\\..\\Windows", "C:\\Windows\nprivate", "C:\\Windows\x7fprivate"]) {
    await assert.rejects(createFolderPicker({ platform: "win32", env: { SystemRoot }, run: async () => { calls++; return { stdout: '{"path":null}' }; } })(), /绝对路径/);
  }
  assert.equal(calls, 0);
  const choose = createFolderPicker({ platform: "win32", env: { SYSTEMROOT: "d:\\wInDoWs" }, run: async (program, args, options) => {
    calls++; assert.equal(program, "d:\\wInDoWs\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"); assert.equal(options.shell, false); return { stdout: '{"path":null}' };
  } });
  assert.deepEqual(await choose(), { cancelled: true }); assert.equal(calls, 1);
});

test("Windows chooser bounds raw output bytes before JSON parsing, not only selected character count", async () => {
  for (const stdout of [" ".repeat(16384) + '{"path":null}', JSON.stringify({ path: "D:\\" + "界".repeat(6000) })]) {
    assert.ok(Buffer.byteLength(stdout) > 16384);
    await assert.rejects(createFolderPicker({ platform: "win32", env: {}, run: async () => ({ stdout }) })(), /绝对路径/);
  }
});
