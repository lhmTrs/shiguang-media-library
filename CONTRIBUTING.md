# Claude 与 Codex 协作约定

两边先读本文，再读 `AGENTS.md`、`AI_HANDOFF.md`、`CODE_SYNC.md` 和当前任务。用户最新指示优先；下面是默认分工，不自动产生开发任务或部署许可。

## 工作目录与分支

同一台电脑用 Git worktree 分开工作目录；不同电脑使用各自的 clone。目录名称不决定权限，开始前都要核对 `git status -sb`、`git branch --show-current` 和 `git worktree list`。

| 本机目录 | 用途 |
| --- | --- |
| `素材管理器/` | 当前使用版与已验收的 `main`；不在这里并行开发或构建候选 |
| `素材管理器-claude/` | Claude 的前端开发与自测 |
| `素材管理器-codex/` | Codex 的后端开发、审查与组合验证 |

- 一个功能一个短分支，例如 `feat/claude-video-layout`、`fix/codex-video-import`。`work/*-ready-*` 只是空闲起点，不积累长期功能提交。
- 两个 worktree 共享 Git 历史和 refs，但工作文件、`node_modules/`、`dist/`、测试数据各自独立。不要把原目录的数据、素材、凭据或依赖目录链接到开发目录。
- 不在对方目录里改文件、切分支、安装依赖或启动服务。不要在原使用目录切分支、运行 `npm ci` 或候选构建。
- Git 不传递未提交文件，也不自动通知另一位 AI。本机已有用户授权、双向连通的共享通信渠道（含共享目录），详细调查、返工与交付记录可直接通过该渠道交接；不必只靠 Issue/PR 逐段传话。交接时说明所属 worktree、记录的相对路径并确认接手方可读；不要把私人聊天、原始日志或真实项目资料粘贴到公开仓库。
- `collab/` 是被 Git 忽略的本机记录，不会随 clone 或各 worktree 自动互通；通过已约定共享渠道交接时仍需确认可读。它不能作为另一台电脑必须存在的协作输入，也不能把本机绝对路径作为跨电脑前提。长期共享约定放在本文或模块文档，Issue/PR 保留可独立理解的任务范围与最终结论。

## 账号与最小令牌权限

