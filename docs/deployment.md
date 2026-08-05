# 腾讯云单机部署说明

本说明对应 MVP 的可配置部署包。它不会在缺少服务器、域名、证书和网络策略时自动完成真实上线，也不代表真实学生或课程数据已经通过业务验收。

## 1. 部署边界

生产拓扑固定为单台 Linux 服务器上的 Docker Compose：

```text
Internet -> 80/443 -> Nginx -> Knowledge Web（独立域名）
                              -> Operations Web（独立域名）
Knowledge Web -----------------> PostgreSQL / Redis / Meilisearch / 对象目录
Operations Web ----------------> PostgreSQL / Redis / 对象目录
Worker ------------------------> PostgreSQL / Redis / Meilisearch / 对象目录
```

只有 Nginx 监听公网端口。PostgreSQL 和 Meilisearch 额外绑定两个 `127.0.0.1` 维护端口，供服务器本机执行加密备份和恢复验收；它们不得绑定 `0.0.0.0`，也不得在腾讯云安全组中放行。Redis 没有宿主机端口。

当前文件存储使用服务器挂载目录。若后续改用腾讯云 COS，应新增受测的存储适配器后再迁移，不能把 COS 管理密钥放入浏览器或前端环境变量。

## 2. 上线前输入

需要项目负责人或服务器管理员提供并确认：

- 一台运行受支持 Linux 和 Docker Engine／Compose v2 的腾讯云服务器；
- 两个实际域名，分别用于顾问知识系统和内部教务系统，且 DNS 均已指向服务器；
- 该域名的完整证书链和私钥；
- 安全组只开放必要的 SSH 管理来源、80 和 443；
- 五个互不嵌套的持久目录：证据、加密备份、知识分析、2025 逐字稿、2026 逐字稿；
- 将要部署的 40 位 Git 提交 SHA；
- 独立生成的数据库、Redis、Meilisearch、两套Auth.js会话密钥、备份加密密钥和DeepSeek API Key；知识系统与教务系统不得复用会话密钥。

生产环境不得启用脱敏 fixture 授权、mock 模型或开发数据库。真实学生资料和课程目录仍受 `dev_plan.md` 的人工输入门禁约束。

## 3. 配置与预检

在服务器的仓库根目录执行：

```bash
cp infra/deploy/.env.production.example infra/deploy/.env.production
chmod 600 infra/deploy/.env.production
```

使用 `openssl rand -base64 48` 分别生成各项密钥，不要复用。数据库和 Redis 密码写入 URL 时必须进行 URL 编码。`CULIU_IMAGE_TAG` 必须与 `CULIU_GIT_COMMIT_SHA` 完全相同，确保运行镜像可追溯到唯一提交。

将证书和私钥放入配置指定位置，权限只授予服务器管理员和 Docker。

证据目录必须允许容器内 UID/GID `1000:1000` 读写，三个知识源目录只需允许该 UID/GID 读取；备份目录只授予执行运维 CLI 的服务器账号。应由服务器管理员按现有磁盘和账号策略设置所有权与权限，不要使用 `chmod 777`。

然后运行：

```bash
pnpm deploy:check
docker compose \
  --env-file infra/deploy/.env.production \
  -f infra/deploy/docker-compose.production.yml \
  config --quiet
```

预检会检查两个真实域名、内部服务地址、密钥门槛、两套会话密钥隔离、镜像提交身份、端口冲突、持久目录、目录互相嵌套和 PEM 文件头。成功回执只显示域名、HTTPS 端口、提交 SHA 和检查数量，不显示密钥。

## 4. 构建和启动

```bash
docker compose \
  --env-file infra/deploy/.env.production \
  -f infra/deploy/docker-compose.production.yml \
  build --pull

docker compose \
  --env-file infra/deploy/.env.production \
  -f infra/deploy/docker-compose.production.yml \
  up -d

docker compose \
  --env-file infra/deploy/.env.production \
  -f infra/deploy/docker-compose.production.yml \
  ps
```

`migrate` 是一次性容器：等待 PostgreSQL 健康后应用已有迁移，成功退出后两个Web和Worker才会启动。知识系统的`/api/ready`探测PostgreSQL、Redis、Meilisearch和对象目录；教务系统不依赖Meilisearch，只探测PostgreSQL、Redis和对象目录。Nginx只在两个Web都健康后启动。

检查外部入口：

```bash
curl -I "http://知识系统域名/"
curl --fail --show-error "https://知识系统域名/api/ready"
curl --fail --show-error "https://教务系统域名/api/ready"
```

第一条应跳转到 HTTPS；第二条应返回 `status=ready`。回执只显示依赖可用性，不返回连接串、路径或异常详情。

## 5. 创建首次管理员

