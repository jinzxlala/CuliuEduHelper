# 知识来源与搜索评测资产

`source-manifest.v1.json` 是 48 场 EDU KNOW 讲座资料的确定性来源清单。本文件只记录逻辑路径、内容哈希、字节数、标题、章节结构和交叉校验统计，不包含分析正文、逐字稿正文、源文件内嵌的本机绝对路径或真实学生资料。

## 当前边界

- 清单生成是只读操作，不会修改 `data_origin/` 或外部逐字稿目录。
- 清单不是导入授权：生成和校验清单不会写入 PostgreSQL、Meilisearch、Redis 或对象存储。
- 分析稿属于匿名内部知识，可作为后续 `lectures` 和 `cases` 的主要来源。
- 清洗后的逐字稿 JSON 属于受限证据；只有通过独立隐私复核和匿名化门禁后，才能成为 `transcript_segments` 的来源。
- SRT、带时间戳 TXT 和 QA JSON 只用于校验时间、文本、数量和清洗统计，不作为索引输入。
- QA JSON 中的 `source_sha256` 指向清洗前的 ASR JSON，不应与当前清洗后 JSON 的哈希比较。
- `_整理汇总.json` 是聚合文件，不属于单场讲座的一手来源，已在清单中明确记录为排除项。

## 重新生成

先构建生成器：

```powershell
pnpm --filter @culiu/knowledge-ingest build
```

将本机两个逐字稿目录赋给临时变量，再运行：

```powershell
$transcript2025 = '<2025逐字稿目录>'
$transcript2026 = '<2026逐字稿目录>'

pnpm knowledge:manifest:build `
  --analysis-root '.\data_origin' `
  --transcript-root "2025=$transcript2025" `
  --transcript-root "2026=$transcript2026" `
  --output '.\knowledge\source-manifest.v1.json'
```

生成器要求 48 个分析稿文件名与 48 组逐字稿文件名完全对应；每组必须同时具有 `.json`、`.qa.json`、`.srt` 和 `.txt`。任何缺项、额外日期组、重复角色、UTF-8 错误、章节缺失、Schema 漂移、时间戳不一致、文本不一致或 QA 计数不一致都会使命令失败。

## 验证

```powershell
pnpm --filter @culiu/knowledge-ingest typecheck
pnpm --filter @culiu/knowledge-ingest lint
pnpm --filter @culiu/knowledge-ingest test
```

测试使用完全虚构的临时夹具，不读取真实来源正文；其中还会校验已提交清单的 Schema、哈希、48 场／240 个文件完整性和绝对路径防泄漏约束。

## 搜索金标查询

`search-gold.v1.json` 是版本化搜索回归集，不是知识来源文件。它只保存查询、结构化过滤条件、预期／禁止命中的文档ID、关键级别、标签和审核状态，不保存来源正文或密钥。

- fixture必须与`source-manifest.v1.json`的语料ID、语料哈希、映射版本和清单版本完全一致；
- 当前50条查询由Code Agent起草并保持`draft`，需要项目负责人逐条确认后才能改为`approved`；
- 技术门禁为Top-5命中率不低于85%、关键查询100%、硬过滤100%、禁止命中100%以及端到端P95不超过500ms；
- 正式索引仍有0条逐字稿正文，因此当前不能用虚构数据替代逐字稿与时间戳业务验收；
- 评测结果只能揭示当前检索表现，不得反向修改预期ID来掩盖真实召回问题。

```powershell
pnpm search:gold:validate
pnpm search:gold:evaluate
pnpm search:gold:evaluate -- --require-approved
```
