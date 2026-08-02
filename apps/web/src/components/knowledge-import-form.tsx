"use client";

import { useRouter } from "next/navigation";
import { type JSX, type SyntheticEvent, useState } from "react";

type State = { kind: "error" | "success"; message: string } | null;

async function submit(form: HTMLFormElement): Promise<string> {
  const response = await fetch("/api/knowledge/imports", {
    body: new FormData(form),
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as {
    documentCounts?: { cases: number; lectures: number };
    message?: string;
  } | null;
  if (!response.ok) throw new Error(body?.message ?? `导入失败（${String(response.status)}）`);
  return body?.documentCounts === undefined
    ? "导入已完成。"
    : `发布完成：当前共 ${String(body.documentCounts.lectures)} 场讲座、${String(body.documentCounts.cases)} 张案例卡。`;
}

function ImportForm({ mode }: Readonly<{ mode: "analysis" | "evidence" }>): JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<State>(null);
  async function onSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setState(null);
    try {
      setState({ kind: "success", message: await submit(form) });
      form.reset();
      router.refresh();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "导入失败。" });
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="knowledge-import-form" onSubmit={(event) => void onSubmit(event)}>
      <input name="mode" type="hidden" value={mode} />
      <label>
        分析 Markdown
        <input accept=".md,text/markdown" name="analysis" required type="file" />
      </label>
      {mode === "analysis" ? null : (
        <div className="knowledge-file-grid">
          <label>
            逐字稿 JSON
            <input accept=".json,application/json" name="transcriptJson" required type="file" />
          </label>
          <label>
            QA JSON
            <input accept=".json,application/json" name="transcriptQa" required type="file" />
          </label>
          <label>
            SRT
            <input accept=".srt,application/x-subrip" name="transcriptSrt" required type="file" />
          </label>
          <label>
            时间戳 TXT
            <input accept=".txt,text/plain" name="transcriptText" required type="file" />
          </label>
        </div>
      )}
      <button disabled={pending} type="submit">
        {pending ? "校验并发布中…" : "校验并发布"}
      </button>
      {state === null ? null : <p className={`form-message ${state.kind}`}>{state.message}</p>}
    </form>
  );
}

export function KnowledgeImportForms(): JSX.Element {
  return (
    <div className="knowledge-import-grid">
      <section className="editor-panel">
        <p className="eyebrow">Analysis only</p>
        <h2>仅导入分析 Markdown</h2>
        <p>用于已经完成九部分结构化提取、暂时没有完整逐字稿证据包的讲座。</p>
        <ImportForm mode="analysis" />
      </section>
      <section className="editor-panel">
        <p className="eyebrow">Verified evidence package</p>
        <h2>导入完整证据包</h2>
        <p>
          五个文件会先核对命名、UTF-8、JSON
          Schema、片段数量、时间和正文一致性，再发布讲座与案例。逐字稿正文仍不会进入搜索索引。
        </p>
        <ImportForm mode="evidence" />
      </section>
    </div>
  );
}
