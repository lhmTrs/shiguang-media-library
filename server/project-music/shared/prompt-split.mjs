// 把粘进来的一整段 Suno 提示词拆成「风格」和「歌词」（验收 PR5 P3-1）。前端收纳窗口和服务端用同一份。
// 只有风格会拆成音乐库标签，所以宁可多放进歌词，也不把歌词、段落标记放进风格：拆不准时整段放进歌词。
// 认的格式（验收 PR5 两轮后定的规则）：
//   1. 带标题：「Style of Music: …」「风格：…」「Lyrics:」「歌词：」（标题行之后到下一个标题前都归它）；
//   2. 带段落标记：[Intro] [Verse] [Chorus] [Bridge] 【副歌】……第一个标记之前「只有一行、并且带逗号或斜杠这类分隔符」才算风格，从标记起都是歌词；
//   3. 没有标记、也没有标题：整段「只有一行、并且带分隔符」才算风格；
//   4. 没有标记、也没有标题，但「第一行、空一行、后面是歌词」：第一行要更像风格才算风格（styleParagraphLine），否则照旧整段算歌词；
//   5. 其余两行以上一律算歌词。
// Suno 的风格几乎都是一行用逗号分隔的短词；中文歌词常带「，」、英文歌词常是几个短词一行，所以多行默认不当风格。
// 第 4 条是合并后补的（PR #138 之后的待办）：最常见的粘贴格式就是风格一行、空一行、歌词，原来整段进了歌词、风格留空。
// 为了不把一句带逗号的歌词当成风格，第 4 条比第 3 条严：至少两段里带常见的风格词（曲风、乐器、人声、速度），并且没有我、你、me、you 这类歌词里才有的字词。
const MARK = /^\s*[[【［]\s*[^\]】］\n]{1,40}\s*[\]】］]\s*$/;
const HEAD_STYLE = /^\s*(?:style(?:\s+of\s+music)?|styles|genre|风格|曲风|音乐风格)\s*[:：]\s*(.*)$/i;
const HEAD_LYRICS = /^\s*(?:lyrics|歌词)\s*[:：]\s*(.*)$/i;
const HEAD_OTHER = /^\s*(?:title|歌名|标题|exclude\s+styles?|negative|排除风格)\s*[:：]\s*(.*)$/i;
const SEP = /[,，、/／|;；]/;

// 一行像不像风格描述：要有分隔符；不能是段落标记，也不像一句歌词（以句号、问号、感叹号结尾）。
function styleLine(line) {
  const t = line.trim();
  return !!t && t.length <= 200 && !MARK.test(t) && !/[[\]【】]/.test(t) && !/[。！？!?…]$/.test(t) && SEP.test(t);
}
// 明确标了「风格：」的行：不要求分隔符，但不能是段落标记或一句歌词。
function labeledStyleLine(line) {
  const t = line.trim();
  return !!t && t.length <= 200 && !MARK.test(t) && !/[[\]【】]/.test(t) && !/[。！？!?…]$/.test(t);
}
// 只认一行。
const looksStyle = lines => lines.length === 1 && styleLine(lines[0]);

// 第 4 条用：常见的风格词。认不出就当歌词（宁可风格留空，之后在项目音乐里补）。单个汉字、容易出现在歌词里的词（鼓、笛、节奏）不放进来。
const STYLE_EN = /\b(?:pop|rock|folk|jazz|blues|soul|r&b|rnb|hip[- ]?hop|rap|trap|edm|house|techno|trance|electronic|electro|synth\w*|lo-?fi|ambient|chill\w*|acoustic|ballad|orchestral|cinematic|classical|piano|guitars?|bass|drums|strings|violin|cello|sax(?:ophone)?|vocals?|female|male|choir|bpm|tempo|upbeat|mellow|dreamy|epic|indie|punk|metal|country|reggae|funk|disco|[kjc]-?pop|anime|gospel|latin|bossa|swing|beats?|instrumental|duet|falsetto|808)\b/i;
const STYLE_ZH = /流行|摇滚|民谣|爵士|蓝调|说唱|嘻哈|电子|电音|国风|古风|中国风|抒情|慢板|快板|钢琴|吉他|贝斯|弦乐|小提琴|大提琴|二胡|古筝|琵琶|女声|男声|合唱|人声|氛围|轻音乐|纯音乐|治愈|伤感|欢快|史诗|管弦|交响|慢歌|情歌|戏腔|唢呐|笛子|鼓点/;
// 歌词里才常见的字词：有它就不当风格。
const LYRIC_ZH = /[我你他她吗呢吧啊了]/;
const LYRIC_EN = /\b(?:i|i'm|i'll|me|my|mine|you|you're|your|we|our|us|he|she|they|them|don't|can't|won't|oh|baby|love)\b/i;
function styleParagraphLine(line) {
  const t = line.trim();
  if (!styleLine(t) || LYRIC_ZH.test(t) || LYRIC_EN.test(t)) return false;
  const parts = t.split(SEP).map(x => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.some(x => x.length > 30)) return false;
  return parts.filter(x => STYLE_EN.test(x) || STYLE_ZH.test(x)).length >= 2;
}
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
    // 标了「风格」但内容像歌词（有段落标记、句子、行数多）：拆不准，全部放进歌词。
    if (styleLines.length && !styleLines.every(labeledStyleLine) || styleLines.length > 3 || styleLines.length > 1 && !styleLines.every(styleLine)) return {style: '', lyrics: raw, params: '', how: 'unsure'};
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
  if (looksStyle(nonEmpty)) return {style: nonEmpty[0].trim(), lyrics: '', params: '', how: 'style-only'};
  // 第 4 条：第一行、紧跟空行、后面还有内容。
  if (lines.length >= 3 && !lines[1].trim() && lines.slice(2).some(l => l.trim()) && styleParagraphLine(lines[0]))
    return {style: lines[0].trim(), lyrics: clean(lines.slice(1)), params: '', how: 'style-paragraph'};
  return {style: '', lyrics: raw, params: '', how: 'unsure'};
}

// 拆标签前的保险：带方括号的词（段落标记）一律不当标签。
export const isMarkerToken = token => /[[\]【】［］]/.test(token);
