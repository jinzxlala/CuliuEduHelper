# CuliuEduHelper Agent 工作说明

本文件记录当前工程状态和后续开发约束。任何 Code Agent 开始修改前，应先阅读本文件与根目录的 `project_design.md`；如果两者发生冲突，以最新版本的 `project_design.md` 和用户当前指令为准。

## 1. 项目定位与当前阶段

- 项目名称：醋溜教育智能助手（CuliuEduHelper）。
- MVP 主架构：Node.js／TypeScript 单仓库、Next.js 全栈应用、独立 Node Worker、PostgreSQL、Redis／BullMQ、Meilisearch，以及可替换的模型适配层。
- 当前已完成本地 Meilisearch 预备环境、工程脚手架与质量基线、阶段 0 数据基础设施与边界、阶段 1 的搜索领域契约、48 场知识来源清单、正式 Worker 导入链路、版本化中文搜索评测器和内部知识搜索 Web 流程，阶段 2 的内部账号、Auth.js 会话、学生级授权基础、学生事实与不可变证据档案、画像草稿和人工审核状态机，阶段 3 的版本化课程目录、确定性课程规则、人工规划领域工作流和受保护的内部顾问 Web 工作台，以及阶段 4 的本地加密备份与隔离恢复演练。
- 50 条中文金标查询已有 Code Agent 草案并通过技术评测，但仍待项目负责人逐条确认；逐字稿时间戳仍受隐私门禁保护。学生画像与课程规划技术链路均已具备版本、审核、失效复查和确定性 Markdown 导出能力，但 20—30 个真实受控案例和已批准的真实课程目录尚未进入业务验收。不要把技术评测、页面可用或虚构夹具端到端通过误报为业务门禁或业务 MVP 已完成。
- `data_origin/` 中的分析稿已通过 `knowledge/source-manifest.v1.json` 导入 PostgreSQL、不可变本地对象存储和 Meilisearch；任何重导仍必须通过清单哈希、角色映射和逐字稿隐私门禁，不能直接批量写索引。
- MVP 的搜索优先采用关键词、筛选和证据定位。向量检索、混合检索、同义词和召回调优应等至少 50 条中文金标查询建立后再决定。

## 2. 已完成的本地 Meilisearch 环境

截至 2026-08-01，本机已验证：

- Docker Desktop 4.84.0，Linux Docker Engine 29.6.2；
- Docker Compose v5.3.1；
- Docker CLI 已加入真实 Windows 用户的 `PATH`；新终端可直接使用 `docker`；
- Meilisearch 使用固定镜像 `getmeili/meilisearch:v1.50.0`；
- 容器名：`culiu-edu-helper-meilisearch`；
- 本地地址：`http://127.0.0.1:7700`；
- 端口只绑定到 `127.0.0.1`，不得改为无条件公网监听；
- 持久化卷：`culiu-edu-helper-meilisearch-data`，挂载到 `/meili_data`；
- Compose 配置包含自动重启、健康检查、2 CPU／2 GB 内存上限和日志轮转；
- Meilisearch 运行于 `production` 模式并启用主密钥鉴权；
- 已关闭 Meilisearch analytics。

运行状态会随 Docker Desktop 启停而变化，不要仅凭本节断言服务在线；执行以下命令实时确认：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml ps
```

## 3. 部署文件与使用方式

- `infra/docker-compose.yml`：Meilisearch 服务、端口、卷、资源和日志配置的来源文件。
- `infra/setup-meilisearch.ps1`：幂等部署与索引初始化脚本；它从 `packages/search/index-definitions.json` 读取索引 settings，不再维护第二份字段清单。
- `infra/.env.example`：环境变量模板，不包含真实密钥。
- `infra/.env`：本机自动生成的真实主密钥，已由根目录 `.gitignore` 排除。
- `README.md`：面向开发者的启动、停止、日志查看和重建说明。

首次部署、恢复服务或重新应用索引配置：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-meilisearch.ps1
```

不重新拉取镜像、只启动服务并重新应用索引配置：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-meilisearch.ps1 -SkipPull
```

该脚本会自动定位 Docker CLI；对于 Docker Desktop 的用户目录安装，它会把 Docker CLI 目录加入脚本进程的 `PATH`，保证 Docker credential helper 可被找到。脚本使用 UTF-8 BOM 保存，以兼容 Windows PowerShell 5.1 对中文源码的解析。

## 4. 当前索引

三个正式目标索引已经创建。本机截至 2026-08-02 的已发布知识版本应为 48 条讲座、169 张匿名案例卡和 0 条逐字稿正文；运行状态和数量必须用 `pnpm knowledge:import:status` 实时确认：

| 索引 | 主键 | 主要用途 |
|---|---|---|
| `lectures` | `lecture_id` | 讲座标题、摘要、趋势、讲者、学校和专业搜索 |
| `cases` | `case_id` | 匿名案例背景、录取结果、专业、研究、活动和 AI 方向搜索 |
| `transcript_segments` | `segment_id` | 逐字稿正文、章节、讲座来源和时间戳定位 |

索引的 searchable、filterable 和 sortable attributes 以 `packages/search/index-definitions.json` 为唯一配置源，PowerShell 初始化脚本和 TypeScript 搜索服务共同读取。修改字段或查询协议时，应同步更新：

1. `project_design.md` 中的索引设计；
2. `packages/search/index-definitions.json`；
3. `packages/search` 中的文档 Schema 与查询实现；
4. 对应的索引初始化、过滤和中文检索测试。

初始化脚本会使用随机命名的临时索引写入一条虚构中文记录，验证普通关键词和精确短语搜索，然后删除临时索引。不要把冒烟测试数据写入三个正式目标索引。

## 5. 安全和数据边界

- 不得读取、显示、复制或提交 `infra/.env` 中的真实主密钥；日志和最终回复也不得输出密钥。
- 浏览器端不得持有 Meilisearch 管理密钥。后续应用只能由服务端搜索模块访问 Meilisearch。
- Meilisearch 是可重建索引，不是正式事实来源；正式业务数据未来存入 PostgreSQL，原始文件进入受控对象存储。
- 匿名讲座案例和机构真实学生资料必须严格分域。
- 当前三个知识索引不得写入姓名、联系方式、家庭、健康、心理或其他真实学生敏感资料。
- 如果未来确需搜索学生档案，必须建立独立索引、独立访问密钥和服务端学生级授权过滤，不能复用当前公共知识索引。
- `GET /health` 可匿名访问；其他接口应要求有效 API key。无密钥访问 `/indexes` 的验收期望是 HTTP 401。
- 不得把 Meilisearch 或 PostgreSQL 直接暴露到公网；生产部署必须经业务 API、Nginx／HTTPS 和服务端授权上下文访问。

## 6. 已通过的验收

本地部署已实际验证：

- Compose 配置有效，容器状态为 `healthy`；
- `/health` 返回 `available`；
- 无密钥访问受保护接口返回 401；
- 三个目标索引存在且主键正确；初始化阶段文档数均为 0，正式导入后为 48／169／0；
- 虚构中文关键词和精确短语查询均能命中；
- 临时冒烟索引已删除；
- 容器重启后三个目标索引仍存在；
- 命名卷正确挂载到 `/meili_data`；
- `infra/.env` 存在且被 Git 忽略；
- 真实密钥未出现在 Compose、脚本、README、模板或 `.gitignore` 中；
- 初始化脚本可重复执行，不会重复创建索引或覆盖已有主密钥。

修改部署或索引代码后，至少重新执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-meilisearch.ps1 -SkipPull
git diff --check
```

