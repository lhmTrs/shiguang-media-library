// 粘贴的 Suno 提示词拆成风格和歌词（验收 PR5 P3-1）：只有风格拆成标签，歌词和段落标记绝不变成标签。
import test from 'node:test';
import assert from 'node:assert/strict';
import {splitSunoPrompt} from '../server/project-music/shared/prompt-split.mjs';
import {promptTags} from '../server/project-music/model.mjs';

// 验收 PR5 复验造的 14 段（前 9 段原来就对，后 5 段原来把歌词当成了风格），加上作者自己的几段。
// 规则：没有段落标记也没有标题时，只有「一行、带分隔符」才算风格；段落标记之前也一样；拆不准整段算歌词。
// 合并后补了规则 4：「第一行、空一行、后面是歌词」时，第一行要更像风格（至少两段带风格词、没有我/你/me/you 这类词）才算风格。
const L = '雨巷里的油纸伞\n丁香一样的姑娘';
const cases = [
  // ---- 验收 14 段 ----
  ['验收 1：中英混排加 [Verse 1] [Chorus]', '国风 electronic, female vocal\n[Verse 1]\n月光照在 old street\n[Chorus]\nla la 啦啦', {style: '国风 electronic, female vocal', lyrics: '[Verse 1]\n月光照在 old street\n[Chorus]\nla la 啦啦'}],
  ['验收 2：全角【主歌】【副歌】，风格用斜杠', '民谣/吉他/男声\n【主歌】\n风吹过麦田\n【副歌】\n我们回家', {style: '民谣/吉他/男声', lyrics: '【主歌】\n风吹过麦田\n【副歌】\n我们回家'}],
  ['验收 3（规则 4 改了预期）：风格带逗号斜杠，空一行接歌词', '流行, 女声/钢琴\n\n' + L, {style: '流行, 女声/钢琴', lyrics: L}],
  ['验收 4：Style of Music / Lyrics 标题', 'Style of Music: lo-fi, piano, rain\nLyrics:\n[Verse]\n第一句\n第二句', {style: 'lo-fi, piano, rain', lyrics: '[Verse]\n第一句\n第二句'}],
  ['验收 5：Style / Exclude styles / Lyrics 标题', 'Style: pop, piano\nExclude styles: rock, metal\nLyrics:\n[Verse]\nhello world', {style: 'pop, piano', lyrics: '[Verse]\nhello world', params: 'Exclude styles: rock, metal'}],
  ['验收 6：歌词里出现「风格：」，有标记', '[Verse]\n风格：随风\n漂泊在远方\n[Chorus]\n回到故乡', {style: '', lyrics: '[Verse]\n风格：随风\n漂泊在远方\n[Chorus]\n回到故乡'}],
  ['验收 7：歌词里出现「风格：」，没有标记', '风格：随风\n漂泊在远方\n回到故乡', {style: '', lyrics: '风格：随风\n漂泊在远方\n回到故乡'}],
  ['验收 8：只有一行风格', '中国风流行, 女声, 慢板', {style: '中国风流行, 女声, 慢板', lyrics: ''}],
  ['验收 9：只有段落标记和歌词', '[Verse]\n' + L.split('\n')[0] + '\n[Chorus]\n' + L.split('\n')[1], {style: '', lyrics: '[Verse]\n雨巷里的油纸伞\n[Chorus]\n丁香一样的姑娘'}],
  ['验收 10：纯中文歌词带逗号，没有标记', '月光洒在窗前，我想起了你\n风吹过的街道，只剩下我', {style: '', lyrics: '月光洒在窗前，我想起了你\n风吹过的街道，只剩下我'}],
  ['验收 11：同上，再空一行接第二段', '月光洒在窗前，我想起了你\n风吹过的街道，只剩下我\n\n星星落在海里，像你的眼睛', {style: '', lyrics: '月光洒在窗前，我想起了你\n风吹过的街道，只剩下我\n\n星星落在海里，像你的眼睛'}],
  ['验收 12：英文歌词，空行分段', 'Walking down the empty road\nI hear you call my name\n\nAnd the night is long\nStars are falling down', {style: '', lyrics: 'Walking down the empty road\nI hear you call my name\n\nAnd the night is long\nStars are falling down'}],
  ['验收 13：英文歌词两行', 'Hold me close tonight\nNever let me go', {style: '', lyrics: 'Hold me close tonight\nNever let me go'}],
  ['验收 14：[Verse] 前面两行「Baby baby」「Oh oh oh」', 'Baby baby\nOh oh oh\n[Verse]\nI was waiting', {style: '', lyrics: 'Baby baby\nOh oh oh\n[Verse]\nI was waiting'}],
  // ---- 作者自己的 ----
  ['只有风格（英文，逗号分）', 'dreamy synth pop, female vocal, 90 bpm', {style: 'dreamy synth pop, female vocal, 90 bpm', lyrics: ''}],
  ['只有一行但没有分隔符：不猜，算歌词', 'dreamy synth pop female vocal', {style: '', lyrics: 'dreamy synth pop female vocal'}],
  ['带 [Intro] [Verse] [Chorus] [Bridge]', 'dreamy pop, piano\n[Intro]\n[Verse]\nwalking home alone\n[Chorus]\nla la la\n[Bridge]\nhold on', {style: 'dreamy pop, piano', lyrics: '[Intro]\n[Verse]\nwalking home alone\n[Chorus]\nla la la\n[Bridge]\nhold on'}],
  ['中文标题', '风格：中国风，女声\n歌词：\n[主歌]\n雨巷', {style: '中国风，女声', lyrics: '[主歌]\n雨巷'}],
  ['标题里的风格只有一个词', 'Style: lo-fi\nLyrics:\n[Verse]\nhello', {style: 'lo-fi', lyrics: '[Verse]\nhello'}],
  ['一句歌词（句号结尾，带逗号）', '月光洒在窗前，我想起了你。', {style: '', lyrics: '月光洒在窗前，我想起了你。'}],
  // ---- 规则 4：第一行、空一行、后面是歌词（合并后补的） ----
  ['规则 4：英文风格一行、空一行、英文歌词', 'dreamy synth pop, female vocal, 90 bpm\n\nWalking down the empty road\nI hear you call my name', {style: 'dreamy synth pop, female vocal, 90 bpm', lyrics: 'Walking down the empty road\nI hear you call my name'}],
  ['规则 4：中文风格用全角逗号，空两行接歌词', '中国风流行，女声，古筝\n\n\n' + L, {style: '中国风流行，女声，古筝', lyrics: L}],
  ['规则 4：风格里有「吉他」（「他」是风格词的一部分，不算歌词字）', '民谣，吉他，男声\n\n' + L, {style: '民谣，吉他，男声', lyrics: L}],
  ['规则 4：只有两段也行（国风 electronic, female vocal）', '国风 electronic, female vocal\n\n' + L, {style: '国风 electronic, female vocal', lyrics: L}],
  ['规则 4 不算：一句带逗号的中文歌词、空一行接歌词', '月光洒在窗前，我想起了你\n\n风吹过的街道，只剩下我', {style: '', lyrics: '月光洒在窗前，我想起了你\n\n风吹过的街道，只剩下我'}],
  ['规则 4 不算：英文歌词带逗号', 'Baby, I love you\n\nCome back to me tonight', {style: '', lyrics: 'Baby, I love you\n\nCome back to me tonight'}],
  ['规则 4 不算：两段都带风格词（rock、guitar）的英文歌词，但有 me、my', 'Rock the boat, me and my old guitar\n\nDance until the sun comes up', {style: '', lyrics: 'Rock the boat, me and my old guitar\n\nDance until the sun comes up'}],
  ['规则 4 不算：只有一段带风格词（跟着鼓点，摇摆）', '跟着鼓点，摇摆\n\n' + L, {style: '', lyrics: '跟着鼓点，摇摆\n\n' + L}],
  ['规则 4 不算：中文歌词里带「吉他」「摇滚」，但有语气词', '摇滚吧，青春的吉他\n\n' + L, {style: '', lyrics: '摇滚吧，青春的吉他\n\n' + L}],
  ['规则 4 不算：第一行没有分隔符', 'dreamy synth pop female vocal\n\n' + L, {style: '', lyrics: 'dreamy synth pop female vocal\n\n' + L}],
  ['规则 4 不算：第一行后面没有空行（多行一律算歌词）', '流行, 女声/钢琴\n' + L, {style: '', lyrics: '流行, 女声/钢琴\n' + L}],
  ['规则 4 不算：风格词是两段，但第一段两行', '流行, 女声\n钢琴, 慢板\n\n' + L, {style: '', lyrics: '流行, 女声\n钢琴, 慢板\n\n' + L}],
  // ---- 规则 4 收紧（PR #142 独验 P2-1）：每段都要能被风格词表完全解释；下面的歌词第一行（独验编的难例）不能当风格 ----
  ['规则 4 不算（独验难例）：古风长街，琵琶声声慢', '古风长街，琵琶声声慢\n\n' + L, {style: '', lyrics: '古风长街，琵琶声声慢\n\n' + L}],
  ['规则 4 不算（独验难例）：二胡声声，唢呐长鸣', '二胡声声，唢呐长鸣\n\n' + L, {style: '', lyrics: '二胡声声，唢呐长鸣\n\n' + L}],
  ['规则 4 不算（独验难例）：伤感的夜，治愈的风', '伤感的夜，治愈的风\n\n' + L, {style: '', lyrics: '伤感的夜，治愈的风\n\n' + L}],
  ['规则 4 不算（独验难例）：摇滚不死，民谣不老', '摇滚不死，民谣不老\n\n' + L, {style: '', lyrics: '摇滚不死，民谣不老\n\n' + L}],
  ['规则 4 不算（独验难例）：爵士酒馆，蓝调长夜', '爵士酒馆，蓝调长夜\n\n' + L, {style: '', lyrics: '爵士酒馆，蓝调长夜\n\n' + L}],
  ['规则 4 不算（独验难例）：Pop the bottle, feel the beat tonight', 'Pop the bottle, feel the beat tonight\n\n' + L, {style: '', lyrics: 'Pop the bottle, feel the beat tonight\n\n' + L}],
  ['规则 4 不算（独验难例）：Jazz in the rain, blues at dawn', 'Jazz in the rain, blues at dawn\n\n' + L, {style: '', lyrics: 'Jazz in the rain, blues at dawn\n\n' + L}],
  ['规则 4 不算（独验难例）：Strings of fate, drums of war', 'Strings of fate, drums of war\n\n' + L, {style: '', lyrics: 'Strings of fate, drums of war\n\n' + L}],
  ['规则 4 不算（独验难例）：Latin heat, summer nights', 'Latin heat, summer nights\n\n' + L, {style: '', lyrics: 'Latin heat, summer nights\n\n' + L}],
  ['规则 4 不算（独验难例）：月光 piano，晚风 guitar', '月光 piano，晚风 guitar\n\n' + L, {style: '', lyrics: '月光 piano，晚风 guitar\n\n' + L}],
  ['规则 4 不算（独验难例）：Hip hop 少年，街头 rap', 'Hip hop 少年，街头 rap\n\n' + L, {style: '', lyrics: 'Hip hop 少年，街头 rap\n\n' + L}],
  ['规则 4 不算（独验难例）：古风雨，琵琶情', '古风雨，琵琶情\n\n' + L, {style: '', lyrics: '古风雨，琵琶情\n\n' + L}],
  ['规则 4 不算（独验难例）：Epic night, chill vibes', 'Epic night, chill vibes\n\n' + L, {style: '', lyrics: 'Epic night, chill vibes\n\n' + L}],
  ['规则 4：修饰词、对唱、年代和速度也能解释掉：acoustic, warm, intimate', "acoustic, warm, intimate\n\n" + L, {style: "acoustic, warm, intimate", lyrics: L}],
  ['规则 4：修饰词、对唱、年代和速度也能解释掉：温柔女声，钢琴', "温柔女声，钢琴\n\n" + L, {style: "温柔女声，钢琴", lyrics: L}],
  ['规则 4：修饰词、对唱、年代和速度也能解释掉：情歌，男女对唱，吉他', "情歌，男女对唱，吉他\n\n" + L, {style: "情歌，男女对唱，吉他", lyrics: L}],
  ["规则 4：修饰词、对唱、年代和速度也能解释掉：80's synth pop, female vocals, 120bpm", "80's synth pop, female vocals, 120bpm\n\n" + L, {style: "80's synth pop, female vocals, 120bpm", lyrics: L}],
  // ---- 规则 4 的前置条件（独验 P3）----
  ['规则 4 不算：第一行以句号结尾', '流行，钢琴。\n\n' + L, {style: '', lyrics: '流行，钢琴。\n\n' + L}],
  ['规则 4 不算：有一段超过 30 字（哪怕全是风格词）', 'pop rock folk jazz blues soul piano guitar, female vocal\n\n' + L, {style: '', lyrics: 'pop rock folk jazz blues soul piano guitar, female vocal\n\n' + L}],
];

for (const [name, text, want] of cases) {
  test('拆分 · ' + name, () => {
    const got = splitSunoPrompt(text);
    assert.equal(got.style, want.style);
    assert.equal(got.lyrics, want.lyrics);
    if (want.params !== undefined) assert.equal(got.params, want.params);
    // 只拿风格拆标签：歌词里的句子和段落标记都不会出现
    const tags = promptTags(got.style);
    // 歌词里任何一行、任何一个词都不能变成标签（除非它本来就出现在风格里）
    const styleWords = new Set(promptTags(want.style));
    for (const word of promptTags(want.lyrics.replace(/\n/g, ' '))) if (!styleWords.has(word)) assert.ok(!tags.includes(word), `歌词里的「${word}」变成了标签：${tags}`);
    assert.ok(tags.every(t => !/[[\]【】]/.test(t)), '段落标记变成了标签：' + tags);
  });
}

test('拆标签的保险：风格里混进了段落标记，也不当标签', () => {
  assert.deepEqual(promptTags('流行, [Verse], 女声'), ['流行', '女声']);
});
