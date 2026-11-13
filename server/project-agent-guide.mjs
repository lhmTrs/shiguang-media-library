export function projectAgentGuide({ project, origin, instanceId }) {
  const projectId = project.id;
  const storyboard = `/api/storyboard/projects/${projectId}`;
  const assets = '/api/project-assets/assets';
  const projectAssets = `/api/project-assets/projects/${projectId}`;
  const rules = `/api/concierge/rules?scope=${projectId}`;
  const example = value => ['```json', JSON.stringify(value, null, 2), '```'].join('\n');

  const episodeAssets = `/api/project-assets/scopes/episode/${projectId}`;
  const shared = project.series_id ? `
### 剧集共享资料

先读取 \`GET /api/projects/${projectId}/asset-context\`，核对当前集、全剧、季和归组版本。
当前集列表为 \`GET ${episodeAssets}/assets?kind=character&page=1\`。详情为 \`GET ${episodeAssets}/assets/<asset_id>\`。
返回的 \`owner\` 区分本集与全剧，\`effective\` 给出本集实际采用的默认造型、图片与属性评分。明确的镜头引用以分镜 ID 为准。
新建前用 \`POST ${episodeAssets}/names/check\` 传 \`kind\` 和 \`name\`。需要沿用共享同名资产时，用 \`POST ${episodeAssets}/assets\` 提交新 UUID、同集的 \`context_token\`、类型、名称和 \`on_shared:"reuse"\`；需建立独立资料时选用未占用的名称并传 \`on_shared:"reject"\`。结果未知时查 \`GET /api/project-assets/scoped-requests/<request_id>\`。
本链接的修改范围是当前集。本集自有资料可以按下文修改。遇到全剧共享基础资料时，请用户单独指定并授权全剧范围。
` : '';
  return `# 拾光 · Agent 项目接入说明

## 项目绑定

${example({ projectName: project.name, projectId, instanceId, origin })}

先在运行拾光的电脑上请求 \`GET /api/session\`。确认返回的 \`app\` 是 \`shiguang-local-media\`，且 \`instanceId\` 与上面一致。请求路径都以该 \`origin\` 为基址。保留响应中的会话 Cookie，后续 API 请求携带该 Cookie。写请求及 POST 预览还需要 \`X-Local-Token\`（同一响应的 \`token\`）和 \`Content-Type: application/json\`。会话只在本机使用。链接和说明不含凭据，也不代表用户授权修改项目。

## 读取项目规则

请求 \`GET ${rules}\`，使用返回的 \`text\` 和 \`revision\` 读取项目规则及其当前版本。\`globalText\` 是另行保存的全局管家规则。涉及分镜时，也读取分镜正文中的 \`project.global_rules\`，对应分镜「项目设置」里的全局规则。规则提供创作上下文，写入范围以用户当前指示为准。

## 分镜

- 读取：\`GET ${storyboard}\`，返回 \`project\`、\`revision\` 与 \`asset_stamp\`。已保存分镜格式见 \`GET /api/storyboard/schema\`。按永久镜头 ID 定位，镜号用于展示。未初始化时返回 404。
- 修改已有分镜：从读取返回的完整 \`project\` 生成候选，只改用户指定的部分，保留 ID 和关联。\`PUT ${storyboard}\`。
- 初始化：读取 \`GET /api/storyboard/initialization-schema\`。先用 \`POST ${storyboard}/preview\` 提交 \`source\` 预览，核对素材复用、新建和警告。确认后才用 \`POST ${storyboard}/initialize\` 写入。已有分镜只有在用户明确要求覆盖时才重新初始化。

已有分镜保存请求示例（用本次读取的数据替换占位值）：

${example({ project: '<基于读取结果修改后的完整 project 对象>', expected_revision: 3 })}

初始化请求字段为 \`source\`（完整初始化对象）、\`expected_revision\`（预览返回值，空项目为 null）和新生成的 UUID \`request_id\`。结果未知时，使用原请求 ID 查询 \`GET ${storyboard}/requests/<request_id>\`，保留原请求，避免重复初始化。

## 人物、场景和道具
${shared}
- 列表：\`GET ${assets}?project_id=${projectId}&kind=character&page=1\`。\`kind\` 可为 \`character\`、\`scene\`、\`prop\`，每页 40 条，可用 \`q\` 搜索。优先复用当前项目中的资产 ID。
- 创建：\`POST ${assets}\`。先检查同名资料，按需创建空白档案。
- 读取：\`GET ${assets}/<asset_id>\`。修改前确认返回的 \`project_id\` 等于上面的项目 ID。
- 修改：\`PUT ${assets}/<asset_id>\`。提交完整 \`asset\` 对象及本次读取的 \`expected_revision\`。保留 ID、归属、造型、图片及已有绑定，只改用户指定的字段。

新建人物请求示例：

${example({ project_id: projectId, kind: 'character', name: '人物名称' })}

修改资产请求示例（用本次读取的数据替换占位值）：

${example({ asset: '<基于读取结果修改后的完整 asset 对象>', expected_revision: 2 })}

用户明确指定要复制的来源人物时，先调用 \`GET ${assets}/<source_id>/copy-preview?project_id=${projectId}\`，核对来源与目标。再调用 \`POST ${assets}/<source_id>/copy\`，发送目标 \`project_id\`、预览返回的 \`source_revision\` 与 \`request_id\`、以及目标人物 \`name\`。结果未知时查询 \`GET /api/project-assets/copies/<request_id>\`。使用响应中的新人物 ID 建立关联。

## 人物属性打分

1. 先读取 \`GET ${projectAssets}/script\`、项目规则及人物列表。需要核对人物背景时，读取人物完整资料。只给剧本或资料有依据的维度打分。
2. 读取 \`GET ${projectAssets}/attribute-config\`。读取 \`config_scope\`、\`alignment_status\` 和 \`config_token\`。使用返回的维度 ID 和评分依据，按该维度的两端含义打整数分。全剧已统一时，本集自有人物仍走本集评分接口，用全剧维度 ID；项目链接不授予修改全剧底分或设置的权限。五档区间从低到高为 −100～−60、−59～−20、−19～19、20～59、60～100。0 是有效分数。没有依据时跳过该格。仅独立项目经用户授权、尚无评分记录时，可调用 \`POST ${projectAssets}/attribute-config/initialize\`，提交 \`expected_revision\`、\`config_token\` 和 3–8 个 \`dimensions\`。沿用的维度传现有 ID，新维度传 \`id:null\`。已经评分的项目若需改维度，请将提案交给用户核对。
3. 用 \`GET ${assets}/<asset_id>/attributes\` 查看已有评分。\`source:manual\` 包含人工清空，应跳过。用户授权打分后，用 \`POST ${projectAssets}/attribute-scores\` 提交，每次 1–200 格，每格附最多 200 字的依据。
4. 回执包含 \`applied\` 和 \`skipped\`。\`MANUAL_PRESERVED\` 表示人工记录已保留，\`ASSET_UNAVAILABLE\` 表示当前项目中没有该可评分人物，\`DIMENSION_UNAVAILABLE\` 表示该维度不可用。遇到 \`CONFIG_STALE\` 或 \`ATTRIBUTE_CONTEXT_STALE\` 时重新读取配置再评估。遇到 \`SERIES_MANAGED\` 或 \`ATTRIBUTE_ALIGNMENT_REQUIRED\` 时，把配置交给用户在全剧设置处理。请求结果未知时，用相同 \`request_id\` 和相同请求内容取回原回执。完成后读取人物属性核对。

打分请求示例（替换为本次读取的 ID、版本及依据）：

${example({
  request_id: '<新生成的 UUID>',
  config_revision: 0,
  config_token: '<本次读取的配置凭证>',
  scores: [{ asset_id: '<人物 ID>', dimension_id: '<维度 ID>', value: 30, reason: '对应剧本或人物资料中的依据' }],
})}

## 核对结果

先读取最新资料和修订号，再按用户授权提交。遇到 409 时重新读取并核对，保留原候选。回应丢失时先回读目标或查询已有回执，避免盲目重发。分镜和资产分别调用各自的接口，逐项回读并报告成功、失败或结果未知。
`;
}