并再次检查鉴权、目标索引数量、索引文档数和容器重启持久化。

## 7. 工程脚手架与质量基线

截至 2026-08-01，已完成并验证：

- Node.js 22、TypeScript 5.9.3、pnpm 11.9.0、Turborepo 2.10.8；
- `apps/web`：Next.js 15.5.22／React 19.2.8 页面骨架与 `GET /api/health`；
- `apps/worker`：可独立构建和启动的 Node Worker 骨架；
- `packages/shared`：Zod 4.4.3 共享状态 Schema 与类型；
- 根目录 Prettier、严格类型 ESLint、TypeScript 严格配置、密钥扫描和锁文件供应链门禁；
- `.github/workflows/ci.yml`：在 Node.js 22 下执行冻结安装、`pnpm check`、数据库迁移和 PostgreSQL／Redis／Meilisearch 集成测试；
- `docs/adr/0001-monorepo-runtime.md`：记录单仓库、运行时与 MVP 范围决策；
- 生产依赖通过 `pnpm audit --prod --audit-level high`，当前无已知漏洞。为修复 Next 间接依赖公告，`pnpm-workspace.yaml` 将 `sharp` 和 `postcss` 固定到已修复版本。

统一质量门禁：

```powershell
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行格式检查、潜在密钥扫描、Lint、严格类型检查、迁移一致性、103 个单元测试、Web／Worker 生产构建，以及公开健康检查、Auth.js 登录、会话 Cookie、授权学生目录、证据上传与下载、事实绑定、证据失效传播、跨学生读写拒绝和停用账号即时失效的真实 HTTP 冒烟测试。上述流程已在本机环境通过；冻结安装、格式检查、密钥扫描、Lint、严格类型检查、迁移一致性、103 个单元测试和全部生产构建也在一次性官方 Node.js 22.23.2 Docker 容器的隔离副本中通过。开发机当前 Node.js 主版本不是 22 时会出现 engine 警告，正式兼容性以 Node.js 22／CI 验收为准。

`infra/.env` 中的 `DEEPSEEK_API_KEY` 已做存在、非空、格式与最小长度检查，但本模块未调用 DeepSeek；不得在日志、文档、测试夹具或回复中输出密钥值。后续模型模块仍须通过服务端适配器读取。

## 8. 阶段 0 数据基础设施与边界

截至 2026-08-01，已完成并验证：

- `infra/docker-compose.yml` 固定使用 PostgreSQL `16.14-bookworm` 和 Redis `7.4.10-alpine3.21`，仅绑定 `127.0.0.1`，使用独立命名卷、健康检查、资源上限和日志轮转；
- `infra/setup-foundation.ps1` 会保留已有真实密钥和其他环境变量，替换缺失、空白或仍为 `replace-...` 的本地占位值，启动服务后执行幂等迁移和脱敏 fixture；
- `packages/database` 使用 Drizzle，初始迁移包含正式数据、冻结授权上下文、任务状态、审计事件、知识／学生数据域和不可变证据约束；
- `packages/tasks` 提供 BullMQ 任务信封、Zod 复验、幂等任务 ID 与冻结授权上下文引用；任务不得携带新的学生 ID 来扩大 Worker 权限范围；
- `packages/storage` 提供 SHA-256 寻址的本地不可变文件适配器，`knowledge/` 与 `student/<student-id>/` 路径严格分离，不提供覆盖或删除接口；
- `docs/adr/0002-data-infrastructure-boundaries.md` 是本模块边界决策记录；
- `pnpm test:integration` 已在 Windows 本机通过；当前仓库总计 9 项 PostgreSQL、1 项 Redis／BullMQ、7 项 Meilisearch 和 3 项 Worker 集成测试。与本轮相关的 7 项 Meilisearch 集成测试另在 Node.js 22 Linux 容器中复跑通过；
- PostgreSQL 与 Redis 重启后均恢复为 `healthy`，脱敏学生夹具仍保持 1 行，证明命名卷持久化有效；
- `infra/.env` 仍被 Git 忽略，`DEEPSEEK_API_KEY` 仅确认已配置，未读取或输出其值。

首次启动或重新应用本模块：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-foundation.ps1
```

代码变更后的最低验收：

```powershell
pnpm check
pnpm test:integration
git diff --check
```

## 9. 阶段 1 搜索领域契约与服务层

截至 2026-08-01，阶段 1 的首个独立模块已完成并验证：

- `packages/search` 提供严格 Zod Schema，覆盖 `lectures`、`cases`、`transcript_segments` 及时间戳证据引用；未知字段、绝对路径、父目录穿越、反向时间范围、重复 ID、跨讲座引用和案例／逐字稿单向引用均会被拒绝；
- 稳定服务接口为 `KnowledgeSearchService.searchLectures`、`searchCases`、`searchTranscriptSegments`、`getEvidence`，以及 `KnowledgeIndexManager.rebuildKnowledgeIndexes`；
- 查询输入只允许预配置的分面、排序和最大 50 条分页，筛选值使用结构化转义；高亮使用私有 Unicode 标记，不向调用方注入 HTML 标签；
- `KnowledgeIndexManager` 在写入前完成整批结构与引用校验，通过随机临时索引构建三个完整索引，再用一次原子交换发布；交换前失败会清理临时索引，交换后清理失败会返回孤儿索引名；
- 三个索引名必须安全且互不相同；正式名称和测试名称均不得绕过该校验；
- 服务端优先读取作用域更小的 `MEILI_SEARCH_API_KEY`／`MEILI_ADMIN_API_KEY`，本地开发可回退到 `MEILI_MASTER_KEY`；浏览器端仍禁止持有任何密钥；
- `infra/setup-meilisearch.ps1` 已在 Windows PowerShell 5.1 下验证可正确读取根 JSON 数组，并完成幂等初始化及中文关键词／精确短语冒烟；
- 搜索包当前29项单元测试和7项真实 Meilisearch 集成测试已通过；其中原服务层覆盖严格 Schema、引用完整性、配置密钥优先级、硬过滤、分面、高亮、短语检索、证据读取、索引幂等和三索引原子替换，新增评测测试见第12节；
- 仓库级 `pnpm check` 与 `pnpm test:integration` 已在 Windows 本机通过；`pnpm check`和7项Meilisearch集成测试另在Node.js 22.23.2 Linux一次性容器中通过。当前集成总计9项PostgreSQL、1项Redis／BullMQ、7项Meilisearch和3项Worker测试；
- 搜索服务层自身不负责导入；当前正式索引内容由第 11 节的 Worker 导入器发布和重建。

