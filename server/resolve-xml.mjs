import { DOMParser } from "@xmldom/xmldom";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const children = (node, tag) => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1 && (!tag || child.tagName === tag));
const child = (node, tag) => children(node, tag)[0];
const text = (node, tag) => (child(node, tag)?.textContent || "").trim();
const disabled = node => text(node, "enabled").toLowerCase() === "false" || ["true", "1"].includes(text(node, "mute").toLowerCase());
function rate(node, fallback = null) {
  const value = child(node, "rate"), base = Number(text(value, "timebase"));
  return base > 0 && base <= 240 ? base * (text(value, "ntsc").toLowerCase() === "true" ? 1000 / 1001 : 1) : fallback;
}
function localPath(value) {
  if (!value || value.length > 8192) return null;
  try {
    if (/^file:/i.test(value)) return fileURLToPath(value);
    if (path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) return value;
  } catch {}
  return null;
}
function frames(value) { return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null; }

export function parseResolveXml(xml) {
  if (typeof xml !== "string" || !xml.trim() || Buffer.byteLength(xml) > 4 * 1024 * 1024) throw Error("请选择不超过 4MB 的时间线 XML");
  // Resolve's simple <!DOCTYPE xmeml> is harmless; no external or custom entities are accepted.
  const safe = xml.replace(/<!DOCTYPE\s+xmeml\s*>/gi, "");
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(safe)) throw Error("不接受带外部声明或自定义实体的 XML");
  let doc;
  try { doc = new DOMParser({ onError: level => { if (level !== "warning") throw Error("invalid XML"); } }).parseFromString(safe, "application/xml"); }
  catch { throw Error("XML 结构无效，请从达芬奇重新导出 FCP 7 XML"); }
  if (doc.documentElement?.tagName !== "xmeml") throw Error("当前仅支持 FCP 7 XML（xmeml），不支持 FCPXML、DRT 或成片文件");
  let count = 0;
  const visit = [[doc.documentElement, 0]];
  while (visit.length) {
    const [node, depth] = visit.pop();
    if (++count > 150000 || depth > 64) throw Error("XML 结构过大或嵌套过深");
    for (const item of children(node)) visit.push([item, depth + 1]);
  }
  const sequences = Array.from(doc.getElementsByTagName("sequence")).filter(node => {
    for (let p = node.parentNode; p && p !== doc; p = p.parentNode) if (["clipitem", "sequence"].includes(p.nodeName)) return false;
    return !!child(node, "media");
  });
  if (sequences.length !== 1) throw Error("请单独导出一条时间线，当前文件没有唯一的完整时间线");
  const sequence = sequences[0], fps = rate(sequence), files = new Map();
  if (!fps) throw Error("XML 缺少有效时间线帧率，无法可靠计算使用位置");
  for (const file of Array.from(doc.getElementsByTagName("file"))) {
    const id = file.getAttribute("id");
    if (id && text(file, "pathurl")) {
      const previous = files.get(id);
      if (previous && text(previous, "pathurl") !== text(file, "pathurl")) throw Error("XML 中存在冲突的素材引用 ID");
      files.set(id, file);
    }
  }
  const entries = new Map(), warnings = ["时间线引用不等于最终成片可听；轨道混音、效果和嵌套内容需要人工核对。" ];
  let occurrences = 0, nested = 0;
  const audio = child(child(sequence, "media"), "audio");
  children(audio, "track").forEach((track, trackIndex) => {
    for (const clip of children(track, "clipitem")) {
      if (++occurrences > 5000) throw Error("第一版每次最多导入 5000 个音频片段");
      if (child(clip, "sequence")) { nested++; continue; }
      const reference = child(clip, "file");
      const file = text(reference, "pathurl") ? reference : files.get(reference?.getAttribute("id"));
      const rawPath = text(file, "pathurl"), sourcePath = localPath(rawPath);
      const name = text(file, "name") || (sourcePath ? path.basename(sourcePath) : text(clip, "name")) || "未命名素材";
      const key = crypto.createHash("sha256").update(JSON.stringify([rawPath, name])).digest("hex");
      const start = frames(text(clip, "start")), end = frames(text(clip, "end"));
      const sourceIn = frames(text(clip, "in")), sourceOut = frames(text(clip, "out")), sourceRate = rate(file, rate(clip, fps));
      const occurrence = { clipId: clip.getAttribute("id") || "", clipName: text(clip, "name"), track: trackIndex + 1, startFrame: start, endFrame: end, sourceRate, start: start === null ? null : start / fps, end: end === null ? null : end / fps, sourceIn: sourceIn === null ? null : sourceIn / sourceRate, sourceOut: sourceOut === null ? null : sourceOut / sourceRate, disabled: disabled(track) || disabled(clip) };
      const entry = entries.get(key) || { key, name, sourcePath, occurrences: [] };
      entry.occurrences.push(occurrence); entries.set(key, entry);
    }
  });
  if (nested) warnings.push(`${nested} 个嵌套音频片段未展开，请手动核对，不会据此认定内部素材未使用。`);
  const durationFrames = frames(text(sequence, "duration"));
  return { name: text(sequence, "name") || "达芬奇时间线", fps, duration: durationFrames === null ? null : durationFrames / fps, startTimecode: text(child(sequence, "timecode"), "string") || null, entries: [...entries.values()], warnings, nested, occurrences };
}
