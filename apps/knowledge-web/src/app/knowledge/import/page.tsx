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
            顾问可以批量提交逐字稿，由系统为每份文件独立生成待审核的分析稿；同一来源键再次发布表示修订该讲座，不会删除其他讲座。
          </p>
        </div>
      </header>
      <section className="editor-panel naming-guide">
        <h2>文件要求</h2>
        <p>每批可以上传最多 20 份 UTF-8 Markdown 或现代 Word 文档。旧文件可以保留原名称，例如：</p>
        <pre>{`0401_原文.docx
往期家长讲座逐字稿.md
2026-08-02_人工智能与跨学科申请.docx`}</pre>
        <p>
          系统会把文件名作为线索，并结合逐字稿正文识别讲座日期和主题；识别结果必须在草稿页人工确认后才能发布。无法可靠确定完整日期时，日期会留空等待填写。
        </p>
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
          <li>
            DeepSeek
            综合文件名和正文建议讲座日期、主题，并按九部分结构生成分析草稿；逐字稿和草稿都不会直接进入公开搜索。
          </li>
          <li>提交人或管理员核对、编辑并确认后，分析稿才会发布到讲座和匿名案例知识库。</li>
        </ol>
      </section>
    </main>
  );
}
