export function videoBindingV2AgentGuide({project,origin,instanceId}){
 const id=project.id,base='/api/storyboard-video/v2';
 return `

## 分镜视频绑定 v2：来历与点镜播放

本节替代旧逐镜截段、旧采用方案与拼整集说明。旧 storyboard-video 的 state/inspect/preview/imports/requests/takes/calibrate/plan/confirm 返回410 LEGACY_VIDEO_BINDING_RETIRED；项目生成视频原上传API保留。不要用旧savePlan或镜号重建对应。

只读入口：GET ${base}/projects/${id}/state；GET ${base}/projects/${id}/shots/<shotId>/videos?offset=0&limit=20；GET ${base}/source-projects/<sourceProjectId>/videos/<videoId>/binding；GET ${base}/provenance/<provenanceId>。state未初始化返回initialized:false，不隐式建分镜；其它分页limit为1..100。读接口不扫描目录、不逐片探测/哈希、不补历史/清待看。缓存或外部依赖不可核验会明确标记；媒体真正打开仍经过现有文件身份和授权检查。

videoId为storyboard_video_sources来源ID，不是全库media ID；sourceProjectId为片子所在集，targetProjectId为对应目标集。稳定shotId是权威，镜号仅显示。一片同时只对应一集，可选来源项目或当前同剧其它normal集（可跨季，容器不是集）；不通过移动文件或改变视频归属冒充跨集绑定。

默认播已采用，否则最新关联；新片不会自动采用或替换正在播放内容。新片数只在有采用时算：在该镜当前选择写入之后新建的关联，按不同videoId计数；不按视频创建时间，不记录看过。绑定原版有序镜头和durationMs用于估算起播，播到片尾，不能称真实逐镜入出点。镜头ID重建后旧片留原版，不按镜号认领新稿。

### 实际做事会话负责同步

拾光不存快速/精致模式字段，也不与分割模式混用。快速：每次生成前同步并回读；精致：每次导演确认的修改后同步。讨论候选/试稿不算修改、import/generation按非agent的解释由Claude先定后审，可撤回，不冒充用户原话。

每个会话保存自己最后verified写入的documentId、initializedAt、revision和request_id；请求已发送不算verified。没有自己的基线时先对齐，不把当前最新版冒称自己写入。普通Markdown更新走原分镜PUT并保留镜头ID，只在用户明确整集重建时initialize。

覆盖前按页读 GET /api/storyboard/projects/${id}/versions，核自己最后verified版之后的每条作者记录。只要有非agent（包括user/import/generation/restore）版本，先停下问用户；仅agent变化时先比对并合并进Markdown：不同栏保留，对同一栏的真实冲突以Markdown为准，不再问用户。author_kind不认证具体操作者或真人，不将自己的基线也算作“之后”。

拍摄约束进正式栏：状态保持/防穿帮→continuity；动作方式→action及正式动作反馈；机位→camera；开场样子→first_frame。不放design_note，因为只改设计备注和transition不触发需复核。景别、动作、运镜、时长、首帧、连续性、声音/对白、人物在场、参考图、承接对白、场景及范围增删都参与比较；实际用到的外部人物/造型/参考图及范围外承接对白也参与，不能只看revision。

### 提交生成前固定出处，成片按原回执入库

1. 在本机 ${origin} 读取会话，校验实例为 ${instanceId}，继续携带Cookie、X-Local-Token及X-Shiguang-Library-Id。不向平台或共享文件发送会话凭据。
2. 同步成功并verified后，POST ${base}/projects/${id}/provenance：{requestId:<固定新UUID>,expectedStoryboardRevision:<自己已核版本>,expectedAssetStamp:<刚读取值>,shotIds:[<该版唯一有序稳定ID>]}。这仅本地登记，不发起生成。预留成功才允许按已有明确授权提交生成，持久保存provenance及revision。读回不符或结果未知，查同一GET ${base}/requests/<requestId>，不另换UUID。
3. 视频入库沿现有 POST /api/project-videos/projects/<sourceProjectId>/imports，原固定requestId/fileName/bytes/folderId/prompt等不变，增加storyboardOrigin:{provenanceId,expectedProvenanceRevision}。再走原raw PUT及同名确认，不猜镜头，不在成片后拿当前revision补造出处。等待生成期间改稿仍沿用原预留。
4. ready只说明视频阶段；必须确认binding.status=bound，再GET实际videoId的binding，核原provenance、document/代次/revision/shotIds和来源项目，才报告已绑定。文件、完整提示词、位置、内容回读继续按原流程检查。复用旧片不能把本次新生成出处覆盖进去；VIDEO_ORIGIN_CONFLICT时保留原文件和稳定回执，不换UUID复制一条绕过。
5. 已明确未提交/失败/取消且尚未绑定时，才POST ${base}/provenance/<id>/release：{requestId,expectedProvenanceRevision,reason:"not-submitted"|"failed"|"cancelled"}。未知在途不自动过期或释放。成功绑定的原出处不可改写或释放。

外置Updream候选接入需未来另批部署；本地接口或mock不等于已安装执行器。不要改已安装Skill、真实队列或在途任务来冒充闭环。自动记录不等于自动采用，不自动确认人工复核。

### 历史、迁移与结果未知

reserved出处及实际绑定/复核事件引用的完整版不受最近50份限制；改绑/解绑保留历史来历。原版已裁剪返回410 VERSION_PRUNED，不凭镜号补造。引用与裁剪共用锁；未知pin/schema会停止裁剪。备份/恢复保留v2权威身份、实例/请求记录与完整引用，不能借JSON覆盖列身份。

旧链迁移分preview/check、安装schema、私有一致导出、校验、原子删除/标记与恢复。只清旧takes/plans/旧绑定requests审计行，片子来源、视频资料、授权和原片保留。安装与删除分开，MySQL DDL不可冒称事务DELETE能回滚。503 VIDEO_V2_MIGRATION_REQUIRED或VIDEO_V2_UNSETTLED时停止写入并报告实际阶段；当前开发权限不包括正式库导出/DDL/删除/4317或服务操作，不能自行执行升级。

所有v2 mutation保留requestId，可GET ${base}/requests/<requestId>查committed/rejected；未登记404为未知，不等于失败。409 VIDEO_BINDING_CONFLICT/VIDEO_SELECTION_CONFLICT/STORYBOARD_CONFLICT/ASSET_CONTEXT_CHANGED/VIDEO_ORIGIN_CONFLICT/VIDEO_TARGET_SCOPE_CHANGED/REQUEST_ID_CONFLICT要重读/重预览，不覆盖旧状态或换UUID掩盖结果。复合解除确认使用confirmedUnbindShotRefs:[{projectId,shotId}]，完整无重复且与预览一致；旧ID数组只在无跨集同ID歧义时兼容，VIDEO_UNBIND_SCOPE_REQUIRED要求重取完整复合引用。HTTP失败的error与message相同，均为安全中文。
`;
}
