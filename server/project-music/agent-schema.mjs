import {platformWords} from '../platform-words.mjs';
// GET /api/project-music/schema：给 AI 看的字段规则（SPEC 3.3、3.5）。项目使用说明只放三行入口，细节在这里。
export const AGENT_SCHEMA = {
  version: '2026-11-20.5',
  library: '每个版本都在音乐库里（根目录「AI生成」，主类是项目，子类是「歌曲」），versions[].library.assetId 是全库素材 ID。标签由服务端写：AI生成、项目名、歌名、第N轮、按提示词从风格拆出的词、测量结果，被淘汰的标「未选用（项目名）」。AI 不要自己调批量标注去改这些标签；不要打听感类标签（比如情绪），除非是用户原话。',
  comparisons: '对比结果在每轮的 comparisons 里（只读）：left/right 是两个版本，winner 和 segments[].winner 取 left、right、same；blind 表示当时是盲听。对比结果只能由用户在页面上记录。',
  read: {
    list: 'GET /api/project-music/projects/<projectId> → songs[].rounds[].versions[]；每轮带 revision、missing（开新一轮前还缺的字段）',
    download: 'GET /api/project-music/projects/<projectId>/versions/<versionId>/media，支持 Range；加 ?download=1 带规范文件名。文件身份变了返回 409 MUSIC_FILE_CHANGED，不要重试成别的文件',
  },
  agentNotes: {
    request: 'PATCH /api/project-music/projects/<projectId>/rounds/<roundId>/agent-notes',
    rules: [
      '只能写 changes、issues、checks、nextDirection、lyricTimes、measurements、decisions，以及追加 listeningTranscripts；带 expectedRevision（读取时该轮的 revision）和 session（你的会话名）。',
      '其他字段（prompt、listening、status、bestVersionId、sunoTier 等）整次拒绝：403 AGENT_FIELD_FORBIDDEN，不会部分写入。',
      'measurements 写你实际测过的速度（bpm）、时长（durationMs）、有没有人声（vocals: vocal | instrumental）、语种（language），必须写 method；服务端据此生成「测量」标签（「120 BPM」「时长 3:12」「有人声」「中文」）并写进音乐库。没测的项不要写。',
      'decisions 只在用户在对话里明确说了时才写：action 为 reject（淘汰）、restore（恢复为候选）、best（设为当前最好）、final（定稿，加入本项目候选）；userWords 必填，写用户原话、一字不改；saidAt 写用户说这句话的北京时间（YYYY-MM-DD HH:mm），查不到就不写。页面会标「AI 改的」并显示原话，用户可以一键改回。淘汰当前最好会让当前最好空出来；定稿版不能淘汰。',
      'expectedRevision 不是最新时返回 409 REVISION_CONFLICT：重新读取，确认用户没改过同一处，再写。',
      'issues.items[].source 必填：user_words（来自用户原话）或 objective_check（来自客观检查）。原因写进 causeGuess，页面会标为「猜测」，不要写成定论。',
      'checks.items[] 每项都要写 method（怎么检查的）；没检查的项不要写，页面会显示「未检查」。',
      'nextDirection 页面标为「建议」；promptDraft 只是草稿，用户开新一轮时确认后才生效。',
      'listeningTranscripts 只用于把用户在对话里说的听感逐字转录进来：verbatim 必须为 true，text 一字不改；saidAt 写用户说这句话的北京时间，格式 YYYY-MM-DD HH:mm，查不到就不写。页面会注明是哪个会话、什么时间转录的。',
      'lyricTimes 给对比页用：按版本写歌词每句的开始时间（毫秒，非递减），并写 method 说明怎么得出的（例如人工听写、某工具识别）。只能写这一轮的版本；没有把握就不写。',
      'userIssues、userDirection 是用户自己写的问题整理和下一轮方向，AI 不能写；「先补上一轮」只看问题整理和下一轮方向是否为空，AI 写的或用户写的任一有内容即可。',
      'AI 不能删除版本，不能改用户的听感原文；改版本状态只能走 decisions，并附用户原话。',
      platformWords('只能由用户在网页上做的操作（PATCH …/rounds/<id>、PATCH …/versions/<id>、PATCH …/songs/<id>、页面上的定稿与撤回定稿、改回 AI 的改动、把旧副本移到废纸篓）要求浏览器自带的 Sec-Fetch-Site: same-origin。AI 不得伪造这个请求头，也不得调用这些接口；这条限制是防误用约定，不是技术上的安全边界。'),
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
      measurements: [{versionId: '<版本 id>', bpm: 92, durationMs: 192000, vocals: 'vocal', language: '中文', method: '<怎么测的，例如 ffprobe 读时长、某工具估速度>'}],
      decisions: [{versionId: '<版本 id>', action: 'best', userWords: '<用户原话，逐字>', saidAt: '2026-11-20 20:01'}],
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
  pendingNotes: {
    request: 'GET /api/project-music/pending-notes（全部项目）或 ?projectId=<项目>：「待补写」清单。开始做项目音乐相关的工作时先看这里',
    why: platformWords('用户从访达右键把新生成的歌收进某首歌时，可以直接开新一轮，不用等上一轮的记录写完；上一轮会标成「待 AI 补写」。分工是用户只管上传，每轮的记录由 AI 写。'),
    rules: [
      '照 items[] 逐条补：用 PATCH …/rounds/<roundId>/agent-notes 写 issues 和 nextDirection（带该条的 revision 作为 expectedRevision）。补完这一条就自动从清单里消失。',
      '依据只用三种：用户在对话里说过的话（原话照录，注明出处，听感用 listeningTranscripts）；你自己听过、测过的结果（标 objective_check，或在 causeGuess 里写成猜测）；两轮提示词之间的差别。',
      '实在没有依据时，由负责这首歌的 AI 会话问用户一句，不替用户编。',
    ],
  },
  files: {
    what: '「文件」区：项目音乐文件夹 personal_item/music/<项目>/ 下用户和 AI 自建的文件夹，用来存放和传递（比如 Suno下载、AI剪辑），没有轮次，也不要求写记录。「歌曲」是系统文件夹，不在这里改。位置一律用相对项目音乐文件夹的路径，比如 "AI剪辑/副歌缩短版.wav"。',
    read: [
      'GET /api/project-music/projects/<projectId>/files?folder=<文件夹>：文件夹树（folders）和这个文件夹里的文件（items）。items[].inSongs 写着这个文件已经加入了哪首歌哪一轮',
      'GET …/files/media?path=<文件>，支持 Range；加 &download=1 带原文件名',
    ],
    write: [
      '建文件夹：POST …/files/folders {parent, name, session}；改名：POST …/files/folders/rename {path, name, session}。不能叫「歌曲」，同一层不能重名（不分大小写）',
      '放文件（比如剪好的版本）：POST …/files/imports {requestId, folder, fileName, bytes, session} → PUT …/files/imports/<requestId>/content（原始字节）。同一文件夹里已有同样内容时回执是 duplicate，由用户决定 POST …/files/imports/<requestId>/resolve {choice:"keep"|"cancel"}',
      '加入歌曲：POST …/files/add-to-song {requestId, path, roundId, label?, session}；文件不挪，新版本复用这条音乐库记录。项目里已有同样内容时返回 409 DUPLICATE_IN_PROJECT，由用户决定要不要带 keep:true 再加',
      '放好以后，在对话里告诉用户放在哪个文件夹、叫什么名字。',
      platformWords('复制给剪辑软件、在访达中显示会动用户的桌面，只能由用户在网页上点（POST …/files/clipboard、…/files/reveal 要求 Sec-Fetch-Site: same-origin）。'),
    ],
  },
  upload: {
    steps: [
      'POST /api/project-music/projects/<projectId>/imports {requestId, roundId, fileName, bytes, label?, session}',
      'PUT …/imports/<requestId>/content，Content-Type: application/octet-stream，请求体是文件原始字节',
      '回执 duplicate 表示项目里已有同内容版本：POST …/imports/<requestId>/resolve {choice:"keep"|"cancel"}，由用户决定；选 keep 时新版本和原版本共用音乐库里的同一条记录',
      '音乐库里已经有同内容的文件（比如用户先手动收纳过）时，回执的 reused 写明复用了哪条记录，不另存一份',
    ],
    limits: '只收 mp3、wav、m4a、flac；单个文件不超过 200MB。响应丢失时用 GET …/imports/<requestId> 查原回执，不要重发字节。',
  },
};
