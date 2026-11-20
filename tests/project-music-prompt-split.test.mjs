// 粘贴的 Suno 提示词拆成风格和歌词（验收 PR5 P3-1）：只有风格拆成标签，歌词和段落标记绝不变成标签。
import test from 'node:test';
import assert from 'node:assert/strict';
import {splitSunoPrompt} from '../server/project-music/shared/prompt-split.mjs';
import {promptTags} from '../server/project-music/model.mjs';

const cases = [
  ['只有风格', '中国风流行, 女声, 慢板', {style: '中国风流行, 女声, 慢板', lyrics: ''}],
  ['只有风格（英文、空格分）', 'dreamy synth pop female vocal 90 bpm', {style: 'dreamy synth pop female vocal 90 bpm', lyrics: ''}],
  ['风格加歌词（空行隔开）', '中国风, 女声\n\n雨巷里的油纸伞\n丁香一样的姑娘', {style: '中国风, 女声', lyrics: '雨巷里的油纸伞\n丁香一样的姑娘'}],
  ['带 [Intro] [Verse] [Chorus] [Bridge]', 'dreamy pop, piano\n[Intro]\n[Verse]\nwalking home alone\n[Chorus]\nla la la\n[Bridge]\nhold on', {style: 'dreamy pop, piano', lyrics: '[Intro]\n[Verse]\nwalking home alone\n[Chorus]\nla la la\n[Bridge]\nhold on'}],
  ['中英混排', '国风 electronic, female vocal 女声\n[Verse 1]\n月光照在 old street\n[Chorus]\nla la 啦啦', {style: '国风 electronic, female vocal 女声', lyrics: '[Verse 1]\n月光照在 old street\n[Chorus]\nla la 啦啦'}],
  ['全角括号的段落标记', '民谣, 吉他\n【主歌】\n风吹过麦田\n【副歌】\n我们回家', {style: '民谣, 吉他', lyrics: '【主歌】\n风吹过麦田\n【副歌】\n我们回家'}],
  ['带标题（Suno 复制格式）', 'Style of Music: lo-fi, piano, rain\nLyrics:\n[Verse]\n第一句\n第二句', {style: 'lo-fi, piano, rain', lyrics: '[Verse]\n第一句\n第二句'}],
  ['中文标题', '风格：中国风，女声\n歌词：\n[主歌]\n雨巷', {style: '中国风，女声', lyrics: '[主歌]\n雨巷'}],
  ['只有段落标记和歌词', '[Verse]\n雨巷里的油纸伞\n[Chorus]\n丁香一样的姑娘', {style: '', lyrics: '[Verse]\n雨巷里的油纸伞\n[Chorus]\n丁香一样的姑娘'}],
  ['拆不准：多行没有标记', '雨巷里的油纸伞\n丁香一样的姑娘\n结着愁怨', {style: '', lyrics: '雨巷里的油纸伞\n丁香一样的姑娘\n结着愁怨'}],
  ['拆不准：标记前是好几行', '第一行歌词\n第二行歌词\n第三行歌词\n[Chorus]\n副歌', {style: '', lyrics: '第一行歌词\n第二行歌词\n第三行歌词\n[Chorus]\n副歌'}],
  ['一句歌词（句号结尾）', '丁香一样的姑娘。', {style: '', lyrics: '丁香一样的姑娘。'}],
];

for (const [name, text, want] of cases) {
  test('拆分 · ' + name, () => {
    const got = splitSunoPrompt(text);
    assert.equal(got.style, want.style);
    assert.equal(got.lyrics, want.lyrics);
    // 只拿风格拆标签：歌词里的句子和段落标记都不会出现
    const tags = promptTags(got.style);
    for (const line of want.lyrics.split('\n').filter(Boolean)) assert.ok(!tags.includes(line.trim()), `歌词「${line}」变成了标签`);
    assert.ok(tags.every(t => !/[[\]【】]/.test(t)), '段落标记变成了标签：' + tags);
  });
}

test('拆标签的保险：风格里混进了段落标记，也不当标签', () => {
  assert.deepEqual(promptTags('流行, [Verse], 女声'), ['流行', '女声']);
});
