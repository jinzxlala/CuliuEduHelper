# CuliuEduHelper Agent 工作说明

本文件记录当前工程状态和后续开发约束。任何 Code Agent 开始修改前，应先阅读本文件与根目录的 `project_design.md`；如果两者发生冲突，以最新版本的 `project_design.md` 和用户当前指令为准。

## 1. 项目定位与当前阶段

- 项目名称：醋溜教育智能助手（CuliuEduHelper）。
- MVP 主架构：Node.js／TypeScript 单仓库、Next.js 全栈应用、独立 Node Worker、PostgreSQL、Redis／BullMQ、Meilisearch，以及可替换的模型适配层。
- 当前已完成本地 Meilisearch 预备环境、工程脚手架与质量基线、阶段 0 数据基础设施与边界，以及阶段 1 的搜索领域契约、48 场知识来源清单、正式 Worker 导入链路、版本化中文搜索评测器和内部知识搜索 Web 流程。
- 50 条中文金标查询已有 Code Agent 草案并通过技术评测，但仍待项目负责人逐条确认；逐字稿时间戳仍受隐私门禁保护，模型接口、学生档案和完整用户流程尚未实现。不要把技术评测或页面可用误报为阶段 1 业务门禁或业务 MVP 已完成。
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

`pnpm check` 依次执行格式检查、潜在密钥扫描、Lint、严格类型检查、迁移一致性、80 个单元测试、Web／Worker 生产构建，以及首页、`/api/health` 和 `/search` 的真实 HTTP 冒烟测试。上述流程已在本机环境通过；本轮 Web 的依赖构建、10 项测试、严格类型检查和生产构建也在一次性官方 Node.js 22.23.2 Docker 容器的隔离副本中通过。开发机当前 Node.js 主版本不是 22 时会出现 engine 警告，正式兼容性以 Node.js 22／CI 验收为准。

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
- Web包现有10项单元测试；仓库级`pnpm check`和20项集成测试通过。Web模块另在官方Node.js 22.23.2 Linux一次性容器的隔离副本中完成依赖构建、测试、严格类型检查和生产构建；
- `infra/.env`继续被Git忽略；`DEEPSEEK_API_KEY`仅确认存在、非空、非占位且长度满足门禁，未输出密钥值，本模块不调用DeepSeek。

本模块的常用入口：

```text
http://127.0.0.1:3000/
http://127.0.0.1:3000/search
```

本地开发应从根目录运行`pnpm dev`，并确保Meilisearch已启动且`infra/.env`可由服务端进程读取。不要把`.env`复制到`apps/web`或改成`NEXT_PUBLIC_*`变量。

## 14. 破坏性操作与工作区保护

以下命令会永久删除本地 PostgreSQL、Redis 和 Meilisearch 的全部命名卷，只有在用户明确要求重置全部本地数据时才能执行：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down -v
```

普通停止服务应使用不带 `-v` 的 `down`，以保留数据库、队列和索引：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down
```

当前工作区可能包含用户已有的删除和未跟踪文件。不要擅自恢复、覆盖、移动、删除、暂存或提交与当前任务无关的内容。尤其不要假设所有 `git status` 变化都由当前 Agent 产生。

## 15. 下一阶段建议边界

阶段0与阶段1的搜索契约、来源清单、正式知识导入、金标技术评测和内部Web搜索流程已完成。阶段1仍有两项必须由项目负责人处理的业务门禁：逐条确认金标查询，以及决定逐字稿能否在独立隐私审核后进入索引。Code Agent不得代替签字或审批。

1. 项目负责人逐条检查`knowledge/search-gold.v1.json`的查询意图和预期ID；Code Agent不得代替业务签字；
2. 下一个可独立开发的技术模块进入`dev_plan.md`阶段2，先实现内部账号、会话、统一授权上下文和跨学生访问负例；当前只允许使用脱敏／虚构fixture；
3. 真实学生案例、课程目录和授权规则未到位前，不导入真实资料、不宣称学生画像业务验收完成；
4. 学生事实、证据和知识库案例继续分域；讲座案例不能被复制为学生事实，模型参数不能扩大服务端授权范围；
5. 继续记录真实搜索使用中的未命中、误命中和过滤错误，只依据确认后的评测调整字段权重或查询协议；
6. 只有确认后的评测证明关键词检索不足时，再讨论同义词、向量或混合检索。

不要在这一阶段提前引入 Skill Registry、Multi-Agent 运行时、AnythingLLM、向量数据库或真实学生数据。
