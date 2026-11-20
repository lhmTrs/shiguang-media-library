// 第一个内置来源：项目音乐「待 AI 补写」，作为只是告知的卡片。
// 从访达收纳开新一轮时，上一轮的「问题整理」「下一轮方向」等 AI 补写（PROJECT_MUSIC.md「待补写」清单）。
// 拾光读待处理时对一次：清单里有的放卡（同一轮只一张），AI 补完了、清单里没有了，卡片自动结掉进「已结束」。
const MISSING = {issues: '问题整理', nextDirection: '下一轮方向'};

export function projectMusicSource(music) {
  return {
    label: '项目音乐',
    list: () => music.pendingNotes().items.map(i => ({
      key: i.roundId, kind: 'info', typeLabel: '待 AI 补写',
      title: `${i.projectName} · ${i.songTitle} · 第 ${i.roundNo} 轮`,
      context: `还缺${i.missing.map(m => MISSING[m] ?? m).join('、')}。${i.reason ? i.reason + '，' : ''}这一轮的记录由 AI 补写，你不用管；补完了这张卡会自动结束。`,
      links: [{label: '看这首歌', view: 'projectMusic', projectId: i.projectId}],
      occurredAt: Number.isSafeInteger(i.since) ? i.since : undefined,
    })),
    gone: roundId => {
      try {
        const row = music.db.prepare('SELECT data_json FROM project_music_rounds WHERE id=?').get(roundId);
        if (!row) return '这一轮已经不在了';
        const d = JSON.parse(row.data_json);
        const filled = (d.issues?.items?.length || d.userIssues?.text?.trim()) && (d.nextDirection?.text?.trim() || d.userDirection?.text?.trim());
        return filled ? '记录已经补完了' : '这一轮已经不在待补写清单里';
      } catch {
        return '这一轮已经不在待补写清单里';
      }
    },
  };
}
