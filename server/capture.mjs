import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export function parseCaptureTime(value, defaultZone = "+08:00") {
  if (typeof value !== "string") return null;
  const m =
    /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59)
    return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const check = new Date(date + "T00:00:00Z");
  if (
    !Number.isFinite(check.getTime()) ||
    check.toISOString().slice(0, 10) !== date
  )
    return null;
  const zone = m[8] || defaultZone;
  if (!/^(Z|[+-](?:0\d|1\d|2[0-3]):?[0-5]\d)$/.test(zone)) return null;
  const iso = `${date}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "." + m[7].slice(0, 3) : ""}${zone}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? { ms, assumed: !m[8] && defaultZone === "+08:00" }
    : null;
}
export function captureFromTags(tags) {
  const original = [
    "ExifIFD:DateTimeOriginal",
    "EXIF:DateTimeOriginal",
    "XMP-exif:DateTimeOriginal",
    "QuickTime:DateTimeOriginal",
    "UserData:DateTimeOriginal",
  ];
  for (const key of Object.keys(tags))
    if (key.endsWith(":DateTimeOriginal") && !original.includes(key))
      original.push(key);
  const offset =
    tags["ExifIFD:OffsetTimeOriginal"] || tags["EXIF:OffsetTimeOriginal"];
  for (const key of original) {
    const value = tags[key];
    const parsed = parseCaptureTime(
      value,
      typeof offset === "string" ? offset : "+08:00",
    );
    if (parsed)
      return {
        ms: parsed.ms,
        source:
          key + (!offset && parsed.assumed ? "（无时区，按北京时间）" : ""),
      };
  }
  for (const key of [
    "Keys:CreationDate",
    "QuickTime:CreationDate",
    "XMP-exif:DateTimeDigitized",
  ]) {
    const parsed = parseCaptureTime(tags[key]);
    if (parsed)
      return {
        ms: parsed.ms,
        source: key + (parsed.assumed ? "（无时区，按北京时间）" : ""),
      };
  }
  // QuickTime's integer CreateDate is container metadata, not guaranteed capture time.
  const value = tags["QuickTime:CreateDate"];
  if (typeof value === "string" && !/^1904:01:01 00:00:00/.test(value)) {
    const parsed = parseCaptureTime(value, "Z");
    if (parsed)
      return {
        ms: parsed.ms,
        source: "QuickTime:CreateDate（视频容器时间，可能为导出时间）",
      };
  }
  return { ms: null, source: "" };
}
export async function readCapture(p) {
  const { stdout } = await run(
    "exiftool",
    [
      "-j",
      "-G1",
      "-s",
      "-api",
      "QuickTimeUTC=1",
      "-DateTimeOriginal",
      "-OffsetTimeOriginal",
      "-CreationDate",
      "-QuickTime:CreateDate",
      "-XMP-exif:DateTimeDigitized",
      p,
    ],
    { env: { ...process.env, TZ: "UTC" }, timeout: 20000, maxBuffer: 2e6 },
  );
  const tags = JSON.parse(stdout)[0] || {};
  if (tags.Error) throw Error(tags.Error);
  return captureFromTags(tags);
}