管理员密码至少 14 位，并包含大小写字母、数字和符号。不要把密码写入 `.env.production` 或命令参数。交互读取后只注入一次性容器：

```bash
read -rsp "首次管理员密码: " CULIU_BOOTSTRAP_ADMIN_PASSWORD
echo
export CULIU_BOOTSTRAP_ADMIN_PASSWORD
docker compose \
  --env-file infra/deploy/.env.production \
  -f infra/deploy/docker-compose.production.yml \
  --profile tools run --rm admin \
  --email admin@your-domain.example --display-name "系统管理员"
unset CULIU_BOOTSTRAP_ADMIN_PASSWORD
```

数据库内一旦存在可交互密码账号，初始化命令会永久拒绝再次执行。管理员也不自动获得所有学生权限，仍需显式学生级授权。

## 6. 日常运维

```bash
# 查看状态
docker compose --env-file infra/deploy/.env.production -f infra/deploy/docker-compose.production.yml ps

# 查看最近日志；不要把完整日志复制到公开渠道
docker compose --env-file infra/deploy/.env.production -f infra/deploy/docker-compose.production.yml logs --tail 200 knowledge-web operations-web worker nginx

# 重启应用，不删除数据卷
docker compose --env-file infra/deploy/.env.production -f infra/deploy/docker-compose.production.yml restart knowledge-web operations-web worker nginx

# 停止服务但保留数据卷
docker compose --env-file infra/deploy/.env.production -f infra/deploy/docker-compose.production.yml down
```

证书续期后更新宿主机证书文件，再执行 `docker compose ... restart nginx`。每次部署都应记录提交 SHA、操作者、时间、迁移结果、健康检查和回滚决定。

### 加密备份与恢复验收

备份前暂停两个Web和Worker写入。服务器仓库中的`infra/.env`可以保存一份仅供运维CLI使用、权限为`600`的配置；它不得进入Git。生产Compose的PostgreSQL与Meilisearch维护端口只监听回环地址，CLI应分别使用：

```dotenv
DATABASE_URL=${SERVER_LOCAL_DATABASE_URL}
MEILI_HOST=http://127.0.0.1:<MEILI_MAINTENANCE_PORT>
POSTGRES_CONTAINER_NAME=<生产配置中的容器名>
BACKUP_ROOT=<BACKUP_HOST_PATH的同一目录>
LOCAL_STORAGE_ROOT=<LOCAL_STORAGE_HOST_PATH的同一目录>
KNOWLEDGE_ANALYSIS_ROOT=<KNOWLEDGE_ANALYSIS_HOST_PATH的同一目录>
KNOWLEDGE_TRANSCRIPT_2025_ROOT=<KNOWLEDGE_TRANSCRIPT_2025_HOST_PATH的同一目录>
KNOWLEDGE_TRANSCRIPT_2026_ROOT=<KNOWLEDGE_TRANSCRIPT_2026_HOST_PATH的同一目录>
```

其余密钥与 `infra/deploy/.env.production` 保持一致但不要复制到日志。随后按 [README 的备份步骤](../README.md#加密备份与实际恢复验收)执行 `pnpm backup:create` 和 `pnpm backup:verify`。恢复验收必须在维护窗口内实际成功，不能只检查备份目录存在。

## 7. 更新与回滚

更新前先完成并验证加密备份，再检出目标提交，把两个 SHA 变量改为该提交，执行预检、构建和 `up -d`。不要使用 `latest` 镜像标签。

迁移失败时，`migrate` 会非零退出，Web/Worker 不会换成可用状态。应用回滚应检出上一已验收提交并使用其 SHA 重新构建。数据库迁移默认只向前；若新迁移已经成功且需要回退数据库，必须先停止写入并从已验证备份恢复到隔离环境，确认后再安排正式恢复，不能临时手写逆向 SQL。

## 8. 破坏性操作

> **危险：以下命令会永久删除生产 PostgreSQL、Redis 和 Meilisearch 数据卷。日常停止、重启、更新和排障都不得使用。只有在明确批准彻底销毁该部署，并完成可恢复备份后才能执行。**

```bash
docker compose \
  --env-file infra/deploy/.env.production \
  -f infra/deploy/docker-compose.production.yml \
  down -v
```

删除宿主机证据目录或加密备份目录不受 Compose 管理，风险更高；本部署包不提供自动删除命令。

## 9. 本包尚未完成的事项

- 未取得真实服务器、域名和证书，因此没有宣称腾讯云真实上线；
- 未决定 VPN、统一登录、COS、异地备份位置和备份保留周期；
- 未导入真实学生资料或真实课程目录；
- 真实业务验收、金标查询签字和逐字稿隐私审批仍需项目负责人完成。
