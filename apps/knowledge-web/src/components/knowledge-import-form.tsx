"use client";

import type {
  KnowledgeTranscriptSubmissionSummary,
  KnowledgeTranscriptSubmissionView,
} from "@culiu/knowledge-ingest";
import { useRouter } from "next/navigation";
import { type JSX, type SyntheticEvent, useEffect, useState } from "react";

import {
  MAX_TRANSCRIPT_BATCH_FILES,
  runTranscriptImportBatch,
} from "../lib/batch-transcript-import";

type State = { kind: "error" | "success"; message: string } | null;
type SubmissionStatus = KnowledgeTranscriptSubmissionView;
type BatchUploadItem = {
  fileName: string;
  message: string | null;
  status: "failed" | "queued" | "submitting" | "waiting";
};
type QueuedTranscriptUpload = {
  fileName: string;
  submissionId: string;
  submittedAt: string;
};
type DraftPublicationInput = {
  analysisMarkdown: string;
  lectureDate: string;
  lectureTitle: string;
  submissionId: string;
};

const MAX_DRAFT_PUBLICATION_BATCH = 20;

const submissionStatusLabels: Readonly<
  Record<Exclude<SubmissionStatus["status"], "processing">, string>
> = {
  draft_ready: "提取稿待审核",
  failed: "提取失败",
  published: "已发布",
  queued: "等待处理",
};

function submissionStatusLabel(
  submission: Pick<SubmissionStatus, "processingStage" | "status">,
): string {
  return submission.status === "processing"
    ? submission.processingStage === "publishing"
      ? "校验发布中"
      : "正在提取"
    : submissionStatusLabels[submission.status];
}

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
    processingStage: submission.processingStage,
    sourceKey: submission.sourceKey,
    status: submission.status,
    submissionId: submission.submissionId,
    updatedAt: submission.updatedAt,
  };
}

