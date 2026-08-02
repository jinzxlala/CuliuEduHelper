import { notFound } from "next/navigation";
import type { JSX } from "react";

import { KnowledgeImportForms } from "../../../components/knowledge-import-form";
import { requireActiveSessionPrincipal } from "../../../lib/auth-session";

const ANALYSIS_PROMPT = `你是一名严谨的教育研究资料分析员。请仅依据我提供的逐字稿，输出UTF-8 Markdown，不补充未出现的事实，不把推测写成事实，并对学生信息做匿名化。\n\n必须使用一个一级标题，并按顺序输出且只输出以下九个二级标题：\n## 基础信息\n## 摘要\n## 趋势\n## 案例卡片\n## AI+与跨学科\n## 失败与反例\n## 关键原话\n## 醋溜科技行动建议\n## 证据边界\n\n“案例卡片”下至少使用一个三级标题，每张卡片用“字段：内容”或两列表格记录背景、课程体系、学校、专业、研究/活动、AI使用深度、结果、可信度和证据边界。无法确认的字段明确写“未披露”或“无法确认”。关键原话必须来自逐字稿；没有可靠时间戳时不得编造时间。`;

export default async function KnowledgeImportPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  if (principal.role !== "admin") notFound();
  return (
    <main className="workspace-shell knowledge-import-page">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Knowledge governance</p>
          <h1>导入新讲座</h1>
          <p>
            新讲座会形成新的不可变发布批次；同一来源键再次提交表示修订该讲座，不会删除其他讲座。
          </p>
        </div>
      </header>
      <section className="editor-panel naming-guide">
        <h2>文件命名要求</h2>
        <p>
          所有文件必须使用同一个 <code>YYYY-MM-DD_讲座标题</code> 基名，例如：
        </p>
        <pre>{`2026-08-02_人工智能与跨学科申请.md\n2026-08-02_人工智能与跨学科申请.json\n2026-08-02_人工智能与跨学科申请.qa.json\n2026-08-02_人工智能与跨学科申请.srt\n2026-08-02_人工智能与跨学科申请.txt`}</pre>
      </section>
      <KnowledgeImportForms />
      <section className="editor-panel prompt-panel">
        <h2>将逐字稿转换为分析稿的提示词</h2>
        <p>复制下面提示词，并在其后附上逐字稿。生成后仍需人工核对原文和证据边界。</p>
        <textarea aria-label="逐字稿分析提示词" readOnly rows={18} value={ANALYSIS_PROMPT} />
      </section>
    </main>
  );
}
