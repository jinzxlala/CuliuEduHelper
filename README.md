# CuliuEduHelper

醋溜教育智能助手。当前 MVP 采用 Node.js / TypeScript 单仓库架构；本地开发环境通过 Docker Compose 运行 PostgreSQL、Redis 和 Meilisearch。

## 工程基线

仓库采用 pnpm + Turborepo：

```text
apps/web       Next.js页面和业务API
apps/worker    独立后台任务进程
packages/shared 共享Schema与类型
packages/database PostgreSQL Schema、迁移与脱敏fixtures
packages/authorization 内部账号、Argon2id密码与学生级授权上下文
packages/knowledge-ingest 知识源清单、校验、保守解析与幂等导入
packages/search Meilisearch文档契约、查询、金标评测与原子重建
packages/storage 本地不可变证据存储
packages/student-records 学生事实、证据定位、版本、失效和授权领域服务
packages/tasks BullMQ任务契约与执行器
packages/operations 加密备份、隔离恢复与Meilisearch重建验收
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

## 内部账号与学生级授权

基础设施脚本会在`infra/.env`缺少配置时生成至少32字节的`NEXTAUTH_SECRET`，并保留已有值。本地`NEXTAUTH_URL`默认为`http://127.0.0.1:3000`；腾讯云部署必须改为实际HTTPS地址，以启用带`Secure`前缀的会话Cookie。Auth.js使用Credentials与最长8小时的JWT会话；Cookie固定为`HttpOnly`、`SameSite=Lax`，生产HTTPS环境同时启用`Secure`。

首次正式使用前，通过一次性CLI创建第一个管理员。命令不接受密码参数，也没有默认密码；密码必须通过进程环境变量提供，至少14位并包含大小写字母、数字和符号。以下PowerShell流程避免将密码写入命令历史：

```powershell
$securePassword = Read-Host "首次管理员密码" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:CULIU_BOOTSTRAP_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  pnpm auth:admin:create -- --email admin@example.com --display-name "系统管理员"
}
finally {
  Remove-Item Env:CULIU_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
```

一旦数据库中存在任意可交互的密码账号，该命令会永久拒绝再次初始化；后续账号应由尚待开发的受审计用户管理流程创建。管理员身份不自动获得全部学生资料，所有账号都必须存在仍有效的显式学生授权。当前入口为：

```text
/login                 内部账号登录
/students              只列出当前账号仍可读取的学生
/students/<student-id> 经服务端授权上下文保护的学生档案
/api/students/<id>     同样执行账号、学生、操作和数据等级校验的业务API
```

每次学生读取都会创建15分钟的最小作用域授权快照，并在实际查询前重新检查账号状态、当前授权、操作和访问等级。即使已有会话，账号停用或学生授权撤销也会立即阻断后续学生API访问；客户端篡改学生ID统一返回404，避免泄露学生是否存在。

学生档案页支持字段化事实录入、事实线性修订、本人证据上传、具体定位、证据版本、受保护下载和追加式失效。稳定业务接口为：

```text
POST /api/students/<id>/facts
POST /api/students/<id>/evidence
GET  /api/students/<id>/evidence/<evidence-id>
POST /api/students/<id>/evidence/<evidence-id>/invalidate
```

事实值、文件名、MIME、文件大小和每类定位均经过严格Schema校验；证据文件最大20 MB，按SHA-256写入`LOCAL_STORAGE_ROOT`下的学生专属路径。原始证据、定位和失效事件不可原地修改或删除；修订会创建新版本。事实引用只能绑定同一学生域内、未失效且未被取代的证据版本，且事实访问等级不能低于引用证据。数据库触发器会再次阻断跨学生、知识域冒充、访问等级降级、分支版本和原地篡改。

Web运行时冒烟使用独立的随机临时PostgreSQL数据库和临时文件目录，执行错误密码、登录Cookie、授权学生、证据上传与下载、事实绑定、证据失效传播、跨学生读写和停用账号测试；结束后删除整个临时数据库与文件目录，不向本地正式环境写入测试账号、证据或不可删除的审计残留。

学生画像草稿通过后台 Worker 生成，浏览器不会获得 DeepSeek 密钥。生成动作要求单独的 `student:profile:generate` 授权，只使用当前已确认、经过脱敏且带有有效学生证据定位的事实；知识库案例不会进入画像输入。稳定接口为：

