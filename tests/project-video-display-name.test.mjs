import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeFilePrefix, prefixForProject, shortVideoName} from '../src/project-videos/display-name.mjs';

const series = [{id: 's1', name: '穿越计', seasons: [{id: 'q2', season_no: 2}]}, {id: 's2', name: 'a/b: 剧 ', seasons: []}];

test('episode prefix follows the intake naming rule', () => {
  assert.equal(episodeFilePrefix('穿越计', 2, 5), '穿越计S02E05_');
  assert.equal(episodeFilePrefix('穿越计', null, 12), '穿越计EP12_');
  assert.equal(episodeFilePrefix('穿越计', 1, 100), '穿越计S01E100_');
  assert.equal(episodeFilePrefix('a/b: 剧 ', null, 3), 'a-b- 剧-EP03_');
  assert.equal(episodeFilePrefix('', 1, 1), null);
});

test('prefix for a project needs a real series place', () => {
  assert.equal(prefixForProject({series_id: 's1', season_id: 'q2', episode_no: 5}, series), '穿越计S02E05_');
  assert.equal(prefixForProject({series_id: 's1', season_id: null, episode_no: 7}, series), '穿越计EP07_');
  assert.equal(prefixForProject({series_id: null, episode_no: null}, series), null);
  assert.equal(prefixForProject({series_id: 's1', season_id: 'gone', episode_no: 5}, series), null);
  assert.equal(prefixForProject({series_id: 'missing', episode_no: 5}, series), null);
  assert.equal(prefixForProject(undefined, series), null);
});

test('only names starting with this episode prefix are shortened', () => {
  const p = '穿越计S02E05_';
  assert.equal(shortVideoName('穿越计S02E05_A_001.mov', p), 'A_001.mov');
  assert.equal(shortVideoName('穿越计s02e05_A_补拍_002.mov', p), 'A_补拍_002.mov');
  assert.equal(shortVideoName('dy_0612_2241.mov', p), 'dy_0612_2241.mov');
  assert.equal(shortVideoName('穿越计S03E01_A_001.mov', p), '穿越计S03E01_A_001.mov');
  assert.equal(shortVideoName('穿越计S02E05_', p), '穿越计S02E05_');
  assert.equal(shortVideoName('穿越计S02E05_A_001.mov', null), '穿越计S02E05_A_001.mov');
});
