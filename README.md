# CuliuEduHelper

醋溜教育智能助手。当前 MVP 采用 Node.js / TypeScript 单仓库架构；本地开发环境通过 Docker Compose 运行 PostgreSQL、Redis 和 Meilisearch。

## 工程基线

仓库采用 pnpm + Turborepo：

```text
apps/web       Next.js页面和业务API
apps/worker    独立后台任务进程
packages/shared 共享Schema与类型
packages/database PostgreSQL Schema、迁移与脱敏fixtures
packages/knowledge-ingest 知识源清单、校验、保守解析与幂等导入
packages/search Meilisearch文档契约、查询与原子重建
packages/storage 本地不可变证据存储
packages/tasks BullMQ任务契约与执行器
```

标准运行版本为Node.js 22和pnpm 11.9.0。安装依赖后可执行：

```powershell
pnpm check
```

该命令依次检查格式、潜在密钥、ESLint、严格类型、Drizzle迁移一致性、单元测试、生产构建和Web运行时冒烟。开发机上的其他Node.js主版本不能代替Node.js 22的CI与Docker验证。

## 本地 PostgreSQL、Redis 与证据文件

首次启动或重复应用阶段0基础设施：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-foundation.ps1
```

脚本会保留已有真实密钥和其他环境变量，替换缺失、空白或仍为`replace-...`的本地占位值，并根据本地配置刷新连接URL；随后启动固定版本的PostgreSQL 16与Redis 7.4，等待健康检查，再应用Drizzle迁移并写入幂等的脱敏fixtures。跳过镜像拉取可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-foundation.ps1 -SkipPull
```

常用开发命令：

```powershell
# 检查迁移快照
pnpm migration:check

# 应用迁移及脱敏fixtures（自动读取infra/.env）
pnpm --filter @culiu/database db:migrate
pnpm --filter @culiu/database db:seed

# PostgreSQL与Redis必须在线
pnpm test:integration
```

本地不可变文件适配器按SHA-256寻址，将匿名知识与学生证据写入不同路径。`.local-data/`和`infra/.env`均不进入Git。浏览器端不得读取数据库、Redis或存储密钥。

## 本地 Meilisearch

### 前置条件

- Windows 10/11；
- Docker Desktop 已启动，并使用 Linux containers；
- 新开的 PowerShell 可以执行 `docker version`。

### 首次部署或重复初始化

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup-meilisearch.ps1
```

脚本会：

- 首次运行时在 `infra/.env` 生成本地随机主密钥；
- 拉取固定版本的官方 Meilisearch 镜像；
- 启动仅监听 `127.0.0.1:7700` 的容器；
- 创建或更新 `lectures`、`cases`、`transcript_segments` 三个索引；
- 使用临时数据完成中文关键词和精确短语搜索测试，随后删除临时索引。

三个索引的唯一配置源是 `packages/search/index-definitions.json`，初始化脚本和 TypeScript 服务共同读取它。`@culiu/search` 提供 `searchLectures`、`searchCases`、`searchTranscriptSegments`、`getEvidence` 及受控全量重建能力；调用方必须在服务端注入搜索或管理密钥，浏览器端不得持有任何 Meilisearch 密钥。

`infra/.env` 已被 Git 忽略。不要将主密钥复制到前端代码、浏览器环境变量、提交记录或聊天内容中。

### 常用命令

```powershell
# 查看服务状态
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml ps

# 查看日志
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml logs -f meilisearch

# 停止全部本地基础设施，但保留命名卷
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down

# 重新启动并校验索引配置，不重复拉取镜像
powershell -ExecutionPolicy Bypass -File .\infra\setup-meilisearch.ps1 -SkipPull
```

本地服务地址：`http://127.0.0.1:7700`。`GET /health` 可用于健康检查，其余接口需要服务端持有的 API 密钥。

## 知识库导入 Worker

唯一批次入口是 `knowledge/source-manifest.v1.json`。导入任务不会接受客户端文件路径；Worker只使用`infra/.env`中配置的服务端绝对路径：

```dotenv
KNOWLEDGE_MANIFEST_PATH=D:/.../knowledge/source-manifest.v1.json
KNOWLEDGE_ANALYSIS_ROOT=D:/.../data_origin
KNOWLEDGE_TRANSCRIPT_2025_ROOT=D:/.../2025
KNOWLEDGE_TRANSCRIPT_2026_ROOT=D:/.../2026
LOCAL_STORAGE_ROOT=D:/.../.local-data/evidence
WORKER_CONCURRENCY=1
# 仅限本地脱敏环境；生产环境必须保持false
NODE_ENV=development
KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH=true
```

导入前先执行只读门禁。它会重新检查240个文件的大小、SHA-256、UTF-8及逐字稿四种表示的一致性，并保守解析讲座与案例：

```powershell
pnpm knowledge:import:validate
```

启动Worker后，在另一个PowerShell创建任务：

```powershell
pnpm --filter @culiu/worker start
pnpm knowledge:import:enqueue
```

入队脚本只负责创建任务，不会自动执行迁移或写入fixtures。本地开发必须显式设置`KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH=true`，并依赖基础设施初始化脚本创建的脱敏授权上下文；生产环境禁止该开关，必须通过`KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_ID`和`KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_HASH`提供真实、仍有效的冻结授权上下文。

查看PostgreSQL批次/重试记录和三个Meilisearch索引数量，并运行中文搜索冒烟：

```powershell
pnpm knowledge:import:status
pnpm knowledge:import:smoke
```

相同`corpus_id + corpus_hash + mapping_version + manifest_version`再次导入会返回`already_imported`，不会新增导入尝试、来源关系或业务版本。导入失败由BullMQ最多重试3次，并在PostgreSQL记录失败阶段、错误码、来源角色和安全摘要。数据库任务使用25秒租约和随机claim token；只有当前持有者可以写入完成或失败状态，最后一次尝试崩溃后也会由过期租约恢复为可审计的失败终态。

所有正式知识发布由PostgreSQL全局advisory lock串行化。PostgreSQL是当前正式版本来源；Worker每次启动都会先用数据库当前版本重建三个Meilisearch索引，搜索交换后若数据库最终提交失败也会执行同样的恢复，避免搜索索引长期偏离正式数据。

当前隐私门禁固定禁止发布逐字稿正文：正式导入结果应为48条讲座、169张案例卡和0条`transcript_segments`。只有后续完成逐字稿隐私复核与匿名化机制后，才能通过新的迁移和映射版本解除该数据库约束。

### 清空本地搜索数据

> **危险：以下命令会永久删除PostgreSQL正式数据、Redis队列数据以及全部Meilisearch索引。**

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down -v
```

执行后可重新运行初始化脚本，恢复三个空索引。当前 Meilisearch 索引设计为可由正式数据库和原始文件重建，不应作为唯一事实来源。
