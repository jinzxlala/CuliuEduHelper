# CuliuEduHelper Agent 工作说明

本文件记录当前工程状态和后续开发约束。任何 Code Agent 开始修改前，应先阅读本文件与根目录的 `project_design.md`；如果两者发生冲突，以最新版本的 `project_design.md` 和用户当前指令为准。

## 1. 项目定位与当前阶段

- 项目名称：醋溜教育智能助手（CuliuEduHelper）。
- MVP 主架构：Node.js／TypeScript 单仓库、Next.js 全栈应用、独立 Node Worker、PostgreSQL、Redis／BullMQ、Meilisearch，以及可替换的模型适配层。
- 当前已完成本地 Meilisearch 预备环境、工程脚手架与质量基线、阶段 0 数据基础设施与边界，以及阶段 1 的首个独立模块“搜索领域契约与服务层”。
- 模型接口、搜索业务页面、正式数据导入器和完整用户流程尚未实现；不要把搜索服务基础层误报为阶段 1 或业务 MVP 已完成。
- `data_origin/` 中的资料尚未导入搜索引擎；不要在没有明确任务和数据映射方案时直接批量写入索引。
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

三个正式目标索引已经创建，目前应保持空数据状态：

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
- 三个目标索引存在、主键正确且文档数均为 0；
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

`pnpm check` 依次执行格式检查、潜在密钥扫描、Lint、严格类型检查、迁移一致性、34 个单元测试、Web／Worker 生产构建，以及首页和 `/api/health` 的真实 HTTP 冒烟测试。上述流程已在本机环境和一次性官方 Node.js 22 Docker 容器中通过。开发机当前 Node.js 主版本不是 22 时会出现 engine 警告，正式兼容性以 Node.js 22／CI 验收为准。

`infra/.env` 中的 `DEEPSEEK_API_KEY` 已做存在、非空、格式与最小长度检查，但本模块未调用 DeepSeek；不得在日志、文档、测试夹具或回复中输出密钥值。后续模型模块仍须通过服务端适配器读取。

## 8. 阶段 0 数据基础设施与边界

截至 2026-08-01，已完成并验证：

- `infra/docker-compose.yml` 固定使用 PostgreSQL `16.14-bookworm` 和 Redis `7.4.10-alpine3.21`，仅绑定 `127.0.0.1`，使用独立命名卷、健康检查、资源上限和日志轮转；
- `infra/setup-foundation.ps1` 会保留已有真实密钥和其他环境变量，替换缺失、空白或仍为 `replace-...` 的本地占位值，启动服务后执行幂等迁移和脱敏 fixture；
- `packages/database` 使用 Drizzle，初始迁移包含正式数据、冻结授权上下文、任务状态、审计事件、知识／学生数据域和不可变证据约束；
- `packages/tasks` 提供 BullMQ 任务信封、Zod 复验、幂等任务 ID 与冻结授权上下文引用；任务不得携带新的学生 ID 来扩大 Worker 权限范围；
- `packages/storage` 提供 SHA-256 寻址的本地不可变文件适配器，`knowledge/` 与 `student/<student-id>/` 路径严格分离，不提供覆盖或删除接口；
- `docs/adr/0002-data-infrastructure-boundaries.md` 是本模块边界决策记录；
- `pnpm test:integration` 已在 Windows 本机和 Node.js 22 Linux 容器中通过：5 项 PostgreSQL 迁移／约束测试与 1 项 Redis／BullMQ 幂等测试；
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
- 17 项搜索单元测试和 6 项真实 Meilisearch 集成测试已通过，覆盖严格 Schema、引用完整性、配置密钥优先级、硬过滤、分面、高亮、短语检索、证据读取、索引幂等和三索引原子替换；
- 仓库级 `pnpm check` 与 `pnpm test:integration` 已在 Windows 本机和 Node.js 22.23.2 Linux 一次性容器中通过；集成总计 5 项 PostgreSQL、1 项 Redis／BullMQ 和 6 项 Meilisearch 测试；
- 测试结束后临时索引数为 0，三个正式索引文档数仍均为 0；`data_origin/` 未被读取或导入。

本模块明确不包含正式 48 份来源映射、增量 Worker 导入、50 条金标查询、Web 搜索页面、同义词或向量检索。下一轮不得跳过来源清单与证据映射直接批量写索引。

## 10. 破坏性操作与工作区保护

以下命令会永久删除本地 PostgreSQL、Redis 和 Meilisearch 的全部命名卷，只有在用户明确要求重置全部本地数据时才能执行：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down -v
```

普通停止服务应使用不带 `-v` 的 `down`，以保留数据库、队列和索引：

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down
```

当前工作区可能包含用户已有的删除和未跟踪文件。不要擅自恢复、覆盖、移动、删除、暂存或提交与当前任务无关的内容。尤其不要假设所有 `git status` 变化都由当前 Agent 产生。

## 11. 下一阶段建议边界

阶段 0 与阶段 1 的搜索契约／服务层已完成。下一个独立模块继续 `dev_plan.md` 阶段 1，合理顺序是：

1. 明确 `data_origin/` 到 `lectures`、`cases`、`transcript_segments` 的只读来源清单与证据映射；
2. 编写可重复、可审计、相同哈希零业务变更的 Worker 导入器；
3. 建立至少 50 条中文搜索金标查询；
4. 评估 Meilisearch 中文召回、筛选和证据时间戳跳转；
5. 只有评测证明关键词检索不足时，再讨论同义词、向量或混合检索。

不要在这一阶段提前引入 Skill Registry、Multi-Agent 运行时、AnythingLLM、向量数据库或真实学生数据。
