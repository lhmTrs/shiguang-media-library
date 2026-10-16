import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  captureFromTags,
  parseCaptureTime,
  readCapture,
} from "../server/capture.mjs";
import { Library, run, creationDay } from "../server/library.mjs";
test("优先拍摄字段、时区换算、不使用文件日期、无时区和容器日期标注", () => {
  const a = captureFromTags({
    "ExifIFD:DateTimeOriginal": "2026:10:12 23:30:00",
    "ExifIFD:OffsetTimeOriginal": "-04:00",
    "QuickTime:CreateDate": "2020:01:01 00:00:00+00:00",
  });
  assert.equal(a.ms, Date.parse("2026-10-13T03:30:00Z"));
  assert.equal(a.source, "ExifIFD:DateTimeOriginal");
  const b = captureFromTags({
    "ExifIFD:DateTimeOriginal": "2026:10:12 10:20:30",
  });
  assert.equal(b.ms, Date.parse("2026-10-12T10:20:30+08:00"));
  assert.match(b.source, /无时区/);
  const video = captureFromTags({
    "Keys:CreationDate": "2026:10:12 23:30:00-04:00",
    "QuickTime:CreateDate": "2020:01:01 00:00:00+00:00",
  });
  assert.equal(video.ms, a.ms);
  assert.equal(video.source, "Keys:CreationDate");
  assert.match(
    captureFromTags({ "QuickTime:CreateDate": "2026:10:12 16:30:00+00:00" })
      .source,
    /可能为导出/,
  );
  assert.equal(
    captureFromTags({
      "System:FileCreateDate": "2026:10:13 00:00:00",
      "System:FileModifyDate": "2026:10:13 00:00:00",
    }).ms,
    null,
  );
  assert.equal(
    captureFromTags({ "QuickTime:CreateDate": "1904:01:01 00:00:00+00:00" }).ms,
    null,
  );
  for (const s of [
    "2026:02:30 12:00:00",
    "2026:10:12 25:00:00",
    "0000:00:00 00:00:00",
    "2026:10:12 12:00:00+25:00",
  ])
    assert.equal(parseCaptureTime(s), null);
});
test("真实 EXIF 与 MP4读取、按拍摄日期筛选、手动校正保存和重扫", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-capture-")),
  );
  const source = path.join(base, "photos");
  await fs.mkdir(source);
  const photo = path.join(source, "拍摄照片.jpg"),
    video = path.join(source, "相机视频.mp4"),
    plain = path.join(source, "无元数据.jpg");
  const lib = await new Library(path.join(base, "db")).init();
  lib.enqueue = () => {};
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:size=64x64",
    "-frames:v",
    "1",
    photo,
  ]);
  await fs.copyFile(photo, plain);
  await run("exiftool", [
    "-overwrite_original",
    "-DateTimeOriginal=2026:10:12 23:45:00",
    "-OffsetTimeOriginal=+08:00",
    photo,
  ]);
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:size=64x64:duration=1",
    "-c:v",
    "libx264",
    "-metadata",
    "creation_time=2026-10-12T16:30:00Z",
    video,
  ]);
  assert.equal(
    (await readCapture(photo)).ms,
    Date.parse("2026-10-12T23:45:00+08:00"),
  );
  assert.equal(
    (await readCapture(video)).ms,
    Date.parse("2026-10-12T16:30:00Z"),
  );
  assert.equal((await readCapture(plain)).ms, null);
  const root = await lib.addRoot(source, "mixed");
  async function scan() {
    const j = lib.scan(root.id);
    while (j.status === "running") await new Promise((r) => setTimeout(r, 10));
    assert.equal(j.status, "done");
  }
  await scan();
  const items = lib.list().items;
  for (const a of items) await lib.probe(a.id);
  assert.equal(
    lib.list({ capturedFrom: "2026-10-12", capturedTo: "2026-10-12" }).total,
    1,
  );
  assert.equal(
    lib.list({ capturedFrom: "2026-10-13", capturedTo: "2026-10-13" }).total,
    1,
  );
  assert.equal(lib.list({ captureUnknown: "1" }).total, 1);
  assert.throws(
    () => lib.list({ capturedFrom: "2026-10-14", capturedTo: "2026-10-12" }),
    /晚于/,
  );
  const a = items.find((a) => a.name === "拍摄照片.jpg");
  const before = await fs.stat(photo);
  lib.patch(a.id, {
    capturedAt: "2026-10-13T09:15",
    tags: ["保留"],
    favorite: 1,
  });
  assert.equal(
    lib.asset(a.id).captured_ms,
    creationDay("2026-10-13") + 9.25 * 3600000,
  );
  assert.match(lib.asset(a.id).capture_source, /手动/);
  await fs.utimes(photo, before.atime, new Date(before.mtimeMs + 5000));
  await scan();
  await lib.probe(a.id);
  assert.match(lib.asset(a.id).capture_source, /手动/);
  assert.deepEqual(lib.asset(a.id).tags, ["保留"]);
  lib.patch(a.id, { capturedAt: "" });
  await lib.probe(a.id);
  assert.equal(
    lib.asset(a.id).captured_ms,
    Date.parse("2026-10-12T23:45:00+08:00"),
  );
  assert.equal(
    (await readCapture(photo)).ms,
    Date.parse("2026-10-12T23:45:00+08:00"),
  );
  assert.equal((await fs.stat(photo)).size, before.size);
});
