"use client";

import { useEffect, useState, type JSX } from "react";

interface ProfileReadModel {
  profiles: Array<{
    claims: Array<{
      category: string;
      confidence: string;
      evidenceCount: number;
      informationNature: string;
      statement: string;
    }>;
    id: string;
    questionsToConfirm: Array<{ question: string }>;
    status: string;
    version: number;
  }>;
  tasks: Array<{ errorCode: string | null; id: string; status: string }>;
}

export function ProfileDraftPanel({
  initialData,
  studentId,
}: Readonly<{ initialData: ProfileReadModel; studentId: string }>): JSX.Element {
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = data.tasks.some((task) => task.status === "queued" || task.status === "running");

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/students/${studentId}/profile-drafts`, { cache: "no-store" })
        .then(async (response) => {
          if (response.ok) setData((await response.json()) as ProfileReadModel);
        })
        .catch(() => undefined);
    }, 1_500);
    return () => {
      window.clearInterval(timer);
    };
  }, [pending, studentId]);

  async function generateDraft(): Promise<void> {
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`/api/students/${studentId}/profile-drafts`, { method: "POST" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(
          body.error === "insufficient_confirmed_evidence"
            ? "需要至少一条已确认、且带有当前有效证据的学生事实。"
            : "画像草稿任务暂时无法创建。",
        );
        return;
      }
      const refreshed = await fetch(`/api/students/${studentId}/profile-drafts`, {
        cache: "no-store",
      });
      if (refreshed.ok) setData((await refreshed.json()) as ProfileReadModel);
      setMessage("画像草稿已进入后台队列。页面会自动更新状态。");
    } finally {
      setSubmitting(false);
    }
  }

  const latest = data.profiles[0];
  return (
    <section className="detail-section record-section">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Profile draft</p>
          <h2>学生画像草稿</h2>
        </div>
        <button disabled={submitting || pending} onClick={() => void generateDraft()} type="button">
          {pending ? "生成中…" : "生成新草稿"}
        </button>
      </div>
      <p>仅使用已确认且有有效证据的脱敏事实。结果始终是草稿，不会自动批准。</p>
      {message === "" ? null : <p aria-live="polite">{message}</p>}
      {data.tasks[0]?.status === "failed" ? (
        <p className="record-warning">最近一次生成失败，可在核对事实与证据后重试。</p>
      ) : null}
      {latest === undefined ? (
        <p>尚无画像草稿。</p>
      ) : (
        <article className="record-item">
          <div className="record-item-heading">
            <h3>草稿 v{latest.version}</h3>
            <span className="privacy-badge">{latest.status}</span>
          </div>
          <div className="record-list">
            {latest.claims.map((claim, index) => (
              <div key={`${claim.category}-${String(index)}`}>
                <strong>{claim.category}</strong>
                <p>{claim.statement}</p>
                <small>
                  {claim.informationNature} · {claim.confidence} · 证据 {claim.evidenceCount} 条
                </small>
              </div>
            ))}
          </div>
          <h3>待确认问题</h3>
          <ul>
            {latest.questionsToConfirm.map((question, index) => (
              <li key={String(index)}>{question.question}</li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