function queuedSubmissionView(upload: QueuedTranscriptUpload): SubmissionStatus {
  return {
    completedAt: null,
    createdAt: upload.submittedAt,
    failureCode: null,
    failureMessage: null,
    generatedAnalysisMarkdown: null,
    lectureDate: null,
    lectureDateConfidence: "未知",
    lectureDateEvidence: "正在等待模型结合文件名和正文识别。",
    lectureTitle: upload.fileName.replace(/\.(?:md|docx)$/iu, ""),
    lectureTitleConfidence: "未知",
    lectureTitleEvidence: "正在等待模型结合文件名和正文识别。",
    logs: [
      {
        at: upload.submittedAt,
        code: "task_queued",
        level: "info",
        message: "逐字稿已保存，正在等待 Worker 领取任务。",
      },
    ],
    originalFileName: upload.fileName,
    processingStage: null,
    publishedBatchId: null,
    sourceKey: "",
    status: "queued",
    submissionId: upload.submissionId,
    updatedAt: upload.submittedAt,
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
  const [lectureDate, setLectureDate] = useState(initialSubmission?.lectureDate ?? "");
  const [lectureTitle, setLectureTitle] = useState(initialSubmission?.lectureTitle ?? "");
  const [submissions, setSubmissions] =
    useState<readonly KnowledgeTranscriptSubmissionSummary[]>(initialSubmissions);
  const [loadingSubmissionId, setLoadingSubmissionId] = useState<string | null>(null);
  const [batchUploads, setBatchUploads] = useState<readonly BatchUploadItem[]>([]);
  const [selectedFileCount, setSelectedFileCount] = useState(0);
  const [selectedDraftIds, setSelectedDraftIds] = useState<readonly string[]>([]);
  const [batchReviewConfirmed, setBatchReviewConfirmed] = useState(false);

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
      setLectureDate(next.lectureDate ?? "");
      setLectureTitle(next.lectureTitle);
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
            setLectureDate(next.lectureDate ?? "");
            setLectureTitle(next.lectureTitle);
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

  useEffect(() => {
    if (!submissions.some((item) => item.status === "queued" || item.status === "processing")) {
      return;
    }
    let canceled = false;
    let timer: number | undefined;
    const refreshList = async (): Promise<void> => {
      try {
        const response = await fetch("/api/knowledge/imports", { cache: "no-store" });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body)) return;
        if (!canceled) {
          setSubmissions(body as readonly KnowledgeTranscriptSubmissionSummary[]);
        }
      } finally {
        if (!canceled) timer = window.setTimeout(() => void refreshList(), 2_000);
      }
    };
    timer = window.setTimeout(() => void refreshList(), 1_500);
    return () => {
      canceled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [submissions]);

  useEffect(() => {
    const available = new Set(
      submissions.filter((item) => item.status === "draft_ready").map((item) => item.submissionId),
    );
    setSelectedDraftIds((current) => {
      const next = current.filter((id) => available.has(id));
      return next.length === current.length ? current : next;
    });
  }, [submissions]);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("transcript");
    const confirmationInput = form.elements.namedItem("outboundConfirmed");
    const files =
      fileInput instanceof HTMLInputElement && fileInput.files !== null
        ? Array.from(fileInput.files)
        : [];
    if (files.length === 0) {
      setState({ kind: "error", message: "请至少选择一份逐字稿。" });
      return;
    }
    if (files.length > MAX_TRANSCRIPT_BATCH_FILES) {
      setState({
        kind: "error",
        message: `每批最多提交 ${String(MAX_TRANSCRIPT_BATCH_FILES)} 份逐字稿，请分批选择。`,
      });
      return;
    }
    if (!(confirmationInput instanceof HTMLInputElement) || !confirmationInput.checked) {
      setState({ kind: "error", message: "请先确认资料可以发送至 DeepSeek 服务。" });
      return;
    }
    setPending(true);
    setState(null);
    setStatus(null);
    setDraft("");
    setLectureDate("");
    setLectureTitle("");
    setBatchUploads(
      files.map((file) => ({
        fileName: file.name,
        message: null,
        status: "waiting",
      })),
    );
    try {
      const results = await runTranscriptImportBatch(
        files,
        async (file) => {
          const formData = new FormData();
          formData.set("mode", "transcript");
          formData.set("outboundConfirmed", "true");
          formData.set("transcript", file, file.name);
          const response = await fetch("/api/knowledge/imports", {
            body: formData,
            method: "POST",
          });
          const body = await responseJson(response);
          if (!response.ok) {
            throw new Error(messageFrom(body, `提交失败（${String(response.status)}）`));
          }
          if (typeof body.submissionId !== "string") {
            throw new Error("服务端没有返回任务编号。");
          }
          return {
            fileName: file.name,
            submissionId: body.submissionId,
            submittedAt: new Date().toISOString(),
          } satisfies QueuedTranscriptUpload;
        },
        {
          onSettled: (result) => {
            setBatchUploads((current) =>
              current.map((item, index) =>
                index === result.index
                  ? result.status === "fulfilled"
                    ? { ...item, message: "已保存并进入提取队列。", status: "queued" }
                    : {
                        ...item,
                        message:
                          result.error instanceof Error ? result.error.message : "提交失败。",
                        status: "failed",
                      }
                  : item,
              ),
            );
          },
          onStart: (_file, index) => {
            setBatchUploads((current) =>
              current.map((item, itemIndex) =>
                itemIndex === index ? { ...item, status: "submitting" } : item,
              ),
            );
          },
        },
      );
      const queuedUploads = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failedCount = results.length - queuedUploads.length;
      if (queuedUploads.length > 0) {
        const queuedViews = queuedUploads.map(queuedSubmissionView);
        const firstQueued = queuedViews[0];
        if (firstQueued !== undefined) {
          setSubmissionId(firstQueued.submissionId);
          setStatus(firstQueued);
          setLectureTitle(firstQueued.lectureTitle);
        }
        setSubmissions((current) => {
          const newIds = new Set(queuedViews.map((item) => item.submissionId));
          return [
            ...queuedViews.map(summaryFromSubmission),
            ...current.filter((item) => !newIds.has(item.submissionId)),
          ];
        });
      }
      form.reset();
      setSelectedFileCount(0);
      setState({
        kind: queuedUploads.length === 0 ? "error" : "success",
        message:
          failedCount === 0
            ? `本批 ${String(queuedUploads.length)} 份逐字稿均已保存并进入提取队列。`
            : `本批已提交 ${String(queuedUploads.length)} 份，失败 ${String(failedCount)} 份；请查看逐项结果。`,
      });
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
    setStatus((current) =>
      current === null ? null : { ...current, processingStage: "publishing", status: "processing" },
    );
    setSubmissions((current) =>
      current.map((item) =>
        item.submissionId === submissionId
          ? { ...item, processingStage: "publishing", status: "processing" }
          : item,
      ),
    );
    try {
      const response = await fetch("/api/knowledge/imports", {
        body: JSON.stringify({ analysisMarkdown: draft, lectureDate, lectureTitle, submissionId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const body = await responseJson(response);
      if (!response.ok)
        throw new Error(messageFrom(body, `发布失败（${String(response.status)}）`));
      setStatus((current) =>
        current === null ? null : { ...current, processingStage: null, status: "published" },
      );
      setSubmissions((current) =>
        current.map((item) =>
          item.submissionId === submissionId
            ? { ...item, processingStage: null, status: "published" }
            : item,
        ),
      );
      setState({ kind: "success", message: "人工确认完成，讲座与案例已经正式发布。" });
      router.refresh();
    } catch (error) {
      let synchronized = false;
      try {
        const response = await fetch(
          `/api/knowledge/imports?id=${encodeURIComponent(submissionId)}`,
          { cache: "no-store" },
        );
        const body = await responseJson(response);
        if (response.ok) {
          const next = body as unknown as SubmissionStatus;
          setStatus(next);
          setSubmissions((current) =>
            current.map((item) =>
              item.submissionId === submissionId ? summaryFromSubmission(next) : item,
            ),
          );
          synchronized = true;
        }
      } catch {
        // Fall back to the recoverable draft state below when status synchronization is unavailable.
      }
      if (!synchronized) {
        setStatus((current) =>
          current === null ? null : { ...current, processingStage: null, status: "draft_ready" },
        );
        setSubmissions((current) =>
          current.map((item) =>
            item.submissionId === submissionId
              ? { ...item, processingStage: null, status: "draft_ready" }
              : item,
          ),
        );
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "发布失败。" });
    } finally {
      setPending(false);
    }
  }

  async function publicationInputFor(
    item: KnowledgeTranscriptSubmissionSummary,
  ): Promise<DraftPublicationInput> {
    if (item.submissionId === submissionId && status?.status === "draft_ready") {
      return {
        analysisMarkdown: draft,
        lectureDate,
        lectureTitle,
        submissionId: item.submissionId,
      };
    }
    const response = await fetch(
      `/api/knowledge/imports?id=${encodeURIComponent(item.submissionId)}`,
      { cache: "no-store" },
    );
    const body = await responseJson(response);
    if (!response.ok) throw new Error(messageFrom(body, `无法读取 ${item.originalFileName}。`));
    const view = body as unknown as SubmissionStatus;
    if (view.status !== "draft_ready" || view.generatedAnalysisMarkdown === null) {
      throw new Error(`${item.originalFileName} 已不再处于待审核状态，请刷新后重试。`);
    }
    return {
      analysisMarkdown: view.generatedAnalysisMarkdown,
      lectureDate: view.lectureDate ?? "",
      lectureTitle: view.lectureTitle,
      submissionId: view.submissionId,
    };
  }

  async function publishSelectedDrafts(): Promise<void> {
    const selectedItems = submissions.filter(
      (item) => item.status === "draft_ready" && selectedDraftIds.includes(item.submissionId),
    );
    if (selectedItems.length === 0) {
      setState({ kind: "error", message: "请先勾选至少一份待审核提取稿。" });
      return;
    }
    if (!batchReviewConfirmed) {
      setState({ kind: "error", message: "请先确认已经核对本批提取稿的日期、主题和正文。" });
      return;
    }
    if (selectedItems.length > MAX_DRAFT_PUBLICATION_BATCH) {
      setState({
        kind: "error",
        message: `每批最多发布 ${String(MAX_DRAFT_PUBLICATION_BATCH)} 份提取稿。`,
      });
      return;
    }
    setPending(true);
    setState(null);
    const ids = selectedItems.map((item) => item.submissionId);
    try {
      const drafts = await Promise.all(
        selectedItems.map(async (item) => publicationInputFor(item)),
      );
      const invalidIndex = drafts.findIndex(
        (item) =>
          item.analysisMarkdown.trim() === "" ||
          item.lectureDate === "" ||
          item.lectureTitle.trim() === "",
      );
      if (invalidIndex !== -1) {
        throw new Error(
          `${selectedItems[invalidIndex]?.originalFileName ?? "所选提取稿"} 缺少讲座日期、主题或分析内容，请先单独打开补充。`,
        );
      }
      setSubmissions((current) =>
        current.map((item) =>
          ids.includes(item.submissionId)
            ? { ...item, processingStage: "publishing", status: "processing" }
            : item,
        ),
      );
      if (submissionId !== null && ids.includes(submissionId)) {
        setStatus((current) =>
          current === null
            ? null
            : { ...current, processingStage: "publishing", status: "processing" },
        );
      }
      const response = await fetch("/api/knowledge/imports", {
        body: JSON.stringify({ drafts }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const body = await responseJson(response);
      if (!response.ok) {
        throw new Error(messageFrom(body, `批量发布失败（${String(response.status)}）`));
      }
      setSubmissions((current) =>
        current.map((item) =>
          ids.includes(item.submissionId)
            ? { ...item, processingStage: null, status: "published" }
            : item,
        ),
      );
      if (submissionId !== null && ids.includes(submissionId)) {
        setStatus((current) =>
          current === null ? null : { ...current, processingStage: null, status: "published" },
        );
      }
      setSelectedDraftIds([]);
      setBatchReviewConfirmed(false);
      setState({
        kind: "success",
        message: `已一次性校验并发布 ${String(ids.length)} 份讲座提取稿，知识索引只重建了一次。`,
      });
      router.refresh();
    } catch (error) {
      let synchronized = false;
      try {
        const response = await fetch("/api/knowledge/imports", { cache: "no-store" });
        const body: unknown = await response.json().catch(() => null);
        if (response.ok && Array.isArray(body)) {
          setSubmissions(body as readonly KnowledgeTranscriptSubmissionSummary[]);
          synchronized = true;
        }
        if (submissionId !== null && ids.includes(submissionId)) {
          const detailResponse = await fetch(
            `/api/knowledge/imports?id=${encodeURIComponent(submissionId)}`,
            { cache: "no-store" },
          );
          const detailBody = await responseJson(detailResponse);
          if (detailResponse.ok) setStatus(detailBody as unknown as SubmissionStatus);
        }
      } catch {
        // Restore a retryable local view below when server synchronization is unavailable.
      }
      if (!synchronized) {
        setSubmissions((current) =>
          current.map((item) =>
            ids.includes(item.submissionId)
              ? { ...item, processingStage: null, status: "draft_ready" }
              : item,
          ),
        );
        if (submissionId !== null && ids.includes(submissionId)) {
          setStatus((current) =>
            current === null ? null : { ...current, processingStage: null, status: "draft_ready" },
          );
        }
      }
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "批量发布失败。",
      });
    } finally {
      setPending(false);
    }
  }

  const statusText =
    status?.status === "queued"
      ? "等待 Worker 处理……"
      : status?.status === "processing"
        ? status.processingStage === "publishing"
          ? "正在校验审核稿并发布知识索引……"
          : "DeepSeek 正在提取……"
        : status?.status === "draft_ready"
          ? "提取稿已生成，请核对后发布。"
          : status?.status === "failed"
            ? `提取失败：${status.failureMessage ?? "请稍后重试。"}`
            : status?.status === "published"
              ? "已发布。"
              : null;
  const completedBatchCount = batchUploads.filter(
    (item) => item.status === "failed" || item.status === "queued",
  ).length;

  return (
    <section className="editor-panel transcript-import-panel">
      <p className="eyebrow">Transcript to reviewed analysis</p>
      <h2>上传逐字稿并自动提取</h2>
      <p>
        可一次选择最多 {MAX_TRANSCRIPT_BATCH_FILES} 份 UTF-8 Markdown 或 Word <code>.docx</code>
        。每份文件独立保存并进入提取队列；提取完成后可逐份修改，也可以勾选多份一次性校验发布。
      </p>
      <form className="knowledge-import-form" onSubmit={(event) => void onSubmit(event)}>
        <input name="mode" type="hidden" value="transcript" />
        <label>
          逐字稿文件（可多选）
          <input
            accept=".md,.docx,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            multiple
            name="transcript"
            onChange={(event) => {
              setSelectedFileCount(event.target.files?.length ?? 0);
              setBatchUploads([]);
              setState(null);
            }}
            required
            type="file"
          />
          <small>
            {selectedFileCount === 0
              ? `单批最多 ${String(MAX_TRANSCRIPT_BATCH_FILES)} 份，每份最大 20 MB。`
              : `已选择 ${String(selectedFileCount)} 份文件。`}
          </small>
        </label>
        <label className="confirmation-row">
          <input name="outboundConfirmed" required type="checkbox" value="true" />
          <span>
            我已确认该逐字稿可以发送至系统配置的 DeepSeek 服务，且不包含不应出站的身份或敏感信息。
          </span>
        </label>
        <button disabled={pending} type="submit">
          {pending
            ? `正在提交 ${String(completedBatchCount)}/${String(batchUploads.length)}……`
            : "批量保存并生成提取稿"}
        </button>
      </form>
      {batchUploads.length === 0 ? null : (
        <section aria-labelledby="batch-upload-title" className="batch-upload-progress">
          <div className="batch-upload-heading">
            <h3 id="batch-upload-title">本批次提交结果</h3>
            <span>
              {completedBatchCount}/{batchUploads.length}
            </span>
          </div>
          <ul aria-live="polite">
            {batchUploads.map((item, index) => (
              <li key={`${String(index)}-${item.fileName}`}>
                <span className="batch-upload-file">{item.fileName}</span>
                <span className={`batch-upload-status ${item.status}`}>
                  {item.status === "waiting"
                    ? "等待提交"
                    : item.status === "submitting"
                      ? "正在保存"
                      : item.status === "queued"
                        ? "已进入队列"
                        : "提交失败"}
                </span>
                {item.message === null ? null : <small>{item.message}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="transcript-submission-history" aria-labelledby="submission-history-title">
        <div className="submission-history-heading">
          <h3 id="submission-history-title">逐字稿与提取稿记录</h3>
          <span>共 {submissions.length} 条</span>
        </div>
        {submissions.some((item) => item.status === "draft_ready") ? (
          <div className="batch-publication-toolbar">
            <span>
              已选 {selectedDraftIds.length} 份，单批最多 {MAX_DRAFT_PUBLICATION_BATCH} 份
            </span>
            <div>
              <button
                disabled={pending}
                onClick={() => {
                  const draftIds = submissions
                    .filter((item) => item.status === "draft_ready")
                    .slice(0, MAX_DRAFT_PUBLICATION_BATCH)
                    .map((item) => item.submissionId);
                  setSelectedDraftIds(draftIds);
                  setBatchReviewConfirmed(false);
                }}
                type="button"
              >
                全选待审核
              </button>
              <button
                disabled={pending || selectedDraftIds.length === 0}
                onClick={() => {
                  setSelectedDraftIds([]);
                  setBatchReviewConfirmed(false);
                }}
                type="button"
              >
                清除选择
              </button>
              <button
                className="primary-action"
                disabled={pending || selectedDraftIds.length === 0 || !batchReviewConfirmed}
                onClick={() => void publishSelectedDrafts()}
                type="button"
              >
                {pending
                  ? "批量校验发布中……"
                  : `批量校验并发布（${String(selectedDraftIds.length)}）`}
              </button>
            </div>
            <label className="batch-review-confirmation">
              <input
                checked={batchReviewConfirmed}
                disabled={pending || selectedDraftIds.length === 0}
                onChange={(event) => {
                  setBatchReviewConfirmed(event.target.checked);
                }}
                type="checkbox"
              />
              <span>我已核对所选提取稿的讲座日期、主题和分析正文。</span>
            </label>
          </div>
        ) : null}
        {submissions.length === 0 ? (
          <p>当前账号尚未提交逐字稿。</p>
        ) : (
          <ul>
            {submissions.map((item) => (
              <li className="submission-history-item" key={item.submissionId}>
                {item.status === "draft_ready" ? (
                  <label className="submission-selection-control">
                    <input
                      aria-label={`选择 ${item.originalFileName}`}
                      checked={selectedDraftIds.includes(item.submissionId)}
                      disabled={
                        pending ||
                        (!selectedDraftIds.includes(item.submissionId) &&
                          selectedDraftIds.length >= MAX_DRAFT_PUBLICATION_BATCH)
                      }
                      onChange={(event) => {
                        setSelectedDraftIds((current) =>
                          event.target.checked
                            ? [...current, item.submissionId]
                            : current.filter((id) => id !== item.submissionId),
                        );
                        setBatchReviewConfirmed(false);
                      }}
                      type="checkbox"
                    />
                    <span>加入本批</span>
                  </label>
                ) : null}
                <button
                  aria-pressed={item.submissionId === submissionId}
                  className="submission-open-button"
                  disabled={loadingSubmissionId !== null}
                  onClick={() => void loadSubmission(item.submissionId)}
                  type="button"
                >
                  <span className="submission-file-name">{item.originalFileName}</span>
                  <span className={`submission-status ${item.status}`}>
                    {loadingSubmissionId === item.submissionId
                      ? "读取中……"
                      : submissionStatusLabel(item)}
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
          <fieldset className="lecture-metadata-review">
            <legend>讲座日期与主题</legend>
            <p className="muted-copy">
              以下内容由文件名和逐字稿正文共同识别。请在发布前核对；系统无法可靠确定日期时会留空，不会自动补造年份。
            </p>
            <div className="lecture-metadata-fields">
              <label>
                讲座日期
                <input
                  onChange={(event) => {
                    setLectureDate(event.target.value);
                  }}
                  readOnly={status.status === "published"}
                  required
                  type="date"
                  value={lectureDate}
                />
                <small>
                  置信度：{status.lectureDateConfidence}；{status.lectureDateEvidence}
                </small>
              </label>
              <label>
                讲座主题
                <input
                  maxLength={200}
                  onChange={(event) => {
                    setLectureTitle(event.target.value);
                  }}
                  readOnly={status.status === "published"}
                  required
                  type="text"
                  value={lectureTitle}
                />
                <small>
                  置信度：{status.lectureTitleConfidence}；{status.lectureTitleEvidence}
                </small>
              </label>
            </div>
          </fieldset>
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
              disabled={
                pending || draft.trim() === "" || lectureDate === "" || lectureTitle.trim() === ""
              }
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
