"use client";

import type {
  KnowledgeTranscriptSubmissionSummary,
  KnowledgeTranscriptSubmissionView,
} from "@culiu/knowledge-ingest";
import { useRouter } from "next/navigation";
import { type JSX, type SyntheticEvent, useEffect, useState } from "react";

type State = { kind: "error" | "success"; message: string } | null;
type SubmissionStatus = KnowledgeTranscriptSubmissionView;

const submissionStatusLabels: Readonly<Record<SubmissionStatus["status"], string>> = {
  draft_ready: "提取稿待审核",
  failed: "提取失败",
  processing: "提取处理中",
  published: "已发布",
  queued: "等待处理",
};

function formatLogTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatSubmissionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function messageFrom(body: Record<string, unknown>, fallback: string): string {
  return typeof body.message === "string" ? body.message : fallback;
}

function summaryFromSubmission(submission: SubmissionStatus): KnowledgeTranscriptSubmissionSummary {
  return {
    completedAt: submission.completedAt,
    createdAt: submission.createdAt,
    originalFileName: submission.originalFileName,
    sourceKey: submission.sourceKey,
    status: submission.status,
    submissionId: submission.submissionId,
    updatedAt: submission.updatedAt,
  };
}

function TranscriptImportForm({
  initialSubmission,
  initialSubmissions,
}: Readonly<{
  initialSubmission: SubmissionStatus | null;
  initialSubmissions: readonly KnowledgeTranscriptSubmissionSummary[];
}>): JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<State>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(
    initialSubmission?.submissionId ?? null,
  );
  const [status, setStatus] = useState<SubmissionStatus | null>(initialSubmission);
  const [draft, setDraft] = useState(initialSubmission?.generatedAnalysisMarkdown ?? "");
  const [submissions, setSubmissions] =
    useState<readonly KnowledgeTranscriptSubmissionSummary[]>(initialSubmissions);
  const [loadingSubmissionId, setLoadingSubmissionId] = useState<string | null>(null);

  async function loadSubmission(nextSubmissionId: string): Promise<void> {
    setLoadingSubmissionId(nextSubmissionId);
    setState(null);
    try {
      const response = await fetch(
        `/api/knowledge/imports?id=${encodeURIComponent(nextSubmissionId)}`,
        { cache: "no-store" },
      );
      const body = await responseJson(response);
      if (!response.ok) throw new Error(messageFrom(body, "无法读取该提取任务。"));
      const next = body as unknown as SubmissionStatus;
      setSubmissionId(next.submissionId);
      setStatus(next);
      setDraft(next.generatedAnalysisMarkdown ?? "");
      setSubmissions((current) =>
        current.map((item) =>
          item.submissionId === next.submissionId ? summaryFromSubmission(next) : item,
        ),
      );
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "无法读取该提取任务。",
      });
    } finally {
      setLoadingSubmissionId(null);
    }
  }

  useEffect(() => {
    if (
      submissionId === null ||
      status?.status === "draft_ready" ||
      status?.status === "failed" ||
      status?.status === "published"
    ) {
      return;
    }
    let canceled = false;
    const timer = window.setTimeout(() => {
      void fetch(`/api/knowledge/imports?id=${encodeURIComponent(submissionId)}`, {
        cache: "no-store",
      })
        .then(async (response) => {
          const body = await responseJson(response);
          if (!response.ok) throw new Error(messageFrom(body, "无法读取提取任务状态。"));
          if (!canceled) {
            const next = body as unknown as SubmissionStatus;
            setStatus(next);
            if (next.generatedAnalysisMarkdown !== null) setDraft(next.generatedAnalysisMarkdown);
            setSubmissions((current) =>
              current.map((item) =>
                item.submissionId === next.submissionId ? summaryFromSubmission(next) : item,
              ),
            );
          }
        })
        .catch((error: unknown) => {
          if (!canceled) {
            setState({
              kind: "error",
              message: error instanceof Error ? error.message : "无法读取提取任务状态。",
            });
          }
        });
    }, 1_500);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [status, submissionId]);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setState(null);
    setStatus(null);
    setDraft("");
    try {
      const formData = new FormData(form);
      const submittedTranscript = formData.get("transcript");
      const response = await fetch("/api/knowledge/imports", {
        body: formData,
        method: "POST",
      });
      const body = await responseJson(response);
      if (!response.ok)
        throw new Error(messageFrom(body, `提交失败（${String(response.status)}）`));
      if (typeof body.submissionId !== "string") throw new Error("服务端没有返回任务编号。");
      setSubmissionId(body.submissionId);
      const submittedAt = new Date().toISOString();
      const queuedSubmission: SubmissionStatus = {
        completedAt: null,
        createdAt: submittedAt,
        failureCode: null,
        failureMessage: null,
        generatedAnalysisMarkdown: null,
        logs: [
          {
            at: submittedAt,
            code: "task_queued",
            level: "info",
            message: "逐字稿已保存，正在等待 Worker 领取任务。",
          },
        ],
        originalFileName:
          submittedTranscript instanceof File ? submittedTranscript.name : "已提交逐字稿",
        publishedBatchId: null,
        sourceKey: "",
        status: "queued",
        submissionId: body.submissionId,
        updatedAt: submittedAt,
      };
      setStatus(queuedSubmission);
      setSubmissions((current) => [
        {
          completedAt: null,
          createdAt: submittedAt,
          originalFileName: queuedSubmission.originalFileName,
          sourceKey: "",
          status: "queued",
          submissionId: body.submissionId as string,
          updatedAt: submittedAt,
        },
        ...current,
      ]);
      form.reset();
      setState({ kind: "success", message: "逐字稿已保存，DeepSeek 提取任务已进入队列。" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "提交失败。" });
    } finally {
      setPending(false);
    }
  }

  async function publishDraft(): Promise<void> {
    if (submissionId === null) return;
    setPending(true);
    setState(null);
    try {
      const response = await fetch("/api/knowledge/imports", {
        body: JSON.stringify({ analysisMarkdown: draft, submissionId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const body = await responseJson(response);
      if (!response.ok)
        throw new Error(messageFrom(body, `发布失败（${String(response.status)}）`));
      setStatus((current) => (current === null ? null : { ...current, status: "published" }));
      setSubmissions((current) =>
        current.map((item) =>
          item.submissionId === submissionId ? { ...item, status: "published" } : item,
        ),
      );
      setState({ kind: "success", message: "人工确认完成，讲座与案例已经正式发布。" });
      router.refresh();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "发布失败。" });
    } finally {
      setPending(false);
    }
  }

  const statusText =
    status?.status === "queued"
      ? "等待 Worker 处理……"
      : status?.status === "processing"
        ? "DeepSeek 正在提取……"
        : status?.status === "draft_ready"
          ? "提取稿已生成，请核对后发布。"
          : status?.status === "failed"
            ? `提取失败：${status.failureMessage ?? "请稍后重试。"}`
            : status?.status === "published"
              ? "已发布。"
              : null;

  return (
    <section className="editor-panel transcript-import-panel">
      <p className="eyebrow">Transcript to reviewed analysis</p>
      <h2>上传逐字稿并自动提取</h2>
      <p>
        接受 UTF-8 Markdown 或 Word <code>.docx</code>。系统保存原文件和正文，由 Worker 调用
        DeepSeek 生成九部分分析草稿；草稿经人工核对后才会发布。
      </p>
      <form className="knowledge-import-form" onSubmit={(event) => void onSubmit(event)}>
        <input name="mode" type="hidden" value="transcript" />
        <label>
          逐字稿文件
          <input
            accept=".md,.docx,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            name="transcript"
            required
            type="file"
          />
        </label>
        <label className="confirmation-row">
          <input name="outboundConfirmed" required type="checkbox" value="true" />
          <span>
            我已确认该逐字稿可以发送至系统配置的 DeepSeek 服务，且不包含不应出站的身份或敏感信息。
          </span>
        </label>
        <button disabled={pending} type="submit">
          {pending ? "保存并创建任务中……" : "保存逐字稿并生成提取稿"}
        </button>
      </form>
      <section className="transcript-submission-history" aria-labelledby="submission-history-title">
        <div className="submission-history-heading">
          <h3 id="submission-history-title">逐字稿与提取稿记录</h3>
          <span>共 {submissions.length} 条</span>
        </div>
        {submissions.length === 0 ? (
          <p>当前账号尚未提交逐字稿。</p>
        ) : (
          <ul>
            {submissions.map((item) => (
              <li key={item.submissionId}>
                <button
                  aria-pressed={item.submissionId === submissionId}
                  disabled={loadingSubmissionId !== null}
                  onClick={() => void loadSubmission(item.submissionId)}
                  type="button"
                >
                  <span className="submission-file-name">{item.originalFileName}</span>
                  <span className={`submission-status ${item.status}`}>
                    {loadingSubmissionId === item.submissionId
                      ? "读取中……"
                      : submissionStatusLabels[item.status]}
                  </span>
                  <time dateTime={item.createdAt}>{formatSubmissionTime(item.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {statusText === null ? null : <p className="task-status">{statusText}</p>}
      {status === null ? null : (
        <section aria-live="polite" aria-relevant="additions text" className="task-log" role="log">
          <div className="task-log-heading">
            <h3>提取日志</h3>
            <span>{status.status === "processing" ? "自动刷新中" : "最新状态"}</span>
          </div>
          <ol>
            {status.logs.map((entry, index) => (
              <li
                className={`task-log-entry ${entry.level}`}
                key={`${entry.at}-${entry.code}-${String(index)}`}
              >
                <time dateTime={entry.at}>{formatLogTime(entry.at)}</time>
                <code>{entry.code}</code>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
          <p className="task-log-boundary">
            为保护资料安全，日志不会显示逐字稿正文、DeepSeek 原始响应或服务密钥。
          </p>
        </section>
      )}
      {status?.status === "draft_ready" || status?.status === "published" ? (
        <div className="generated-analysis-editor">
          <label htmlFor="generated-analysis">DeepSeek 生成的分析草稿</label>
          <textarea
            id="generated-analysis"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            readOnly={status.status === "published"}
            rows={28}
            value={draft}
          />
          {status.status === "draft_ready" ? (
            <button
              disabled={pending || draft.trim() === ""}
              onClick={() => {
                void publishDraft();
              }}
              type="button"
            >
              {pending ? "校验并发布中……" : "确认内容并正式发布"}
            </button>
          ) : null}
        </div>
      ) : null}
      {state === null ? null : <p className={`form-message ${state.kind}`}>{state.message}</p>}
    </section>
  );
}

function AnalysisImportForm(): JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<State>(null);
  async function onSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setState(null);
    try {
      const response = await fetch("/api/knowledge/imports", {
        body: new FormData(form),
        method: "POST",
      });
      const body = await responseJson(response);
      if (!response.ok)
        throw new Error(messageFrom(body, `导入失败（${String(response.status)}）`));
      const counts = body.documentCounts as { cases?: unknown; lectures?: unknown } | undefined;
      setState({
        kind: "success",
        message:
          typeof counts?.lectures === "number" && typeof counts.cases === "number"
            ? `发布完成：当前共 ${String(counts.lectures)} 场讲座、${String(counts.cases)} 张案例卡。`
            : "导入已完成。",
      });
      form.reset();
      router.refresh();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "导入失败。" });
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="editor-panel">
      <p className="eyebrow">Prepared analysis</p>
      <h2>管理员直接导入分析 Markdown</h2>
      <p>用于已经人工完成九部分结构化提取的稿件，不调用 DeepSeek。</p>
      <form className="knowledge-import-form" onSubmit={(event) => void onSubmit(event)}>
        <input name="mode" type="hidden" value="analysis" />
        <label>
          分析 Markdown
          <input accept=".md,text/markdown" name="analysis" required type="file" />
        </label>
        <button disabled={pending} type="submit">
          {pending ? "校验并发布中……" : "校验并发布"}
        </button>
      </form>
      {state === null ? null : <p className={`form-message ${state.kind}`}>{state.message}</p>}
    </section>
  );
}

export function KnowledgeImportForms({
  canDirectImport,
  initialTranscriptSubmission,
  transcriptSubmissions,
}: Readonly<{
  canDirectImport: boolean;
  initialTranscriptSubmission: SubmissionStatus | null;
  transcriptSubmissions: readonly KnowledgeTranscriptSubmissionSummary[];
}>): JSX.Element {
  return (
    <div className="knowledge-import-grid">
      <TranscriptImportForm
        initialSubmission={initialTranscriptSubmission}
        initialSubmissions={transcriptSubmissions}
      />
      {canDirectImport ? <AnalysisImportForm /> : null}
    </div>
  );
}