该服务层模块本身不包含正式来源映射或数据导入；来源映射由下一节提供，正式导入由第11节提供，金标评测由第12节提供，Web搜索流程由第13节提供。同义词和向量检索仍未实现。

## 10. 阶段 1 知识来源清单与证据映射

截至 2026-08-01，阶段 1 的第二个独立模块已完成并验证：

- `packages/knowledge-ingest` 提供 Node.js／TypeScript 的只读清单生成器、严格 Zod Schema、来源解析器、哈希复验和 CLI；根命令为 `pnpm knowledge:manifest:build`；
- `knowledge/source-manifest.v1.json` 确定性记录 48 场讲座、每场 5 个来源角色，共 240 个文件；当前语料库哈希为 `6e0e05d877bce46f09d17f5e1d00d16a96c08a916125646bb45f4394cbbb7008`；
- 48 份分析 Markdown 与外部 48 组 `.json`、`.qa.json`、`.srt`、`.txt` 文件名完全对应，无缺项、额外日期组或重复角色；`_整理汇总.json` 被显式标记为非一手聚合文件并排除；
- 每个分析稿必须具备基础信息、摘要、趋势、案例、AI+、失败、关键原话、行动建议和证据边界九类语义章节；
- 逐字稿 JSON、SRT 和带时间戳 TXT 的 68,133 个片段已逐条验证数量、正文和起止时间一致；QA JSON 的句子数与 30,821 个实际文本变更统计也已核对；
- 清单只包含逻辑相对路径、原始字节 SHA-256、大小、标题、章节名和统计，不包含正文、外部物理根路径或源 JSON 内嵌的绝对路径；绝对路径泄漏检查为 0；
- 分析稿可映射到 `lectures`／`cases`；逐字稿 JSON 属于受限证据，只有通过独立隐私复核和匿名化门禁后才可映射到 `transcript_segments`；SRT、TXT 和 QA JSON 只用于校验，不得直接进入索引；
- `docs/adr/0003-knowledge-source-inventory.md` 记录决策，`knowledge/README.md` 记录重建和验证命令；
- 新包 13 项测试全部通过，覆盖确定性、缺项／多项、UTF-8 与 Schema、章节、时间／文本／QA 一致性、哈希篡改、绝对路径防泄漏和已提交清单完整性；
- 当前仓库级 `pnpm check` 和 19 项集成测试均在 Windows 本机和 Node.js 22.23.2 Linux 一次性容器中通过；三个基础服务需按需实时检查健康状态；
- 清单模块本身不写 PostgreSQL、Redis、Meilisearch 或对象存储；当前正式数据由第 11 节的导入模块写入，来源文件仍未被修改；
- `infra/.env` 继续被 Git 忽略；`DEEPSEEK_API_KEY` 只确认存在、非占位且格式长度合理，未读取或输出密钥值，本模块没有调用 DeepSeek。

重新生成真实清单时，先构建包，再给出两个本机逐字稿根目录：

```powershell
pnpm --filter @culiu/knowledge-ingest build
$transcript2025 = '<2025逐字稿目录>'
$transcript2026 = '<2026逐字稿目录>'
pnpm knowledge:manifest:build `
  --analysis-root '.\data_origin' `
  --transcript-root "2025=$transcript2025" `
  --transcript-root "2026=$transcript2026" `
  --output '.\knowledge\source-manifest.v1.json'
```

本模块本身不包含来源正文解析、PostgreSQL 来源记录或 Worker 导入；这些已由第11节实现。50条金标查询草案及评测器已由第12节实现，Web搜索流程已由第13节实现；逐字稿隐私批准和金标业务确认仍未完成。清单存在不等于逐字稿已获准索引。

## 11. 阶段 1 正式知识导入 Worker

截至 2026-08-02，阶段 1 的第三个独立模块已完成并验证：

- `knowledge/source-manifest.v1.json` 是唯一批次入口；任务只携带语料库、映射和清单版本身份，不接受客户端路径；Worker 只读取服务端配置的绝对根目录；
- 分析稿按证据边界保守解析为 48 条 `lectures` 和 169 张匿名 `cases`；逐字稿正文受数据库硬约束固定为 0 条，SRT、TXT 和 QA JSON 只参与一致性校验；
- PostgreSQL 记录导入批次、尝试、来源关系、讲座／案例版本、失败阶段和安全摘要；四字段身份为 `corpus_id + corpus_hash + mapping_version + manifest_version`，相同身份重导为零业务变更；
- `source_document`、`evidence_object` 与知识版本使用 `data_domain=knowledge` 复合外键；学生域来源或证据不能进入知识导入关系；发布批次、版本和来源关系由触发器保护，不能降级、覆盖或删除；
- 原始字节写入 SHA-256 寻址的本地不可变存储；Meilisearch 使用三索引临时构建和原子交换发布，并由全局 PostgreSQL advisory lock 串行化所有正式知识发布；
- PostgreSQL 是正式当前版本来源。Worker 启动时会从当前已发布批次重建三个搜索索引；搜索交换后若数据库 finalize 失败，也会立即回滚为数据库当前版本；
- BullMQ 最多重试 3 次；`background_job` 使用 25 秒 lease 和随机 claim token，旧 Worker 不能完成或失败覆盖新接管者；过期的最后一次尝试会进入失败终态并产生审计；
- 入队脚本不执行迁移或自动 seed。脱敏 fixture 授权必须同时显式设置 `NODE_ENV=development|test` 与 `KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH=true`；生产环境必须提供真实冻结授权上下文，已知 fixture ID／hash 即使通过显式变量提供也会被拒绝；
- 本机真实导入和重复入队已验证：240 个来源、48 条讲座、169 张案例卡、0 条逐字稿正文；中文讲座搜索、案例搜索、筛选和证据读取冒烟通过，重复任务返回 `already_imported`；
- 59 项单元测试与 19 项集成测试通过；另在临时空数据库完整执行 0000—0004 迁移和 9 项约束测试，并在官方 Node.js 22.23.2 Linux 容器复跑 `pnpm check` 与全部集成测试；
- `infra/.env` 继续被 Git 忽略；`DEEPSEEK_API_KEY` 仅确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块没有调用 DeepSeek。

常用验收命令：

```powershell
pnpm knowledge:import:validate
pnpm --filter @culiu/worker start
pnpm knowledge:import:enqueue -- --new-task
pnpm knowledge:import:status
pnpm knowledge:import:smoke
```

