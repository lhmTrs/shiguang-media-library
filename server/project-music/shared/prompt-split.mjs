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
// 为了不把一句带逗号的歌词当成风格，第 4 条比第 3 条严：每一段都要能被风格词表完全解释（曲风、乐器、人声、速度，加上情绪、音色这类修饰词和数字），至少一段有曲风、乐器、人声、速度词，并且没有我、你、me、you 这类歌词里才有的字词。
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

// 第 4 条用的词表。认不出就当歌词（宁可风格留空，之后在项目音乐里补）。
// 核心词：曲风、乐器、人声、速度。修饰词：情绪、音色这类形容词，歌词里也常见，所以只用来「解释掉」一段里的字，不算风格的证据。
const STYLE_EN = /\b(?:pop|rock|folk|jazz|blues|soul|r&b|rnb|hip[- ]?hop|rap|trap|edm|house|techno|trance|electronic|electro|synth\w*|lo-?fi|ambient|acoustic|ballad|orchestral|cinematic|classical|piano|guitars?|bass|drums|strings|violin|cello|sax(?:ophone)?|vocals?|female|male|choir|bpm|tempo|indie|punk|metal|country|reggae|funk|disco|[kjc]-?pop|anime|gospel|latin|bossa|swing|beats?|instrumental|duet|falsetto|808|mandarin|cantonese|cantopop|mandopop|guzheng|erhu|pipa|dizi|suona)\b/i;
const STYLE_EN_MOD = /\b(?:dreamy|mellow|epic|upbeat|chill\w*|warm|intimate|melanchol(?:ic|y)|slow|fast|soft|dark|bright|sad|happy|deep|heavy|light|catchy|emotional|powerful|gentle|smooth|raw|lush|ethereal|atmospheric|groovy|energetic|uplifting|haunting|nostalgic|romantic|moody|cozy|minimal|modern|retro|vintage|live|clean|distorted|reverb|airy|breathy|mid-?tempo|driving|punchy|layered|sparse|chinese|oriental|style)\b/gi;
const STYLE_ZH = /中国风|男女对唱|普通话|闽南语|粤语|国语|伴奏|弹唱|电吉他|木吉他|架子鼓|流行|摇滚|民谣|爵士|蓝调|说唱|嘻哈|电子|电音|舞曲|国风|古风|古典|抒情|慢板|快板|中速|慢速|快速|钢琴|吉他|贝斯|弦乐|小提琴|大提琴|二胡|古筝|琵琶|唢呐|笛子|鼓点|女声|男声|童声|合唱|和声|对唱|独唱|吟唱|人声|轻音乐|纯音乐|器乐|民乐|管弦|交响|慢歌|情歌|戏腔/;
const STYLE_ZH_MOD = /温柔|空灵|深情|清新|甜美|低沉|沙哑|轻快|舒缓|激昂|磅礴|大气|悠扬|动感|浪漫|忧郁|悲伤|伤感|治愈|欢快|史诗|氛围|热血|复古|梦幻|轻柔|柔和|明亮|暗黑|唯美|宏大|空旷|安静|慵懒|俏皮|可爱|中式|东方|乐|曲/g;
const STYLE_EN_ALL = new RegExp(STYLE_EN.source, 'gi');
const STYLE_ZH_ALL = new RegExp(STYLE_ZH.source, 'g');
// 歌词里才常见的字词：有它就不当风格。
const LYRIC_ZH = /[我你他她吗呢吧啊了]/;
const LYRIC_EN = /\b(?:i|i'm|i'll|me|my|mine|you|you're|your|we|our|us|he|she|they|them|don't|can't|won't|oh|baby|love)\b/i;
// 一段去掉核心词、修饰词、数字、连接词以后，还剩几个字符、几个英文词。剩下的就是“说不清是不是风格”的内容。
function leftover(part) {
  const r = part.toLowerCase().replace(/\d+(?:'?s\b)?/g, ' ')
    .replace(STYLE_ZH_ALL, ' ').replace(STYLE_ZH_MOD, ' ').replace(/的/g, ' ')
    .replace(STYLE_EN_ALL, ' ').replace(STYLE_EN_MOD, ' ').replace(/\b(?:and|with)\b|[&+\-–—·.'"()]/g, ' ');
  // 英文按词数；其余凡是不是空白、标点、a-z 的字符（汉字、假名、韩文、俄文、♪ 这类符号）都按个数算（PR #142 复验 P3-3）。
  return {other: (r.match(/[^\sa-z\p{P}]/gu) || []).length, en: (r.match(/[a-z]+/g) || []).length};
}
// 第 4 条：每一段都要能被词表完全解释（一个字、一个词都不剩），并且至少一段有核心词。
// 只看“含不含风格词”会把「古风长街，琵琶声声慢」「Jazz in the rain, blues at dawn」这类歌词当成风格（PR #142 独验 P2-1）。
function styleParagraphLine(line) {
  const t = line.trim();
  // 先去掉认得出的风格词再查歌词字：「吉他」里有「他」，不能因此当成歌词。
  if (!styleLine(t) || LYRIC_ZH.test(t.replace(STYLE_ZH_ALL, '')) || LYRIC_EN.test(t)) return false;
  const parts = t.split(SEP).map(x => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.some(x => x.length > 30)) return false;
  if (!parts.every(x => { const r = leftover(x); return r.other === 0 && r.en === 0; })) return false;
  return parts.some(x => STYLE_EN.test(x) || STYLE_ZH.test(x));
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
