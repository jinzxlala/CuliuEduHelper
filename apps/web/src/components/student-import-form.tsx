"use client";

import { useEffect, useState, type JSX, type SyntheticEvent } from "react";

interface Suggestion {
  confidence: "high" | "low" | "medium" | "unknown";
  decision: "accepted" | "pending" | "rejected";
  fieldKey: string;
  id: string;
  proposedValue: Record<string, unknown>;
}

interface Candidate {
  decision: "create" | "link" | "pending" | "rejected";
  displayLabel: string;
  id: string;
  possibleStudentId: string | null;
  suggestions: Suggestion[];
}

interface Batch {
  candidates: Candidate[];
  id: string;
  originalFileName: string;
  status: "applied" | "failed" | "partially_applied" | "processing" | "review_ready" | "uploaded";
}

const fieldLabels: Record<string, string> = {
  "contact.parent_phone": "家长电话",
  "education.grade": "年级",
  "education.school": "就读学校",
  "identity.birth_date": "出生日期",
  "identity.chinese_name": "中文姓名",
  "identity.english_name": "英文名",
};

export function StudentImportForm(): JSX.Element {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (batch === null || !["uploaded", "processing"].includes(batch.status)) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/student-imports?id=${encodeURIComponent(batch.id)}`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("无法读取导入任务状态。");
          return (await response.json()) as Batch;
        })
        .then((nextBatch) => {
          setBatch(nextBatch);
        })
        .catch((pollError: unknown) => {
          setError(pollError instanceof Error ? pollError.message : "状态读取失败。");
        });
    }, 1500);
    return () => {
      window.clearInterval(timer);
    };
  }, [batch]);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/student-imports", { body: form, method: "POST" });
      const payload = (await response.json()) as { batchId?: string; message?: string };
      if (!response.ok || payload.batchId === undefined) {
        throw new Error(payload.message ?? "批量建档提交失败。");
      }
      setBatch({ candidates: [], id: payload.batchId, originalFileName: "", status: "uploaded" });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "批量建档提交失败。");
    } finally {
      setBusy(false);
    }
  }

  function suggestionText(suggestion: Suggestion): string {
    return typeof suggestion.proposedValue.text === "string" ? suggestion.proposedValue.text : "";
  }

  async function decideCandidate(
    candidate: Candidate,
    decision: "create" | "rejected",
  ): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const fields = candidate.suggestions.map((suggestion) => {
        const input = document.querySelector<HTMLInputElement>(
          `[data-suggestion-value="${suggestion.id}"]`,
        );
        const accepted = document.querySelector<HTMLInputElement>(
          `[data-suggestion-accepted="${suggestion.id}"]`,
        );
        return {
          decision: decision === "create" && accepted?.checked === true ? "accepted" : "rejected",
          ...(input?.value.trim() ? { editedValue: input.value.trim() } : {}),
          suggestionId: suggestion.id,
        };
      });
      const response = await fetch("/api/student-imports", {
        body: JSON.stringify({ candidateId: candidate.id, decision, fields }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "候选学生处理失败。");
      if (batch !== null) {
        const refreshed = await fetch(`/api/student-imports?id=${encodeURIComponent(batch.id)}`, {
          cache: "no-store",
        });
        setBatch((await refreshed.json()) as Batch);
      }
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "候选学生处理失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="import-workspace">
      <form className="import-panel" onSubmit={(event) => void submit(event)}>
        <label htmlFor="student-import-file">学生基础信息文件</label>
        <input
          accept=".txt,.md,.docx,.csv"
          id="student-import-file"
          name="file"
          required
          type="file"
        />
        <p className="field-note">
          支持 UTF-8 TXT、Markdown、Word DOCX 和 CSV，单文件不超过 20 MB。
        </p>
        <button disabled={busy} type="submit">
          {busy ? "处理中…" : "上传并识别"}
        </button>
      </form>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {batch !== null && ["uploaded", "processing"].includes(batch.status) ? (
        <section className="import-panel">
          <h2>正在提取</h2>
          <p>原文件已经安全保存，Worker 正在生成逐字段审核建议。</p>
        </section>
      ) : null}
      {batch?.status === "failed" ? (
        <section className="import-panel">
          <h2>提取失败</h2>
          <p>原文件仍然保留，请检查 Worker 日志后重新提交。</p>
        </section>
      ) : null}
      {batch?.candidates.map((candidate) => (
        <section className="import-panel" key={candidate.id}>
          <div className="candidate-heading">
            <h2>{candidate.displayLabel}</h2>
            <span>{candidate.decision === "pending" ? "待审核" : "已处理"}</span>
          </div>
          {candidate.possibleStudentId !== null ? (
            <p className="warning-note">
              检测到一个可能的既有学生；当前版本不会自动合并，请先拒绝并人工核对。
            </p>
          ) : null}
          <div className="suggestion-list">
            {candidate.suggestions.map((suggestion) => (
              <label className="suggestion-row" key={suggestion.id}>
                <input data-suggestion-accepted={suggestion.id} defaultChecked type="checkbox" />
                <span>{fieldLabels[suggestion.fieldKey] ?? suggestion.fieldKey}</span>
                <input
                  data-suggestion-value={suggestion.id}
                  defaultValue={suggestionText(suggestion)}
                />
                <small>{suggestion.confidence}</small>
              </label>
            ))}
          </div>
          {candidate.decision === "pending" ? (
            <div className="candidate-actions">
              <button
                disabled={busy || candidate.possibleStudentId !== null}
                onClick={() => void decideCandidate(candidate, "create")}
                type="button"
              >
                确认并创建学生
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void decideCandidate(candidate, "rejected")}
                type="button"
              >
                拒绝该候选
              </button>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
