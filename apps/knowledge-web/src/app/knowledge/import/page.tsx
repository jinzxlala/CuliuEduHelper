import { notFound } from "next/navigation";
import type { JSX } from "react";
import {
  listKnowledgeTranscriptSubmissions,
  readLatestKnowledgeTranscriptSubmission,
} from "@culiu/knowledge-ingest";

import { KnowledgeImportForms } from "../../../components/knowledge-import-form";
import { requireActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";

export default async function KnowledgeImportPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  if (principal.role !== "admin" && principal.role !== "advisor") notFound();
  const databaseClient = getDatabaseClient();
  const [initialTranscriptSubmission, transcriptSubmissions] = await Promise.all([
    readLatestKnowledgeTranscriptSubmission(databaseClient, principal),
    listKnowledgeTranscriptSubmissions(databaseClient, principal),
  ]);
  return (
    <main className="workspace-shell knowledge-import-page">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Knowledge governance</p>
          <h1>提交新讲座</h1>
          <p>
            顾问可以提交一份逐字稿，由系统生成待审核的分析稿；同一来源键再次发布表示修订该讲座，不会删除其他讲座。
          </p>
        </div>
      </header>
      <section className="editor-panel naming-guide">
        <h2>文件要求</h2>
        <p>
          每次只需上传一份 UTF-8 Markdown 或现代 Word 文档，文件名必须使用
          <code>YYYY-MM-DD_讲座标题</code> 格式，例如：
        </p>
        <pre>{`2026-08-02_人工智能与跨学科申请.md
2026-08-02_人工智能与跨学科申请.docx`}</pre>
        <p>
          旧版二进制 <code>.doc</code> 文件暂不支持，请先在 Word 中另存为 <code>.docx</code>。
        </p>
      </section>
      <KnowledgeImportForms
        canDirectImport={principal.role === "admin"}
        initialTranscriptSubmission={initialTranscriptSubmission}
        transcriptSubmissions={transcriptSubmissions}
      />
      <section className="editor-panel prompt-panel">
        <h2>系统如何处理</h2>
        <ol>
          <li>原始文件进入不可变文件存储，提取出的逐字稿正文同时写入数据库。</li>
          <li>系统先移除常见邮箱、手机号和长身份号码，再由 Worker 调用 DeepSeek。</li>
          <li>DeepSeek 按九部分结构生成分析草稿；逐字稿和草稿都不会直接进入公开搜索。</li>
          <li>提交人或管理员核对、编辑并确认后，分析稿才会发布到讲座和匿名案例知识库。</li>
        </ol>
      </section>
    </main>
  );
}