如需个人访问令牌，优先使用细粒度 PAT（fine-grained personal access token）。Resource owner 选 `lhmTrs`，Repository access 选 **Only select repositories**，只选 `shiguang-media-library`，并设置与任务相称的有效期。按实际工作选择下表权限；只有读取需要时不授予写入权限。令牌不会增加账号本身没有的仓库权限，仓库规则仍然适用。参见 [GitHub 令牌管理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

| Repository permissions | 最小用途与级别 |
| --- | --- |
| Contents | 读取源码用 Read-only；推送本次获准的源码/文档分支才用 Read and write。见 [内容读写权限](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)。 |
| Pull requests | 只查看用 Read-only；创建、更新 PR 或提交审阅才用 Read and write。见 [创建 PR 权限](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)。 |
| Issues | 只查看用 Read-only；创建、更新 Issue 或按接口要求写入评论等协作内容时才用 Read and write。见 [Issue 权限](https://docs.github.com/en/rest/issues/issues#create-an-issue)。 |
| Metadata | 保持 Read-only；不申请写入。见 [官方权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-metadata)。 |

不需要的可选权限不授予；普通源码协作不授予 Secrets、Variables、Administration、Workflows 或其他无关权限。若只是读取公开源码/公开 Issue，支持匿名读取的接口不需要为此新建令牌。凭据使用本机已有登录或凭据管理器；不读取或打印真实令牌、密钥，不要求在聊天、共享记录、Issue/PR 中粘贴令牌，不把令牌放入命令示例、源码或 remote URL。本文只是权限约定，不授权创建令牌或更改账号/仓库权限。

### Actions workflow 文件的额外权限

截至 2026-11-10 核对 GitHub 官方文档：涉及 `.github/workflows/` 下 workflow 文件的新增、修改或删除时，细粒度 PAT 写入除 **Contents: write** 外还需 **Workflows: write**；不能以普通源码所需的 Contents 写权限概括这类改动。官方 [内容创建/更新与删除接口](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents) 和 [Git 引用更新接口](https://docs.github.com/en/rest/git/refs#update-a-reference) 列出了 Contents 单项与 Contents + Workflows 两种权限组合，[Workflows 权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-workflows) 可用于核对具体操作。只有任务确需改 workflow 文件时才申请这项额外权限，不为普通开发默认扩大权限。

经典 PAT（personal access token classic）使用的是额外的 **`workflow` scope**，不是细粒度 PAT 的 Workflows 权限名称；它须与相应仓库访问 scope 配合，不能照抄为细粒度权限配置。官方 [scope 说明](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes) 还列明：若同仓库另一分支已有路径和内容完全相同的 workflow 文件，可在没有该 scope 时提交；这一例外不代表可任意新增/改写 workflow，也不是扩大普通源码令牌权限的理由。

**Actions: write** 是运行管理等另一类权限，不能替代 **Workflows: write**。开发者用于提交文件的 PAT 与 workflow 运行时的 `GITHUB_TOKEN` 也须分别判断；CI 任务 [#10](https://github.com/lhmTrs/shiguang-media-library/issues/10) 约定的 `permissions: contents: read` 是运行时最小权限，不因提交 workflow 所需的 PAT 权限而提高。参见 [GITHUB_TOKEN 权限说明](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token#modifying-the-permissions-for-the-github_token)。本次核验只查官方文档，不读取现有令牌，也不通过真实写入或权限变更试验。

## 新提交的 noreply 邮箱

本仓库 `lhmTrs` 账号后续新提交统一使用 `157477798+lhmTrs@users.noreply.github.com`。在确认当前目录属于本仓库后，按以下示例配置并仅查询该仓库字段：

```sh
git config --local user.email 157477798+lhmTrs@users.noreply.github.com
git config --local --get user.email
```

查询预期为 `157477798+lhmTrs@users.noreply.github.com`。`--local` 是仓库级配置，同仓库关联 worktree 通常共享；不同电脑的 clone 各自配置。不读取或改动用户的全局 Git 配置，不使用 `--global`。

后续获准创建新提交后、推送前，只核对刚创建的新提交（不要将基线旧提交当作新配置验证）：

```sh
git log -1 --format='author=%ae%ncommitter=%ce'
```

预期 author 与 committer 都是上述 noreply。若不符，先停止推送并检查是否有命令行、环境变量或 worktree 级覆盖；不要输出整份配置或环境。上述命令只作配置与验证示例，不能据此自行创建提交。设置只影响未来提交，不重写已发布历史，也不据此推断既有提交都泄露了真实邮箱。参见 [GitHub 仓库级提交邮箱说明](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address#setting-your-email-address-for-a-single-repository)。

## 分工与文件所有权

| 范围 | 默认负责人 | 约束 |
| --- | --- | --- |
| 页面布局、样式、组件与交互，通常在 `src/` | Claude | 保留接口、鉴权、确认、错误提示、草稿与显式关联；前端测试随修改一起交付 |
| `server/` 的接口、数据库、文件与业务逻辑 | Codex | 保持前端兼容；后端测试随修改一起交付 |
| `src/main.tsx`、客户端 API/共享类型、共享 CSS、`scripts/`、依赖与配置 | 每批指定一个负责人 | 跨角色改动先约定；不能以目录默认分工为由争写同一文件 |
| 独立验收与集成、合并 `main` | Codex 统筹，非作者验收 | 作者自测不能写成独立通过；Codex 自己实现时由另一验收方检查 |

每个完整任务先在当前任务或已约定共享渠道写清：用户结果、基线提交、分支、允许修改的文件/模块、共享文件负责人、接口变化、验收条件、禁区与下一接手方；Issue/PR 保留对外所需的任务摘要。范围内连续调查、实现和自测，不逐 helper 等许可。

前后端需要配合时，一次对齐请求与响应字段、状态、错误码、权限和兼容行为。后续只记录实际变化；不能让前端假成功，也不能把只存在于 mock 的接口当作已经接通。

## 开始与交付

1. 核对目录与工作区；已有修改先保留，不能自动 stash、覆盖、清理或丢弃。
2. 获取最新主分支，从最新 `origin/main` 创建功能分支。不要把另一个尚未验收的分支当成隐含依赖；确有依赖须写明准确提交。
3. 按约定范围实现并定向验证。UI 变更做构建与页面检查；业务变更做受影响测试；权限、文件写入、迁移和并发保留独立关键反例。
4. 审查准确 diff 和待提交文件，只暂存明确文件。提交到自己的分支并推送，创建以 `main` 为目标的 PR；使用仓库内 PR 模板。
5. 非作者对准确提交验收，普通返工直接交原作者。返工后只重验受影响项；新提交会使先前对旧提交的结论失效。
6. Codex 在独立目录组合最新 `main` 与候选，核对差分和必要检查后合并 PR。冲突由对应文件负责人处理；不使用整棵旧目录覆盖当前代码，不 force push。
7. 合并后回读远端 `main` 的实际提交。下一功能重新从最新主分支开始，避免继续堆叠旧任务。

功能分支命令示例（将 `video-layout` 换成本次任务名；工作区须干净）：

```sh
git fetch origin
git switch --no-track -c feat/claude-video-layout origin/main
git status -sb
```

交付命令示例（仅在源文件清单与内容已经审查后执行；将路径换成实际文件）：

```sh
git add -- src/实际修改的文件.tsx
git diff --cached
git commit -m "Describe the completed feature"
git push -u origin HEAD
gh pr create --base main
```

`main` 通过 PR 合并，禁止强推和删除。两个 AI 共用同一 GitHub 账号时，不能依赖“账号互相批准”；必需批准人数设为 0，独立验收以 PR 中注明的验收方、准确提交与实际结果为准。这里的文档分工不是文件权限隔离，不能代替审查。

PR 保持简短，写清本次问题、最终行为、实际检查结果及未测项；读者无需访问本机共享目录或私人聊天，也能独立理解最终结论。详细过程通过已授权共享渠道交接，不以本机证据链接替代 PR 必要结论；作者自测与非作者验收分别注明。

## 开发环境与检查

- 使用 Node.js 22 和锁定依赖。新开发目录运行 `npm ci`，然后按需 `npm run build`。不复制或链接原使用目录的 `node_modules/`。
- 需要启动候选时，显式使用本次新建的 `MEDIA_DATA_DIR`、`MEDIA_SKIP_IMPORT=1` 与独立端口。Claude 可从 4517、Codex 可从 4518 选空闲端口；占用时换空闲端口，不能结束占用进程。
- 只能使用自有合成文件与独立 SQLite 做常规测试；不要在原目录运行 `npm start`，也不要为测试读取现有用户库、素材或凭据。真正 MySQL、Windows、真实模型与部署分别按实际授权验证。
- 独立实例正常停止并记录结果。不能用浏览器关闭、PID 消失代替资源结清，也不能盲目强杀或重启现用服务。
- 检查强度以实际改动为准；文档和 Git 协作配置不要求重跑全部业务测试。已知旧失败按 `KNOWN_ISSUES.md` 保留，不能把定向通过写成全套通过。

## 发布边界

- 公开 Issue/PR 的日志与截图先脱敏，只保留复现所需的合成片段。路径用 `<repo>/src/example.tsx`、`<test-data>/server.log` 等占位形式，隐藏真实用户名、个人目录、项目资料、邮箱（公开 noreply 除外）、令牌、Cookie 和鉴权头；检查截图中的终端、地址栏与侧栏。不要为核验脱敏而读取原始凭据，不上传整份本机日志。
- 源码发布按 `scripts/package.mjs` 的明确清单审核；新增共享规则和资源须同步维护清单。不得使用未经审查的 `git add .`、`git add -A` 或整个工作区打包。
- 不提交 `data/`、`personal_item/`、`media/`、`node_modules/`、`dist/`、`collab/`、日志、模型、数据库或真实密钥。
- 合并代码不等于更新运行服务。应用现用版前仍需准确候选验收、活动任务保护及用户对更新/重启的授权；本协作约定不授予长期自动部署权限。