内部搜索页面、详情和证据查看流程已由第13节实现；50条查询仍须由项目负责人逐条确认，在确认前不得把阶段1标记为业务完成，也不得凭当前草案结果加入同义词、向量或混合检索。

## 12. 阶段 1 版本化中文搜索金标评测

截至2026-08-02，阶段1的第四个独立模块已完成技术实现和验证：

- `knowledge/search-gold.v1.json`提供绑定`corpus_id + corpus_hash + mapping_version + manifest_version`的版本化fixture；当前恰好50条查询，其中26条讲座查询、24条案例查询和17条关键查询；
- fixture覆盖中文切分、中英文混合名称和缩写、精确短语、字段权重观察、证据边界、负面条件、日期／学校／可信度／案例性质硬过滤和禁止命中；相同目标与搜索输入不得重复计分；
- 所有查询均由Code Agent起草，`approval.status=draft`，审核人和审核时间固定为空。项目负责人未逐条核对前，禁止改为`approved`或宣称为“顾问标注完成”；
- `packages/search`提供严格Zod Schema、语料身份校验、Top-5评测器和CLI。评测器通过正式`KnowledgeSearchService`调用，分别计算全部查询命中率、关键查询命中率、硬过滤准确率、禁止命中检查以及端到端P95延迟；
- 技术阈值不可弱化到Top-5低于85%、关键查询低于100%、硬过滤低于100%或P95高于500ms。普通评测在技术失败时返回非零；`--require-approved`还会在fixture未获批准时返回退出码2；
- 本机正式索引实测为50/50 Top-5命中、17/17关键查询命中、硬过滤100%、禁止命中100%，最近一次端到端P95约44ms；`technical_gate_passed=true`，但由于仍是草案，`release_gate_passed=false`；
- 代码审查修复了空过滤数组误判，并增加重复查询、防虚假硬过滤标签、错误目标ID、阈值弱化、伪审批、语料错配和禁止命中等反例测试；
- 仓库当前共80项单元测试和20项集成测试通过；完整`pnpm check`和20项集成测试在Windows本机通过，搜索底层的`pnpm check`及7项Meilisearch集成测试、Web层的依赖构建／10项测试／严格类型检查／生产构建分别在官方Node.js 22.23.2 Linux容器复跑通过；
- `docs/adr/0004-search-gold-evaluation.md`记录评测口径。当前正式`transcript_segments`仍为0，因此本版不伪造逐字稿正向金标；解除隐私门禁后必须升级fixture并增加时间戳证据查询；
- `infra/.env`继续被Git忽略；`DEEPSEEK_API_KEY`仅确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块不调用DeepSeek。

常用命令：

```powershell
pnpm search:gold:validate
pnpm search:gold:evaluate
pnpm search:gold:evaluate -- --require-approved
```

第三条命令当前预期退出码为2，这是未完成人工业务确认的有效门禁，不是技术评测失败。

## 13. 阶段 1 内部知识搜索 Web 流程

截至2026-08-02，阶段1的第五个独立模块已完成技术实现和验证：

- `apps/web`提供统一`/search`页面，在讲座报告、匿名案例和逐字稿证据三个范围间切换；支持关键词、业务分面、讲座日期／标题排序和每页10条的稳定分页；
- 查询参数先经过长度、枚举、日期、数组去重和分页上限归一化，再映射到`KnowledgeSearchService`的稳定契约；浏览器不直接请求Meilisearch；
- Meilisearch客户端位于导入`server-only`的服务端模块，优先使用作用域搜索密钥并可按既有本地规则回退主密钥；页面、响应和客户端代码不得包含任何密钥或`NEXT_PUBLIC`搜索配置；
- 高亮只解析搜索服务返回的私有Unicode标记并交给React转义渲染，不使用`dangerouslySetInnerHTML`；测试包含类似HTML事件处理器的文本，确认其只作为普通文本展示；
- 讲座详情显示摘要、趋势、AI／跨学科、失败风险和逻辑来源路径；案例详情显示背景、结果、研究／活动／AI方向、来源讲座和证据边界；逐字稿详情接口已预留，但正式索引为0时页面明确说明隐私门禁，不伪造时间戳或正文；
- 首页已改为内部MVP入口，并明确“证据优先”和“逐字稿隐私门禁”；当前不包含收藏、复杂对比、同义词、向量或混合检索；
- 本机正式索引实测：讲座和案例关键词查询、筛选、排序、分页、讲座详情、案例详情均可用，逐字稿为空且门禁提示可见；浏览器桌面与390像素窄屏布局、搜索提交、关键词高亮、分页、排序和详情跳转通过验收；
- Web包现有15项单元测试；仓库级`pnpm check`和34项集成测试通过。Web模块另在官方Node.js 22.23.2 Linux一次性容器的隔离副本中完成冻结安装、格式检查、密钥扫描、Lint、严格类型检查、迁移一致性、95项单元测试和生产构建；
- `infra/.env`继续被Git忽略；`DEEPSEEK_API_KEY`仅确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块不调用DeepSeek。

本模块的常用入口：

```text
http://127.0.0.1:3000/
http://127.0.0.1:3000/search
```

本地开发应从根目录运行`pnpm dev`，并确保Meilisearch已启动且`infra/.env`可由服务端进程读取。不要把`.env`复制到`apps/web`或改成`NEXT_PUBLIC_*`变量。

## 14. 阶段 2 内部账号与学生级授权基础

截至2026-08-02，阶段2的第一个独立技术模块已完成并验证：

