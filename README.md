# CuliuEduHelper

醋溜教育智能助手。当前 MVP 采用 Node.js / TypeScript 单仓库架构；本地预备环境先部署独立的 Meilisearch 全文检索服务。

## 工程基线

仓库采用 pnpm + Turborepo：

```text
apps/web       Next.js页面和业务API
apps/worker    独立后台任务进程
packages/shared 共享Schema与类型
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

### 清空本地搜索数据

> **危险：以下命令会永久删除PostgreSQL正式数据、Redis队列数据以及全部Meilisearch索引。**

```powershell
docker compose --env-file .\infra\.env -f .\infra\docker-compose.yml down -v
```

执行后可重新运行初始化脚本，恢复三个空索引。当前 Meilisearch 索引设计为可由正式数据库和原始文件重建，不应作为唯一事实来源。
