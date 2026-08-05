"use client";

import { useEffect, useState, type JSX, type SyntheticEvent } from "react";
import { useRouter } from "next/navigation";

interface Suggestion {
  confidence: string;
  createdAt: string;
  decision: "accepted" | "pending" | "rejected";
  fieldKey: string;
  id: string;
  informationNature: string;
  proposedValue: Record<string, unknown>;
  sourceRef: string;
}

interface BatchState {
  batchId: string;
  status: string;
  suggestions: Suggestion[];
}

export function IncrementalStudentImport({ studentId }: { studentId: string }): JSX.Element {
  const router = useRouter();
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const pendingSuggestions = batch?.suggestions.filter((item) => item.decision === "pending") ?? [];

  useEffect(() => {
    if (batch === null || !["uploaded", "processing"].includes(batch.status)) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/students/${studentId}/imports?id=${batch.batchId}`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("无法读取增量提取状态。");
          return (await response.json()) as BatchState;
        })
        .then((next) => {
          setBatch(next);
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : "状态读取失败。");
        });
    }, 1500);
    return () => {
      window.clearInterval(timer);
    };
  }, [batch, studentId]);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/students/${studentId}/imports`, {
        body: new FormData(event.currentTarget),
        method: "POST",
      });
      const payload = (await response.json()) as { batchId?: string; message?: string };
      if (!response.ok || payload.batchId === undefined) {
        throw new Error(payload.message ?? "增量材料提交失败。");
      }
      setBatch({ batchId: payload.batchId, status: "uploaded", suggestions: [] });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "增量材料提交失败。");
    } finally {
      setPending(false);
    }
  }

  async function sendDecision(
    suggestion: Suggestion,
    decision: "accepted" | "rejected",
  ): Promise<void> {
    const field = document.querySelector<HTMLInputElement>(`[data-field-key="${suggestion.id}"]`);
    const value = document.querySelector<HTMLInputElement>(`[data-field-value="${suggestion.id}"]`);
    const response = await fetch(`/api/students/${studentId}/imports`, {
      body: JSON.stringify({
        decision,
        ...(field?.value.trim() ? { editedFieldKey: field.value.trim() } : {}),
        ...(value?.value.trim() ? { editedValue: { text: value.value.trim() } } : {}),
        expectedCreatedAt: suggestion.createdAt,
        suggestionId: suggestion.id,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const payload = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(payload.message ?? "建议处理失败。");
  }

  function markDecided(ids: readonly string[], decision: "accepted" | "rejected"): void {
    const decided = new Set(ids);
    setBatch((current) =>
      current === null
        ? null
        : {
            ...current,
            suggestions: current.suggestions.map((item) =>
              decided.has(item.id) ? { ...item, decision } : item,
            ),
          },
    );
  }

  async function decide(suggestion: Suggestion, decision: "accepted" | "rejected"): Promise<void> {
    setPending(true);
    setMessage("");
    try {
      await sendDecision(suggestion, decision);
      markDecided([suggestion.id], decision);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "建议处理失败。");
    } finally {
      setPending(false);
    }
  }

  async function decideAll(decision: "accepted" | "rejected"): Promise<void> {
    setPending(true);
    setMessage("");
    const completed: string[] = [];
    try {
      for (const suggestion of pendingSuggestions) {
        await sendDecision(suggestion, decision);
        completed.push(suggestion.id);
      }
      markDecided(completed, decision);
      router.refresh();
    } catch (error) {
      markDecided(completed, decision);
      const detail = error instanceof Error ? error.message : "建议处理失败。";
      setMessage(`已处理 ${String(completed.length)} 条；后续已停止。${detail}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="detail-section record-section">
      <p className="eyebrow">Evidence-assisted update</p>
      <h2>从教学反馈或会议逐字稿增量更新</h2>
      <form className="import-panel" onSubmit={(event) => void submit(event)}>
        <input accept=".csv,.docx" name="file" required type="file" />
        <label>
          <input name="ownershipConfirmed" type="checkbox" value="true" />
          我确认 DOCX 只属于当前学生；CSV 将由系统仅截取当前学生列。
        </label>
        <button disabled={pending} type="submit">
          上传并生成事实建议
        </button>
      </form>
      {message ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      {batch !== null && ["uploaded", "processing"].includes(batch.status) ? (
        <p>Worker 正在提取，页面会自动刷新。</p>
      ) : null}
      {pendingSuggestions.length > 0 ? (
        <div className="record-actions" aria-label="整组建议操作">
          <button disabled={pending} onClick={() => void decideAll("accepted")} type="button">
            接受全部待审建议
          </button>
          <button disabled={pending} onClick={() => void decideAll("rejected")} type="button">
            拒绝全部待审建议
          </button>
        </div>
      ) : null}
      {batch?.suggestions.map((suggestion) => (
        <article className="record-item" key={suggestion.id}>
          <div className="record-item-heading">
            <input data-field-key={suggestion.id} defaultValue={suggestion.fieldKey} />
            <span>
              {suggestion.informationNature} · {suggestion.confidence}
            </span>
          </div>
          <input
            data-field-value={suggestion.id}
            defaultValue={
              typeof suggestion.proposedValue.text === "string" ? suggestion.proposedValue.text : ""
            }
          />
          <small>证据定位：{suggestion.sourceRef}</small>
          {suggestion.decision === "pending" ? (
            <div className="record-actions">
              <button
                disabled={pending}
                onClick={() => void decide(suggestion, "accepted")}
                type="button"
              >
                接受
              </button>
              <button
                disabled={pending}
                onClick={() => void decide(suggestion, "rejected")}
                type="button"
              >
                拒绝
              </button>
            </div>
          ) : (
            <p>{suggestion.decision === "accepted" ? "已接受" : "已拒绝"}</p>
          )}
        </article>
      ))}
    </section>
  );
}