```text
POST /api/students/<id>/profile-drafts  创建或复用幂等后台任务
GET  /api/students/<id>/profile-drafts  查看任务状态和草稿版本
POST /api/students/<id>/profiles/<profile-id>/revisions   保存完整人工修改为新版本
POST /api/students/<id>/profiles/<profile-id>/transitions 提交、退回、批准或归档
```

本地运行需在 `infra/.env` 配置 `DEEPSEEK_API_KEY`。`infra/setup-foundation.ps1` 会幂等补齐 `PROFILE_MODEL_PROVIDER=deepseek`、`KNOWLEDGE_EXTRACTION_MODEL_PROVIDER=deepseek`，并在每次运行时把 `CULIU_GIT_COMMIT_SHA` 刷新为当前仓库提交。可选的画像模型真实连通探针如下；它只发送虚构请求，但会产生极小的 API 用量，因此不包含在普通 `pnpm check` 中：

```powershell
pnpm profile:model:smoke
```

画像采用 `draft → in_review → approved → needs_review/archived` 状态机。人工修改不会覆盖原结论，而是创建带来源关系的新版本；退回必须填写原因，批准人和批准时间由服务端记录。批准前会重新校验冻结快照和全部学生本人证据；相关事实或证据被修订、替代或失效时，已批准画像会自动转为 `needs_review` 并留下审核与审计记录。`student:profile:review` 与 `student:profile:approve` 是独立授权，浏览器参数不能扩大权限。

Web运行时冒烟还会走通画像生成、人工修订、提交、批准、证据失效后的 `needs_review` 传播及跨学生状态操作拒绝。课程目录、课程规则和规划仍属于后续模块。

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

当前隐私门禁固定禁止发布逐字稿正文到Meilisearch；已提交的初始语料包含48条讲座和169张案例卡，但讲座总数不再设为48条上限。管理员或顾问可从`/knowledge/import`上传一份同名规则的UTF-8 Markdown或`.docx`逐字稿。系统把原文件写入不可变对象存储、把提取出的正文写入PostgreSQL，再由Worker调用DeepSeek生成九部分分析草稿；草稿和人工修订稿均保存在PostgreSQL，只有提交人或管理员明确确认后才发布讲座与匿名案例。管理员仍可单独导入已经人工完成的分析Markdown。每次发布会生成新的不可变当前批次并保留其他讲座；首页和导入结果按当前批次动态显示数量。只有后续完成逐字稿隐私复核与匿名化机制后，才能通过新的迁移和映射版本解除`transcript_segments=0`的数据库约束。

## 中文搜索金标评测

`knowledge/search-gold.v1.json` 是绑定当前语料哈希、映射版本和清单版本的搜索回归集。当前包含50条Code Agent起草的中文查询，其中17条为关键查询；覆盖中文切分、中英文混合名称和缩写、精确短语、证据边界、日期与案例性质硬过滤及禁止命中。它保持`draft`状态，不能冒充项目负责人的业务确认。

先做离线结构与语料身份校验，再对已导入的本地正式索引执行评测：

```powershell
pnpm search:gold:validate
pnpm search:gold:evaluate
```

评测固定取Top-5，同时计算全部查询命中率、关键查询命中率、硬过滤准确率、禁止命中检查和端到端P95延迟。普通评测在技术指标失败时返回非零退出码；`draft`状态会明确显示`release_gate_passed=false`，但不会掩盖技术结果。

项目负责人逐条核对查询意图和预期ID后，才能填写`approval`中的审核人、审核时间并将状态改为`approved`。业务验收使用更严格的命令：

```powershell
pnpm search:gold:evaluate -- --require-approved
```

该命令在技术指标不达标或评测集仍未获批准时均返回非零退出码。当前逐字稿隐私门禁使正式`transcript_segments`数量为0，因此本版不伪造逐字稿正向金标；解除门禁后必须升级fixture版本并加入时间戳证据查询，再重新验收阶段1。不得为了让本评测变绿而先验加入同义词、向量或混合检索。

## 加密备份与实际恢复验收