- `packages/authorization`提供严格的账号、会话主体、授权上下文和学生动作契约；密码使用Argon2id，参数固定为64 MiB内存、3次迭代、并行度1和32字节输出；未知用户也执行虚拟密码校验，避免明显的账号枚举时序差异；
- Auth.js使用Credentials Provider和最长8小时JWT会话。服务端每次读取会话都会重新检查账号是否仍启用；Cookie使用`HttpOnly`、`SameSite=Lax`，HTTPS或无法确认生产URL时强制`Secure`；短于32字节的会话密钥会被拒绝；
- 首个管理员只能通过`pnpm auth:admin:create`和进程环境变量`CULIU_BOOTSTRAP_ADMIN_PASSWORD`创建，无默认密码、不从命令行参数读取密码、不输出密码；数据库中已有可交互密码账号后会拒绝再次初始化；
- 管理员、负责人和顾问都不会因角色自动获得全部学生权限。所有学生目录和详情访问都必须具有对应学生的显式有效授权；服务端生成的授权上下文最长15分钟，并冻结操作者、学生、动作和最高敏感级别；
- 每次读取学生资料都会重新验证账号状态、授权是否撤销或过期、动作范围、上下文完整性和当前学生隐私级别；授权撤销、隐私级别提高、跨学生ID替换、上下文hash篡改和越级读取都会被拒绝并记录审计；
- Web新增`/login`、`/students`、`/students/[studentId]`和`/api/students/[studentId]`；知识搜索及三个详情页也要求有效内部账号。未登录学生API返回401，非法或未授权学生统一返回404，学生响应设置`private, no-store`；
- 端到端Web冒烟每次创建随机临时PostgreSQL数据库，应用迁移和脱敏fixture，验证失败／成功登录、Cookie属性、显式授权目录、授权详情、跨学生404和停用账号使现有JWT立即失效，结束后删除临时数据库，避免污染本地正式开发库；
- 仓库级`pnpm check`通过，共95项单元测试；`pnpm test:integration`通过，共9项数据库、14项授权、1项Redis／BullMQ、7项Meilisearch和3项Worker集成测试，合计34项；生产依赖审计未发现已知高危漏洞；
- 官方Node.js 22.23.2 Linux隔离副本已通过冻结安装、格式检查、密钥扫描、Lint、严格类型检查、迁移一致性、95项单元测试和全部生产构建；需要真实PostgreSQL、Redis与Meilisearch的运行时和集成验收在Windows本机完成；
- `infra/.env`继续被Git忽略；`DEEPSEEK_API_KEY`仅以布尔检查确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块没有调用DeepSeek；
- 本轮已完成主Agent代码审查并修复会话Schema、授权有效期、原生Argon打包、测试数据库污染、授权撤销、隐私升级和UUID输入校验问题。`dev_plan.md`要求的独立Code Agent复核尚未发生，必须在阶段2业务门禁前补做；
- 当前只使用脱敏／虚构学生fixture，没有导入真实学生资料，也没有实现画像生成或课程规划。因此本模块完成不等于阶段2业务验收完成。

## 15. 阶段 2 学生事实与不可变证据档案

截至2026-08-02，阶段2的第二个独立技术模块已完成并验证：

- `packages/student-records`提供严格的学生事实、本人证据、具体定位、线性版本、失效和读取接口；交互端只能声明`advisor`、`student`、`parent`或`evidence`来源，`import`保留给未来受控导入器；
- 证据文件最大20 MB，必须具有1—25条页码、段落、字符范围、表格单元格、时间戳或记录字段定位；文件按SHA-256写入`student/<student-id>/`不可变对象路径，原始文件、定位、事实—证据关系和失效事件均不可覆盖或删除；
- 事实值是最大16 KiB的严格结构化JSON，字段键使用稳定的小写命名空间；事实与证据修订都只能形成单一线性版本链，不能分支、跨学生、跨字段或降低访问等级；
- 事实引用只能绑定同一学生域内、当前、未失效且访问等级不高于事实的证据定位；知识域证据、其他学生证据和已被取代的证据会在领域服务与PostgreSQL触发器两层被拒绝；
- 证据失效采用追加事件，不删除原文件；读取事实时会计算引用的有效状态，失效证据不再允许下载，依赖该证据的事实会显示复查警告；
- Web学生档案页支持证据上传与修订、结构化事实录入与修订、证据绑定、历史查看、受保护下载和失效；稳定API为`POST /api/students/<id>/facts`、`POST /api/students/<id>/evidence`、`GET /api/students/<id>/evidence/<evidence-id>`和`POST /api/students/<id>/evidence/<evidence-id>/invalidate`；
- 所有读写先建立最小动作授权上下文，再由领域服务重新加载并校验账号、授权、学生和访问等级；审计只保存动作与安全元数据，不复制事实正文、文件名、文件内容或失效原因；
- 数据库迁移`0005_bored_nighthawk.sql`与`0006_colossal_nova.sql`已应用到本地开发库；临时数据库验证了从全新迁移到约束触发器的完整路径；
- 仓库级`pnpm check`通过，共103项单元测试；`pnpm test:integration`通过，共9项数据库、14项授权、9项学生档案、1项Redis／BullMQ、7项Meilisearch和3项Worker集成测试，合计43项；生产依赖审计未发现已知高危漏洞；
- 官方Node.js 22.23.2 Linux隔离副本已通过冻结安装、格式检查、密钥扫描、Lint、严格类型检查、迁移一致性、103项单元测试和全部生产构建；真实PostgreSQL、Redis、Meilisearch及Web运行冒烟在Windows本机完成；
- `infra/.env`继续被Git忽略；`DEEPSEEK_API_KEY`仅以布尔检查确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块没有调用DeepSeek；
- 本轮完成了主Agent代码审查，重点复核了授权前置、跨学生与跨域绑定、访问等级过滤、版本并发、不可变触发器、失效传播、附件下载和临时测试清理。`dev_plan.md`要求的未参与实现的独立Code Agent复核尚未发生，必须在阶段2业务门禁前补做；
- 当前只使用脱敏／虚构fixture，没有导入真实学生资料。20—30个真实受控案例的证据合法率和整理效率门禁尚未执行，因此阶段2仍未完成业务验收。

## 16. 阶段 2 DeepSeek 学生画像草稿流水线

截至 2026-08-02，阶段 2 的第三个独立技术模块已经完成并验证：

