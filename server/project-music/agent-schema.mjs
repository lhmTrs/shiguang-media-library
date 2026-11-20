// GET /api/project-music/schema：给 AI 看的字段规则（SPEC 3.3、3.5）。项目使用说明只放三行入口，细节在这里。
export const AGENT_SCHEMA = {
  version: '2026-11-20.2',
  comparisons: '对比结果在每轮的 comparisons 里（只读）：left/right 是两个版本，winner 和 segments[].winner 取 left、right、same；blind 表示当时是盲听。对比结果只能由用户在页面上记录。',
  read: {
    list: 'GET /api/project-music/projects/<projectId> → songs[].rounds[].versions[]；每轮带 revision、missing（开新一轮前还缺的字段）',
    download: 'GET /api/project-music/projects/<projectId>/versions/<versionId>/media，支持 Range；加 ?download=1 带规范文件名。文件身份变了返回 409 MUSIC_FILE_CHANGED，不要重试成别的文件',
  },
  agentNotes: {
    request: 'PATCH /api/project-music/projects/<projectId>/rounds/<roundId>/agent-notes',
    rules: [
      '只能写 changes、issues、checks、nextDirection、lyricTimes，以及追加 listeningTranscripts；带 expectedRevision（读取时该轮的 revision）和 session（你的会话名）。',
      '其他字段（prompt、listening、status、bestVersionId、sunoTier 等）整次拒绝：403 AGENT_FIELD_FORBIDDEN，不会部分写入。',
      'expectedRevision 不是最新时返回 409 REVISION_CONFLICT：重新读取，确认用户没改过同一处，再写。',
      'issues.items[].source 必填：user_words（来自用户原话）或 objective_check（来自客观检查）。原因写进 causeGuess，页面会标为「猜测」，不要写成定论。',
      'checks.items[] 每项都要写 method（怎么检查的）；没检查的项不要写，页面会显示「未检查」。',
      'nextDirection 页面标为「建议」；promptDraft 只是草稿，用户开新一轮时确认后才生效。',
      'listeningTranscripts 只用于把用户在对话里说的听感逐字转录进来：verbatim 必须为 true，text 一字不改；saidAt 写用户说这句话的北京时间，格式 YYYY-MM-DD HH:mm，查不到就不写。页面会注明是哪个会话、什么时间转录的。',
      'lyricTimes 给对比页用：按版本写歌词每句的开始时间（毫秒，非递减），并写 method 说明怎么得出的（例如人工听写、某工具识别）。只能写这一轮的版本；没有把握就不写。',
      'userIssues、userDirection 是用户自己写的问题整理和下一轮方向，AI 不能写；「先补上一轮」只看问题整理和下一轮方向是否为空，AI 写的或用户写的任一有内容即可。',
      'AI 不能删除版本，不能改版本状态（淘汰、当前最好、定稿），也不能改用户的听感原文。',
      '只能由用户在网页上做的操作（PATCH …/rounds/<id>、PATCH …/versions/<id>、PATCH …/songs/<id>、定稿与撤回定稿）要求浏览器自带的 Sec-Fetch-Site: same-origin。AI 不得伪造这个请求头，也不得调用这些接口；这条限制是防误用约定，不是技术上的安全边界。',
    ],
    example: {
      expectedRevision: 3,
      session: '<你的会话名>',
      changes: {text: '把风格里的「古风」换成「中国风流行」，其余不变', count: 1},
      issues: {items: [
        {text: '副歌唱腔偏戏曲', source: 'user_words', causeGuess: '可能和「古风」这个词有关'},
        {text: '第 2 句歌词含糊', source: 'objective_check', causeGuess: ''},
      ]},
      checks: {items: [{item: 'duration', versionId: null, result: 'A 3:12，B 3:05', method: '读取版本 durationMs'}]},
      nextDirection: {text: '只改风格一处：古风 → 中国风流行', promptDraft: {style: '中国风流行 女声 慢板', lyrics: '', params: ''}},
      listeningTranscripts: {verbatim: true, entries: [{text: '<用户原话，逐字>', saidAt: '2026-11-20 11:30'}]},
      lyricTimes: [{versionId: '<这一轮某个版本的 id>', method: '<怎么得出的>', lines: [{text: '第一句', startMs: 12500}, {text: '第二句', startMs: 17800}]}],
    },
  },
  newRound: {
    request: 'POST /api/project-music/projects/<projectId>/songs/<songId>/rounds，body {requestId: 新UUID, session, prompt:{tool, style, lyrics, params, sunoLink?}}',
    rules: [
      '上一轮的「问题整理」(issues) 和「下一轮方向」(nextDirection) 没填时返回 409 PREVIOUS_ROUND_INCOMPLETE（先补上一轮）。',
      'AI 开的新一轮，提示词显示为「AI 起草，待你确认」，用户确认后才算数。',
      'prompt 里不能带 sunoTier（Suno 会员档位）：带了整次 403 AGENT_FIELD_FORBIDDEN。AI 开的轮次档位留空，由用户在页面上填。',
      'prompt.sunoLink 可以由 AI 带，页面会标「AI 填」。',
    ],
  },
  upload: {
    steps: [
      'POST /api/project-music/projects/<projectId>/imports {requestId, roundId, fileName, bytes, label?, session}',
      'PUT …/imports/<requestId>/content，Content-Type: application/octet-stream，请求体是文件原始字节',
      '回执 duplicate 表示项目里已有同内容版本：POST …/imports/<requestId>/resolve {choice:"keep"|"cancel"}，由用户决定',
    ],
    limits: '只收 mp3、wav、m4a、flac；单个文件不超过 200MB。响应丢失时用 GET …/imports/<requestId> 查原回执，不要重发字节。',
  },
};