`@culiu/operations`把PostgreSQL一致性快照和`LOCAL_STORAGE_ROOT`下的不可变对象写入一个独立备份目录。数据库转储、对象文件及包含对象逻辑路径的清单均使用AES-256-GCM加密；公开回执只包含归档ID、时间和加密清单哈希。备份密钥由`infra/setup-foundation.ps1`随机生成到被Git忽略的`infra/.env`，不得复制到仓库、日志或备份目录。

创建备份前应暂停Web和Worker写入，在Docker服务健康后执行：

```powershell
pnpm backup:create
```

实际恢复验收默认选择`BACKUP_ROOT`下最新的完整备份，也可指定某个备份目录：

```powershell
pnpm backup:verify
pnpm backup:verify -- --backup "D:\path\to\completed-backup"
```

恢复验收不会覆盖当前数据库或三个正式搜索索引。它会解密到权限受限的临时目录、逐个复核对象大小和SHA-256、把PostgreSQL转储恢复到随机临时数据库、逐表核对快照行数，并从临时数据库重建三组随机命名的Meilisearch索引。无论成功或失败，临时数据库、临时索引、容器转储和明文文件都会清理；成功与失败结果写入追加式审计日志。

早期脱敏开发夹具有一条固定ID、固定全`c`占位哈希且从未生成实体文件的学生证据记录。`development`／`test`备份会明确记录并复核这一条夹具缺口；任何其他缺失或哈希不符仍立即失败，`production`环境连这条夹具例外也不允许。该例外只用于保留既有开发数据库的可复现性，不能用于真实学生资料或业务验收。

备份目录本身不会自动过期或删除。迁移、复制或删除备份属于敏感运维操作；在确定保留策略和异地存储位置前，不要把备份放入Git、普通共享盘或未加密介质。丢失`BACKUP_ENCRYPTION_KEY`将无法恢复备份，泄露该密钥则会失去备份机密性。

## 腾讯云单机部署包

生产部署包位于 `infra/deploy/`，包含固定镜像版本的 PostgreSQL、Redis、Meilisearch、Web、Worker、一次性迁移和管理员初始化服务，以及只公开 HTTP/HTTPS 的 Nginx 配置。真实配置写入被 Git 忽略的 `infra/deploy/.env.production`；复制示例后必须先执行：

```powershell
pnpm deploy:check
docker compose --env-file .\infra\deploy\.env.production -f .\infra\deploy\docker-compose.production.yml config --quiet
```

完整的服务器输入、密钥生成、构建启动、首次管理员、健康检查、备份、更新回滚和破坏性操作边界见 [腾讯云单机部署说明](docs/deployment.md)。在没有真实服务器、域名、证书和网络策略时，该目录只是可配置且可测试的部署包，不代表已经上线。

### 清空本地搜索数据

> **危险：以下命令会永久删除PostgreSQL正式数据、Redis队列数据以及全部Meilisearch索引。**

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down -v
```

执行后可重新运行初始化脚本，恢复三个空索引。当前 Meilisearch 索引设计为可由正式数据库和原始文件重建，不应作为唯一事实来源。

## 课程目录与确定性规则

`@culiu/course-planning` 提供服务端课程目录基础能力：

- 创建课程稳定身份及不可变草稿版本；
- 通过来源版本创建修订，批准或归档课程版本；
- 创建、修订、批准或归档先修、互斥、年龄、时间冲突和负荷上限规则；
- 读取当前已批准的课程与规则快照，并对指定课程组合执行确定性校验。

课程与规则正式记录保存在 PostgreSQL。当前 MVP 约定只有有效的 `admin` 可以维护和批准目录，`advisor` 与 `auditor` 可以读取已批准快照；浏览器端不得直接写数据库。模型不能覆盖硬规则，规则失败时也不需要调用模型。

本仓库目前没有获批的真实课程目录，自动化测试只在随机临时数据库中使用明确标注的虚构课程，并在测试结束后删除。学生规划、替代方案、例外批准和 Markdown 导出尚未包含在本模块中。

模块验证命令：

```powershell
pnpm --filter @culiu/course-planning test
pnpm --filter @culiu/course-planning test:integration
```

集成测试要求本地 PostgreSQL 在线，会自动创建随机临时数据库、应用全部迁移并在结束后删除；不会向本地开发库写入虚构课程。