- `packages/ai` 提供服务端 DeepSeek JSON 网关，地址固定为 `https://api.deepseek.com`，画像模型固定为 `deepseek-v4-flash`；请求关闭流式输出和思考模式、启用 JSON Object、设置 45 秒默认超时，并把空输出、截断、无效 JSON、用量不一致、HTTP 错误和超时转换为不包含密钥或响应正文的安全错误；
- `packages/student-profiles` 只从当前、已确认、访问等级不高于 `sensitive`、字段位于明确白名单且至少绑定一条当前有效学生证据的事实构建快照。姓名、联系方式、健康/心理、家庭收入等键和正文中的邮箱、手机号、长身份证明及学生公开码会在出站前移除或替换；知识域证据和匿名案例不能进入画像输入；
- BullMQ 任务 `profile.draft` 只携带冻结快照 ID/hash、授权快照引用、Git commit、模型/提示词/Schema/脱敏/计价版本，不携带学生 ID、事实正文或原始附件。Worker 每次执行前和模型返回后都重新验证账号、当前授权、事实版本、证据有效性、快照成员和事实—证据关系；90 秒 lease、claim token、最多 3 次尝试和幂等任务 ID 防止旧 Worker 覆盖新接管者；
- 模型输出必须严格包含八个且每类恰好一个画像结论：学术基础、兴趣主线、经历连接、责任与影响、跨学科/AI 深度、行为证据、缺口/矛盾/风险和一句话标签。所有非缺失结论必须引用快照内定位，一句话标签必须标记为推断；待确认问题只能引用快照内字段。任何空输出、Schema 失败、越界引用、授权过期或证据失效都会失败且不写入半成品；
- PostgreSQL 迁移 `0007_gifted_marrow.sql` 和 `0008_aspiring_ironclad.sql` 新增输入快照、任务运行、画像版本、画像结论和结论证据表。数据库约束/触发器复核同学生域、当前事实/证据、快照成员、引用数量、运行配置和不可变内容；画像当前只允许写为 `draft`，人工复核状态机留给下一模块；迁移已应用到本地开发库；
- Web 新增 `GET/POST /api/students/<id>/profile-drafts` 和学生档案页的画像草稿区。生成请求必须先获得独立的 `student:profile:generate` 动作和 `sensitive` 上限；浏览器不持有模型密钥，只看到安全任务状态、草稿结论和待确认问题；
- Worker 默认使用真实 DeepSeek 适配器；确定性 mock 只允许 `development/test`，生产环境显式拒绝。`CULIU_GIT_COMMIT_SHA`、`PROFILE_MODEL_PROVIDER`、模型超时/输出上限和可选队列名已写入 `.env.example`；真实 `.env` 继续被 Git 忽略；
- 画像模块 5 项契约测试和 4 项 PostgreSQL 集成测试通过，覆盖脱敏、字段白名单、越界引用、输入幂等、证据失效、无半成品和不可篡改；全仓库 `pnpm check`、47 项运行服务集成测试及 Web→Redis/BullMQ→Worker→PostgreSQL 冒烟通过；官方 Node.js 22.23.2 Linux 隔离副本通过冻结安装、格式、Lint、严格类型、迁移一致性、单元测试和全部生产构建；
- `DEEPSEEK_API_KEY` 已以布尔方式确认配置且未输出值；`pnpm profile:model:smoke` 使用纯虚构探针真实调用 `deepseek-v4-flash` 成功，返回合法 JSON，共计 51 tokens，没有发送学生资料。该命令会产生极小的真实 API 用量，不应加入普通 `pnpm check`；
- 本轮只使用脱敏/虚构 fixture，没有导入真实学生资料，也没有执行 20—30 个真实受控案例门禁。没有实现人工确认、批准画像、课程目录、课程匹配或规划报告，因此阶段 2 业务验收和 MVP 仍未完成。

## 17. 阶段 2 学生画像人工审核状态机

截至 2026-08-02，阶段 2 的第四个独立技术模块已经完成并验证：

- 授权动作拆分为 `student:profile:review` 和 `student:profile:approve`。画像读取、完整修改、提交/退回/归档与批准均从服务端重新构造学生级 `AuthorizationContext`，领域服务再次检查账号、学生、动作和访问等级；跨学生画像 ID 对外统一表现为 404；
- 顾问修改不会覆盖原画像，而是创建带 `source_profile_version_id` 的新版本。数据库唯一约束禁止从同一来源分叉，服务端以 `expectedUpdatedAt` 做乐观并发检查；历史版本、八类结论、证据关系、待确认问题和每次审核记录都可追溯；
- 固定状态机落实为 `draft → in_review → approved`、`in_review → draft`、当前版本到 `archived`，以及 `approved → needs_review`。退回和归档必须记录原因，批准记录批准人及时间；数据库触发器阻断跳过审核的 `draft → approved`、旧版本审批和审核记录篡改；
- 批准前必须再次满足当前冻结快照、当前已确认事实、当前有效学生证据、八个且每类恰好一个结论、非缺失结论的合法证据引用和一句话标签为推断。模型结果或顾问输入不能绕过 Zod 与数据库双重校验；
- 引用证据被失效、被新版本替代，或输入事实被标记为 superseded/设置失效时间时，数据库自动将相关已批准画像改为 `needs_review`，写入仅含内部 ID 的失效原因、审核记录和审计事件；批准元数据仍保留，便于区分“从未批准”和“批准后需复查”；
- Web 新增 `POST /api/students/<studentId>/profiles/<profileId>/revisions` 与 `POST /api/students/<studentId>/profiles/<profileId>/transitions`。学生档案页支持完整结论、信息性质、置信度、证据关系、待确认问题的人工修改，以及提交、退回、批准、归档、版本历史和变更类别查看；浏览器仍不持有管理密钥或模型密钥；
- PostgreSQL 迁移 `0009_lovely_nemesis.sql` 已应用到本地开发库，开发 fixture 已更新为新的分离授权动作。画像模块 6 项契约测试和 10 项 PostgreSQL 集成测试通过；全仓库 `pnpm check`、53 项运行服务集成测试、生产依赖审计和真实 Web 冒烟通过；官方 Node.js 22.23.2 Linux 隔离副本通过冻结安装、格式、密钥扫描、Lint、严格类型、迁移一致性、单元测试和生产构建；
- `infra/.env` 继续被 Git 忽略；`DEEPSEEK_API_KEY` 仅以布尔检查确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块没有调用 DeepSeek；
- 本轮只使用脱敏/虚构 fixture，没有导入真实学生资料。20—30 个真实受控案例的证据合法率和整理效率门禁尚未执行，因此阶段 2 仍未完成业务验收；`dev_plan.md` 要求的未参与实现的独立 Code Agent 反例复核也必须在业务门禁前补做。

## 18. 阶段 3 版本化课程目录与确定性规则基础

截至 2026-08-02，阶段 3 的第一个独立技术模块已经完成并验证：

- 新增 `@culiu/course-planning` 普通 TypeScript 领域包，不引入动态 Skill Runtime、Multi-Agent 运行时或模型决策。`$student-course-plan` 只作为设计参考，用于明确先修、时间冲突、已完成课程不可重复选择和可观察规则结果；真实学生规划与输出格式留给下一模块；
- `course`／`course_rule` 保存稳定身份，`course_version`／`course_rule_version` 保存不可变内容。修订只能从最新、未归档版本创建带来源指针的新版本；唯一约束和触发器拒绝分叉、原地篡改、删除、伪造初始批准状态和批准元数据修改；
- 课程版本包含标题、阶段、难度、目标、能力/学科/项目标签、交付物、不适用条件、周期、总课时、周负荷、授课模式、学期日期和周时段。固定时段课程必须有至少一个不重叠时段，自定进度课程不得带固定时段；
- 课程规则固定为先修、互斥、年龄范围、时间冲突和负荷上限五类，支持 `hard` 与 `warning`。规则集批准前拒绝重复语义、先修/互斥矛盾、无交集年龄范围和先修循环；先修必须来自历史完成集合，同期选课不能替代，已完成课程不能再次选择；
- MVP 暂由有效 `admin` 创建、修订、批准和归档课程/规则，`advisor` 与 `auditor` 只读取已批准快照和执行评估。服务层每次操作重新核对数据库账号状态和角色，并记录审计；数据库再次校验管理员、版本状态、规则引用和被引用课程的已批准版本；
- PostgreSQL 迁移 `0010_yielding_thunderbolt_ross.sql`、`0011_fix_course_prerequisite_cycle.sql` 和 `0012_harden_course_version_immutability.sql` 已应用到本地开发库。后两条迁移分别记录真实集成测试发现的循环检测边界修复，以及主 Agent 代码审查补充的数据库绕过防护；
- 规则模块 11 项单元测试和 5 项 PostgreSQL 集成测试通过，覆盖正例、反例、年龄边界、相邻/重叠时段、组合违规、warning、重复、矛盾、循环、未批准引用、版本分叉、直接篡改和直接删除。全仓库 `pnpm check` 通过，共 114 项单元测试；`pnpm test:integration` 通过，共 58 项运行服务集成测试；真实 Web 冒烟和生产依赖审计通过；
- 官方 Node.js 22.23.2 Linux 隔离副本通过冻结安装、格式、密钥扫描、Lint、严格类型、迁移一致性、114 项单元测试和全部生产构建；真实 PostgreSQL、Redis、Meilisearch 与 Web 运行验收在 Windows 本机完成；
- `DEEPSEEK_API_KEY` 仅以布尔方式确认存在、非占位、长度满足门禁且 `infra/.env` 被 Git 忽略；本模块没有调用 DeepSeek，也没有向任何模型发送课程或学生数据；
- 仓库仍没有获批的真实课程目录。本模块的虚构课程只存在于随机临时测试数据库且测试后删除；不得把技术基础误报为课程业务数据、人工规划或阶段 3 业务验收完成。`dev_plan.md` 要求的未参与实现独立 Code Agent 反例复核仍需在阶段 3 业务门禁前补做。

