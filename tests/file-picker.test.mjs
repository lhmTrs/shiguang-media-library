import test from "node:test";
import assert from "node:assert/strict";
import { createFilePicker, filePickerAvailable } from "../server/file-picker.mjs";

const FAILURE = "无法完成系统文件选择。请重试，或填写成片绝对路径";
console.log(JSON.stringify({ evidence: "W05 mock runner only; no native dialog or child process", pid: process.pid, host: process.platform, node: process.version }));
const mockWindows = (stdout, extra = {}) => createFilePicker({ platform: "win32", env: {}, run: async () => ({ stdout }), ...extra });

test("W05 capability/construction performs no execution and cannot enable Linux/container", async () => {
  let calls = 0;
  const run = async () => { calls++; throw Error("must not run"); };
  const idle = createFilePicker({ platform: "win32", env: {}, run });
  assert.equal(typeof idle, "function"); assert.equal(calls, 0);
  for (const platform of ["darwin", "win32"]) {
    assert.equal(filePickerAvailable(platform, {}), true);
    assert.equal(filePickerAvailable(platform, { MEDIA_CONTAINER: "1" }), false);
    await assert.rejects(createFilePicker({ platform, env: { MEDIA_CONTAINER: "1" }, run })(), /不支持/);
  }
  assert.equal(filePickerAvailable("linux", {}), false);
  await assert.rejects(createFilePicker({ platform: "linux", env: {}, run })(), /不支持/);
  assert.equal(calls, 0);
});

