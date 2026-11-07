# 分镜格式与本机接口

脚本直接调用现有拾光 HTTP 接口，不新建模型对话。认证 cookie 和令牌仅存在内存；不能把它们写入项目绑定、分镜或汇报。

## 两种 JSON

`read` 每次从正在运行的服务读取格式，不能把其他项目旧快照当作当前协议。`example.json` 是导入示例，可能含旧兼容格式；新初始化以 `initialization-schema.json` 为准。

### 日常更新：标准编辑文档 1.0.0

从 `project.json` 复制候选，保留完整文档结构。`project_id` 与 `document_id` 是分镜文档 ID；`bound_project_id` 才是素材管理器项目 ID，不能混用。一次请求保存完整文档，但仅修改本轮需要的字段。常用路径：

- `scenes[].shots[].action`：画面与人物动作。
- `camera`、`framing`、`transition`：摄影机、景别/角度、剪辑衔接；实际字段以当前文档和 schema 为准。
- `duration_ms`：正整数毫秒。对白、承接、人物和道具均引用已有永久 ID；改变时长后检查全片总长。
- `dialogue[]`：已有对白保留 ID、人物引用、声源和表演要求，按用户要求改文本。
- `characters`、`assets`、`asset_manifest`、导入来源和历史批次保持原样。本技能的日常更新不承担资产清单编辑。

镜头的 `revision` 与整套文档 `revision` 不同：修改镜头时增加该镜头修订号，文档修订号由服务端原子保存推进。不要为了局部修改重造所有镜头 ID。新增/删除镜头、改时长或承接时，仍须符合服务端引用约束。

### 初始化：完整中文 2.0.0

新建空项目分镜、或明确整套覆盖时使用。最低骨架如下；额外字段和具体约束查看实时 schema。

```json
{
  "格式版本": "2.0.0",
  "完整分镜": true,
  "项目名称": "用户确认的标题",
  "故事核心": "用户确认的故事",
  "画幅": "16:9",
  "总时长秒": 3,
  "素材清单": {
    "人物": [{"编号": "C01", "名称": "示例人物"}],
    "场景": [{"编号": "L01", "名称": "示例场景"}],
    "道具": []
  },
  "场景": [{
    "场次": 1,
    "地点": "示例场景",
    "场景编号": "L01",
    "镜头": [{
      "镜号": "01", "开始秒": 0, "结束秒": 3, "时长秒": 3,
      "景别与角度": "中景，平视",
      "画面与人物动作": "填写已确认动作",
      "摄影机设计": "固定机位",
      "人物编号": ["C01"], "道具编号": [],
      "声音与对白": {"环境与动作声": "室内底噪", "对白": []},
      "剪辑衔接": "切至下一镜"
    }]
  }]
}
```

只写完整 JSON，不附解释/Markdown/保存脚本在 JSON 内。镜号全片唯一（01 与 1 算重复），素材同类编号和名称唯一，场次唯一，引用存在；时间从 0 累计，开始/结束与时长、场次和全片总长一致。程序检查格式和这些确定性约束；剧情覆盖、表演与对白是否符合讨论，仍由导演核对，不冒充程序已审定。

## 实际接口与结果

| 操作 | 接口 | 关键限制 |
| --- | --- | --- |
| 取得本机会话 | GET `/api/session` | 核验 app 与 instanceId，认证只存内存 |
| 查普通项目 | GET `/api/projects` | 按精确名称/ID，不按目录猜 |
| 读取分镜 | GET `/api/storyboard/projects/:projectId` | 未初始化为 404 |
| 格式 | GET `/api/storyboard/schema`、`/initialization-schema` | 实时格式；不硬编码远程 schema |
| 完整初始化预览 | POST `/api/storyboard/projects/:id/preview` | 不保存；显示复用/新建与警告 |
| 日常保存 | PUT `/api/storyboard/projects/:id` | 完整 project + expected_revision；服务端事务校验 |
| 整套初始化 | POST `/api/storyboard/projects/:id/initialize` | source + expected_revision + 固定 request_id |
| 查询原初始化 | GET `/api/storyboard/projects/:id/requests/:requestId` | completed/receipt；没有结果也不自动重发 |

脚本锁定读取时的素材库 instanceId、项目 ID、文档修订/初始化代次及资产戳。提交前会重新核对；真正的并发保存保障是服务端 `expected_revision` 事务检查。资产戳只是提交前检查，接口不提供资产戳的原子 CAS，不能宣称杜绝所有资产并发变化。提交后再回读比对。

`prepare` 返回计划目录，其中 `before.json` 是修改前完整读数，`diff.json` 是差异/预览，`plan.json` 是固定请求内容。`commit` 只发送一次；`sending.json`、`response.json`、`result.json`、`readback.json` 记录本次进展。结果未知只用 `check`，不要手改/删除这些文件来重发。

保存当前项目分镜不等于创建分镜版本，也不保存另一套候选供网页切换。需要保留多套分镜时先确认用户当前项目/复制项目策略，不自行创建或替换项目。