## 19. 阶段 3 人工课程规划与 Web 工作台

截至 2026-08-02，阶段 3 的第二个独立技术模块已经完成并验证：

- `@culiu/course-planning` 新增完全人工录入的规划工作流，输入必须引用当前已批准画像中的非缺失结论，并冻结学生输入、规划内容、课程目录、规则评估及其 SHA-256 摘要；本模块不调用模型，DeepSeek 不可用时仍可完成规划；
- 短期课程固定为 1—3 项，替代路线固定为两条中性路线；路线阶段必须按时间连续排序且不重叠，比较维度不少于 6 项，同时记录重叠、缺口、可观察决策时间线和风险。该结构完整参考 `$student-course-plan` 的设计约束，但没有引入动态 Skill Runtime；
- 规划只允许使用已批准课程版本。已完成或正在学习的课程不能重复规划；固定排期课程必须完整落入规划时间段；每个短期阶段和路线阶段都重新运行先修、互斥、年龄、时段和负荷规则，后续阶段只把前序阶段视为已完成；
- 硬规则违规必须形成稳定违规键，并由具有 `student:plan:approve` 权限的人员明确批准覆盖。覆盖记录保存申请理由、申请人、决定人和决定时间；普通顾问不能通过修改输入、客户端学生 ID 或数据库直接更新绕过审批；
- 规划版本采用 `draft → in_review → approved`、退回、归档及批准后 `needs_review` 状态。内容、快照、依赖、审核历史和批准元数据由 PostgreSQL 触发器保护为不可变；修订形成带来源指针的新版本，不覆盖历史版本；
- 已选课程版本、冻结规则版本或批准画像失效时，相关已批准规划会自动进入 `needs_review`。新的全局负荷/时间规则或影响已选课程的新年龄、先修、互斥规则获批时，也会使既有规划进入复查，避免只跟踪旧规则版本造成漏检；
- 确定性 Markdown 导出只允许当前 `approved` 规划，包含版本、审批人/时间、复查日期、输入快照摘要、近期课程、双路线、ASCII 并行路径、6 项以上比较、风险、规则结果和批准覆盖记录；相同版本重复导出字节一致，浏览器端不持有管理密钥；
- PostgreSQL 迁移 `0013_clammy_stryfe.sql` 新增规划版本、课程/规则依赖、审核记录和规则覆盖表及其状态机、不可变与失效传播触发器。所有测试只使用随机临时数据库中的虚构学生、画像、课程和规则，测试结束后删除；
- `@culiu/course-planning` 新增受授权保护的工作台读模型，一次返回当前批准画像的可引用结论、批准课程快照、规划版本、审核历史和规则覆盖记录；读取动作每次重载服务端授权上下文并写入审计。纯 Zod 规划契约另以 `@culiu/course-planning/contracts` 暴露为 client-safe 子路径，浏览器 bundle 不再连带 PostgreSQL 运行时代码；
- Next.js 新增 `/students/[studentId]/planning` 内部顾问页面及规划读取/创建、状态流转、规则覆盖申请/审批、Markdown 导出 6 个 API 路由。页面使用结构化表单录入 1—3 个短期项、两条多阶段路线、6 项以上对比、重叠/缺口、决策时间点和风险，不要求顾问编辑 JSON，也不调用模型；
- 所有规划页面、API 和导出都由服务端创建带学生 ID、动作和敏感级别的 `AuthorizationContext`；未登录返回 401，未授权、跨学生和参数篡改统一返回 404，冲突返回 409。浏览器不持有数据库、Meilisearch 或模型管理密钥；
- 当前版本支持草稿创建、基于最新活动版本创建不可变修订、提交、退回、批准、归档、硬规则覆盖申请与有权限人员明确审批；最新版本已归档时，新规划不再把已归档版本作为修订来源。批准版本才显示 Markdown 导出，进入 `needs_review` 后导出立即被阻断；
- 真实 Web/Worker 冒烟在随机临时数据库中完成“批准画像→创建三门虚构批准课程→创建规划→提交→批准→Markdown 导出→证据失效→画像和规划进入 `needs_review`→导出返回 409”，同时验证未登录 401、跨学生规划状态操作 404、页面失效原因可读；测试结束后删除临时数据库和虚构业务数据；
- 课程规划包现有 19 项单元测试和 6 项 PostgreSQL 集成测试，Web 新增 2 项表单契约单测；全仓 `pnpm check` 通过，共 137 项单元测试、生产构建和真实 Web 冒烟通过；`pnpm test:integration` 共 59 项全部通过。官方 Node.js 22.23.2 Linux 一次性容器通过格式、密钥扫描、Lint、严格类型、迁移一致性、137 项单元测试、全部生产构建和真实 Web/Worker 冒烟；
- `infra/.env` 继续被 Git 忽略；`DEEPSEEK_API_KEY` 仅以布尔检查确认已配置、非占位且长度满足门禁，未输出密钥值，本模块没有调用 DeepSeek；
- 本轮已由主 Agent 复核授权重载、跨学生隔离、串行化事务、冻结快照、审批覆盖、数据库绕过、规则/课程/画像失效传播和确定性导出。`dev_plan.md` 要求的未参与实现的独立 Code Agent 反例复核仍需在业务门禁前补做；
- 阶段 3 的代码范围和虚构数据技术验收已完成，但仍没有获批的真实课程目录或真实学生案例，因此不能宣称阶段 3 业务验收或 MVP 业务验收完成。后续代码模块进入阶段 4 回归、安全、恢复和部署包；真实业务门禁仍由项目负责人负责。

