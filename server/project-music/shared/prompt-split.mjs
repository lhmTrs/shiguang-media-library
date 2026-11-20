// 把粘进来的一整段 Suno 提示词拆成「风格」和「歌词」（验收 PR5 P3-1）。前端收纳窗口和服务端用同一份。
// 只有风格会拆成音乐库标签，所以宁可多放进歌词，也不把歌词、段落标记放进风格：拆不准时整段放进歌词。
// 认的格式：
//   1. 带标题：「Style of Music: …」「风格：…」「Lyrics:」「歌词：」（标题行之后到下一个标题前都归它）；
//   2. 带段落标记：[Intro] [Verse] [Chorus] [Bridge] 【副歌】……第一个标记之前像风格的那一两行是风格，从标记起都是歌词；
//   3. 没有标记：空行隔开时，第一段像风格就是风格、其余是歌词；只有一两行且像风格，就是风格；其余整段算歌词。
const MARK = /^\s*[[【［]\s*[^\]】］\n]{1,40}\s*[\]】］]\s*$/;
const HEAD_STYLE = /^\s*(?:style(?:\s+of\s+music)?|styles|genre|风格|曲风|音乐风格)\s*[:：]\s*(.*)$/i;
const HEAD_LYRICS = /^\s*(?:lyrics|歌词)\s*[:：]\s*(.*)$/i;
const HEAD_OTHER = /^\s*(?:title|歌名|标题|exclude\s+styles?|negative|排除风格)\s*[:：]\s*(.*)$/i;
const SEP = /[,，、/／|;；]/;

// 一行像不像风格描述：有分隔符，或者是几个短词；不能是段落标记，也不像一句歌词（以句号、问号、感叹号结尾）。
function styleLine(line) {
  const t = line.trim();
  if (!t || t.length > 200 || MARK.test(t) || /[[\]【】]/.test(t) || /[。！？!?…]$/.test(t)) return false;
  if (SEP.test(t)) return true;
  const words = t.split(/\s+/);
  return words.length >= 2 && words.length <= 8 && words.every(w => w.length <= 16) && t.length <= 80;
}
const looksStyle = lines => lines.length > 0 && lines.length <= 2 && lines.every(styleLine);
const clean = lines => lines.join('\n').replace(/^\n+|\n+$/g, '');

export function splitSunoPrompt(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return {style: '', lyrics: '', params: '', how: 'empty'};
  const lines = raw.split('\n');
  if (lines.some(l => HEAD_STYLE.test(l) || HEAD_LYRICS.test(l))) {
    const out = {style: [], lyrics: [], params: []};
    let cur = null;
    for (const l of lines) {
      let m;
      if ((m = l.match(HEAD_STYLE))) { cur = 'style'; if (m[1].trim()) out.style.push(m[1]); continue; }
      if ((m = l.match(HEAD_LYRICS))) { cur = 'lyrics'; if (m[1].trim()) out.lyrics.push(m[1]); continue; }
      if (HEAD_OTHER.test(l)) { out.params.push(l.trim()); cur = 'params'; continue; }
      if (cur === null && !l.trim()) continue;
      out[cur ?? 'lyrics'].push(l);
    }
    const styleLines = out.style.filter(l => l.trim());
    // 标了「风格」但内容像歌词（有段落标记、行数多）：拆不准，全部放进歌词。
    if (styleLines.length && !styleLines.every(styleLine) || styleLines.length > 3) return {style: '', lyrics: raw, params: '', how: 'unsure'};
    return {style: styleLines.map(l => l.trim()).join(', '), lyrics: clean(out.lyrics), params: clean(out.params), how: 'headers'};
  }
  const firstMark = lines.findIndex(l => MARK.test(l));
  if (firstMark >= 0) {
    const pre = lines.slice(0, firstMark).filter(l => l.trim());
    const rest = clean(lines.slice(firstMark));
    if (!pre.length) return {style: '', lyrics: rest, params: '', how: 'markers'};
    if (looksStyle(pre)) return {style: pre.map(l => l.trim()).join(', '), lyrics: rest, params: '', how: 'markers'};
    return {style: '', lyrics: raw, params: '', how: 'unsure'};
  }
  const nonEmpty = lines.filter(l => l.trim());
  const blank = lines.findIndex(l => !l.trim());
  if (blank > 0) {
    const pre = lines.slice(0, blank).filter(l => l.trim()), rest = clean(lines.slice(blank));
    if (looksStyle(pre)) return {style: pre.map(l => l.trim()).join(', '), lyrics: rest, params: '', how: 'blank-line'};
    return {style: '', lyrics: raw, params: '', how: 'unsure'};
  }
  if (looksStyle(nonEmpty)) return {style: nonEmpty.map(l => l.trim()).join(', '), lyrics: '', params: '', how: 'style-only'};
  return {style: '', lyrics: raw, params: '', how: 'unsure'};
}

// 拆标签前的保险：带方括号的词（段落标记）一律不当标签。
export const isMarkerToken = token => /[[\]【】［］]/.test(token);
