# Updream 分镜视频绑定 v2 候选接入

这是可审候选，未安装到本机 Skill，未接管真实队列/在途任务，也不授予付费生成权限。以 BASELINE-SHA256 对照已核实际脚本版本；源码不含账号凭据。未来部署须另批，不能因为合并素材库代码便改已安装执行器。

实际调用链：已安装 `workflow.py submit` 持久化原生成请求后调用平台；`deliver` 走 `POST /api/project-videos/projects/:id/imports` → raw PUT → ready →目录/提示词/文件SHA回读。`followup.py` 调用同一个 `workflow.deliver`，所以只需候选补丁接在此共同入口，不修改跟进队列发现/授权/重试逻辑。

候选改动：将本目录 `video_binding_v2.py` 放入同一 scripts 目录，再审核应用 workflow-video-binding-v2.patch。补丁仅扩充受限本机 API 白名单、生成前预留、导入携带原出处、ready 后实际绑定回读；不移除原数量/幂等/授权/下载清理保护。未配置新字段的旧任务保持旧行为，不能事后补造生成出处；不能声称所有旧任务已自动接通。

新任务必须由实际做事的 Agent 在已确认同步并 verified 后明确填入私有任务状态（示例都是占位值）：

```json
{"storyboard_binding_v2":{"origin":"http://127.0.0.1:<本次独立端口>","instanceId":"<该库实例>","projectId":"<目标集UUID>","shotIds":["<有序稳定镜头ID>"],"lastVerifiedRevision":12}}
```

快速模式每次生成前同步，精致模式每次导演确认修改同步；讨论候选不算修改。普通 PUT 保镜头ID。自己最后verified版之后出现非agent作者（包括import/generation）先停问用户；仅agent更新时先合并，异栏保留、同栏以Markdown为准。此规则由实际做事的Agent执行，候选适配器只核lastVerifiedRevision，绝不代替Markdown语义合并或把当前版伪称自己写入。

首次预留前先持久化requestId/body；HTTP结果未知仍沿用同一记录，不重发付费任务或换视频UUID。等待出片期间改稿，交付仍带原出处。ready且binding.status=bound后还要GET该实际videoId核provenance及原镜头/版本，才能记binding.verified；原目录/完整提示词/SHA/解码检查继续执行。任何失败保留下载和原回执；不自动采用、不调用UI复核入口、不更新当前分镜。

历史预留未知在途不自动释放；明确未提交/失败/取消才由独立明确动作调用release。库实例、目标或配置变化时停止，不为通过校验换项目、清账本或改任务记录。测试仅用合成平台响应及真实隔离本机HTTP，不调用平台生成。