## 20. 阶段 4 本地加密备份与恢复演练

截至 2026-08-02，阶段 4 的第一个独立技术模块已经完成并验证：

- 新增 `@culiu/operations` Node.js／TypeScript 运维包和根命令 `pnpm backup:create`、`pnpm backup:verify`。本模块只处理 PostgreSQL、不可变对象文件与可重建的 Meilisearch 知识索引，不把 Redis 队列或搜索索引当作正式事实备份；
- `infra/setup-foundation.ps1` 会在被 Git 忽略的 `infra/.env` 中幂等生成独立 `BACKUP_ROOT` 和 32 字节随机 `BACKUP_ENCRYPTION_KEY`，保留已有真实值。数据库转储、对象文件和包含逻辑路径的清单均使用 scrypt 派生密钥与 AES-256-GCM 认证加密；公开回执只含归档 ID、时间和加密清单 SHA-256；
- PostgreSQL 备份使用只读可重复读事务导出的快照 ID，让 `pg_dump` 和逐表精确行数来自同一个一致性快照。备份只通过 Docker 容器内的 PostgreSQL 16 工具执行，不在命令参数、输出、回执或审计中写入数据库密码；
- 不可变对象按稳定路径顺序逐个读取、计算 SHA-256 和真实大小，再以不泄露学生 ID 的序号文件名分别加密。符号链接、路径穿越、数据库引用缺失或内容哈希不符都会阻断备份；生产环境没有任何缺失对象例外；
- 早期脱敏开发夹具包含一条固定 ID、全 `c` 占位哈希且从未生成实体文件的学生证据。仅 `development`／`test` 可识别并在加密清单与恢复结果中明确记录这一条缺口；ID、学生、键或哈希任一不完全匹配都会失败，`production` 也会失败。该例外不能用于真实学生资料或业务验收；
- 恢复验收先校验公开回执与加密清单，再把对象解密到权限受限的随机临时目录并逐个复核大小和哈希；PostgreSQL 转储恢复到随机临时数据库，35 张表逐表行数必须与一致性快照完全相同；
- Meilisearch 不从卷快照恢复。工具从临时恢复库读取当前正式知识版本，重建三组随机命名临时索引并核对数量，再删除临时索引。最终实测为 48 条讲座、169 张案例和 0 条逐字稿；正式三个索引未被覆盖；
- 成功与失败均写入追加式 `audit_event`，动作分别为 `system.backup.created` 与 `system.backup.restore_verified`。Docker 子进程固定 10 分钟超时；恢复只有在临时数据库、临时索引、容器转储和明文目录全部清理成功后才返回 `verified`；
- 本机真实演练结果为：35 张数据库表、240 个实体对象、1 条明确的脱敏夹具缺口、48／169／0 个重建搜索文档。演练后临时数据库 0、临时索引 0、明文文件 0、半成品目录 0；完整加密备份保存在被 Git 忽略的 `.local-data/backups/`，本模块不自动删除备份；
- 运维包 7 项单元测试通过，覆盖认证加密往返与篡改、路径遍历与符号链接、开发夹具精确例外和生产拒绝。全仓 `pnpm check` 在官方 Node.js 22 容器通过，共 144 项单元测试、生产构建和真实 Web／Worker 冒烟；`pnpm test:integration` 共 59 项全部通过；
- `infra/.env` 继续被 Git 忽略；`DEEPSEEK_API_KEY` 和 `BACKUP_ENCRYPTION_KEY` 均只以布尔方式确认已配置，未输出密钥值。本模块未调用 DeepSeek，也未向外部模型发送任何数据；
- 本模块完成的是本地备份与实际恢复技术门禁，不等于腾讯云真实上线、异地备份或业务 MVP 验收。备份保留周期、异地加密存储、服务器规格、域名、证书和 VPN 仍待项目负责人决定；下一代码模块进入腾讯云 Compose／Nginx／HTTPS 可配置部署包与运维检查。

常用命令：

```powershell
pnpm backup:create
pnpm backup:verify
pnpm backup:verify -- --backup "D:\path\to\completed-backup"
```

创建备份前应暂停 Web 和 Worker 写入。备份目录不得进入 Git、普通共享盘或未加密介质；丢失 `BACKUP_ENCRYPTION_KEY` 将无法恢复，泄露密钥则会失去备份机密性。

## 21. 破坏性操作与工作区保护

以下命令会永久删除本地 PostgreSQL、Redis 和 Meilisearch 的全部命名卷，只有在用户明确要求重置全部本地数据时才能执行：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down -v
```

普通停止服务应使用不带 `-v` 的 `down`，以保留数据库、队列和索引：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down
```

当前工作区可能包含用户已有的删除和未跟踪文件。不要擅自恢复、覆盖、移动、删除、暂存或提交与当前任务无关的内容。尤其不要假设所有 `git status` 变化都由当前 Agent 产生。

## 22. 下一阶段建议边界

阶段0与阶段1的搜索契约、来源清单、正式知识导入、金标技术评测和内部Web搜索流程已完成。阶段1仍有两项必须由项目负责人处理的业务门禁：逐条确认金标查询，以及决定逐字稿能否在独立隐私审核后进入索引。Code Agent不得代替签字或审批。

1. 项目负责人逐条检查`knowledge/search-gold.v1.json`的查询意图和预期ID；Code Agent不得代替业务签字；
2. 阶段 2 的内部账号、统一授权、学生事实、不可变证据、DeepSeek 画像草稿和人工审核技术链路已经完成；20—30 个真实受控案例未到位前只能视为技术完成，不能宣称业务验收；
3. 阶段 3 的版本化课程目录、确定性规则、人工规划、受保护 Web API、内部顾问页面、Markdown 导出和端到端失效展示已经完成技术验收；真实课程数据未到位前只能使用脱敏/虚构 fixture，并继续明确标注“未完成业务验收”；
4. 阶段 4 的本地一致性备份、对象加密、隔离数据库恢复和临时 Meilisearch 重建已经完成真实技术演练；下一模块只建设腾讯云 Compose／Nginx／HTTPS 可配置部署包和运维检查，不在缺少服务器、域名、证书和 VPN 信息时声称真实上线；
5. 真实学生案例、真实课程目录和授权规则未到位前，不导入真实资料、不宣称学生画像或课程规划业务验收完成；
6. 学生事实、证据和知识库案例继续分域；讲座案例不能被复制为学生事实，模型参数不能扩大服务端授权范围；
7. 继续记录真实搜索使用中的未命中、误命中和过滤错误，只依据确认后的评测调整字段权重或查询协议；
8. 只有确认后的评测证明关键词检索不足时，再讨论同义词、向量或混合检索。

不要在这一阶段提前引入 Skill Registry、Multi-Agent 运行时、AnythingLLM、向量数据库或真实学生数据。