test("W05 Windows fixed command/UTF8/STA/single-select preserves drive and UNC strings", async () => {
  for (const selected of ["D:\\素材 空格\\成片 & '1'.mov", "\\\\nas\\共享资料\\中文 成片.mp4", "E:/项目/成片.mp4"]) {
    let calls = 0;
    const choose = createFilePicker({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, run: async (file, args, options) => {
      calls++;
      assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand"]);
      assert.equal(args.length, 5);
      const script = Buffer.from(args[4], "base64").toString("utf16le");
      assert.match(script, /System\.Windows\.Forms\.OpenFileDialog/);
      assert.match(script, /UTF8Encoding/); assert.match(script, /\$dialog\.Multiselect = \$false/);
      assert.match(script, /\$dialog\.CheckFileExists = \$true/); assert.match(script, /\$dialog\.CheckPathExists = \$true/);
      assert.match(script, /finally\s*\{\s*\$dialog\.Dispose\(\)/);
      assert.ok(!script.includes(selected)); assert.ok(!args.some(a => /ExecutionPolicy|Bypass/i.test(a)));
      assert.deepEqual(options, { timeout: 120000, maxBuffer: 16384, encoding: "utf8", shell: false, windowsHide: true });
      return { stdout: "\uFEFF" + JSON.stringify({ path: selected }) + "\r\n" };
    } });
    assert.deepEqual(await choose(), { cancelled: false, path: selected }); assert.equal(calls, 1);
  }
});

test("W05 cancellation DTO has no path; selector has no save API", async () => {
  for (const stdout of ['{"path":null}', '{"path":""}']) assert.deepEqual(await mockWindows(stdout)(), { cancelled: true });
  for (const stdout of ["", "\n", "\r\n"]) {
    const choose = createFilePicker({ platform: "darwin", env: {}, run: async () => ({ stdout }) });
    assert.deepEqual(await choose(), { cancelled: true });
  }
});

test("W05 Mac movie picker and -128 cancellation use fixed osascript, preserve filename spaces", async () => {
  const selected = "/tmp/测试 专用/成片 & '1' .mov ";
  const choose = createFilePicker({ platform: "darwin", env: {}, run: async (file, args, options) => {
    assert.equal(file, "/usr/bin/osascript"); assert.equal(args[0], "-e"); assert.equal(args.length, 2);
    assert.match(args[1], /choose file/); assert.match(args[1], /public\.movie/); assert.match(args[1], /on error number -128/);
    assert.ok(!args[1].includes(selected));
    assert.deepEqual(options, { timeout: 120000, maxBuffer: 16384, encoding: "utf8", shell: false });
    return { stdout: selected + "\n" };
  } });
  assert.deepEqual(await choose(), { cancelled: false, path: selected });
});

test("W05 malformed, duplicate or non-scalar Windows JSON and oversized output reject", async () => {
  for (const stdout of [undefined, "bad", "null", "[]", "{}", '{"path":false}', '{"path":{}}', '{"path":[]}',
    '{"path":null,"extra":true}', '{"path":null,"path":"C:\\\\foo.mov"}', "x".repeat(16385)]) {
    await assert.rejects(mockWindows(stdout)(), error => error.message === FAILURE && !error.cause);
  }
});

test("W05 rooted drive/UNC required; relative, single-rooted, ADS and device namespaces reject", async () => {
  const bad = ["relative.mov", "C:relative.mov", "\\single-rooted.mov", "/single-rooted.mov", "\\\\server", "\\\\server\\", "\\\\?\\C:\\movie.mov", "\\\\.\\C:\\movie.mov", "\\??\\C:\\movie.mov", "\\\\?\\UNC\\server\\share\\file.mov", "C:\\movie.mov:stream", "C:\\a\\..\\movie.mov", "\\\\server\\share\\..\\movie.mov", "\\\\server/share/file.mov", "C:\\bad\0.mov", "C:\\bad\n.mov", "C:\\bad\t.mov", "C:\\bad\x7f.mov", "C:\\bad?.mov", "C:\\" + "x".repeat(8190)];
  for (const selected of bad) await assert.rejects(mockWindows(JSON.stringify({ path: selected }))(), error => error.message === FAILURE, selected);
});

test("W05 Mac relative/control/overlimit output also rejects without echoing paths", async () => {
  for (const stdout of ["relative.mov\n", "/tmp/private\0.mov\n", "/tmp/private\nname.mov\n", "/" + "x".repeat(8192) + "\n", "x".repeat(16385), undefined]) {
    const choose = createFilePicker({ platform: "darwin", env: {}, run: async () => ({ stdout }) });
    await assert.rejects(choose(), error => error.message === FAILURE);
  }
});

test("W05 invalid SystemRoot cannot execute a command", async () => {
  let calls = 0;
  for (const SystemRoot of ["relative", "C:Windows", "\\Windows", "\\\\server\\Windows", "\\\\?\\C:\\Windows", "C:\\..\\Windows", "C:\\bad\nroot"]) {
    await assert.rejects(createFilePicker({ platform: "win32", env: { SystemRoot }, run: async () => { calls++; return { stdout: '{"path":null}' }; } })(), error => error.message === FAILURE);
  }
  assert.equal(calls, 0);
});

test("W05 timeout/ENOENT errors are sanitized and unlock the next attempt", async () => {
  for (const code of ["ENOENT", "ETIMEDOUT"]) {
    let calls = 0;
    const choose = createFilePicker({ platform: "win32", env: {}, run: async () => {
      if (++calls === 1) throw Object.assign(Error("PRIVATE PATH AND STDERR"), { code, stderr: "PRIVATE STDERR", killed: true });
      return { stdout: '{"path":null}' };
    } });
    await assert.rejects(choose(), error => error.message === FAILURE && !error.cause && !error.stderr && !error.code);
    assert.deepEqual(await choose(), { cancelled: true }); assert.equal(calls, 2);
  }
});

test("W05 one active invocation: concurrency refuses extra runner and cancellation releases lock", async () => {
  let settle, calls = 0;
  const choose = createFilePicker({ platform: "win32", env: {}, run: () => { calls++; return new Promise(resolve => { settle = resolve; }); } });
  const first = choose(); await assert.rejects(choose(), /窗口已打开/); assert.equal(calls, 1);
  settle({ stdout: '{"path":null}' }); assert.deepEqual(await first, { cancelled: true });
  const next = choose(); assert.equal(calls, 2); settle({ stdout: '{"path":"D:\\\\测试.mov"}' });
  assert.deepEqual(await next, { cancelled: false, path: "D:\\测试.mov" });
});
