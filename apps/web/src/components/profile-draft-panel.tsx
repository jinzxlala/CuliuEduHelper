"use client";

import { useCallback, useEffect, useState, type JSX } from "react";

type EvidenceRelation = "contradicts" | "partially_supports" | "supports";
type InformationNature = "advisor_judgment" | "fact" | "inference" | "missing";
type Confidence = "high" | "low" | "medium" | "unknown";

interface ProfileClaim {
  category: string;
  confidence: Confidence;
  evidence: Array<{ locatorId: string; relation: EvidenceRelation }>;
  evidenceCount: number;
  id: string;
  informationNature: InformationNature;
  statement: string;
}

interface ProfileVersion {
  approvedAt: Date | string | null;
  approvedByUserId: string | null;
  availableEvidence: Array<{ fieldKey: string; locatorId: string }>;
  availableFieldKeys: string[];
  claims: ProfileClaim[];
  createdAt: Date | string;
  id: string;
  invalidationReason: string | null;
  questionsToConfirm: Array<{ question: string; relatedFieldKeys: string[] }>;
  reviews: Array<{
    action: string;
    createdAt: Date | string;
    fromStatus: string | null;
    reason: string | null;
    toStatus: string;
  }>;
  sourceProfileVersionId: string | null;
  status: "approved" | "archived" | "draft" | "in_review" | "needs_review";
  updatedAt: Date | string;
  version: number;
}

interface ProfileReadModel {
  profiles: ProfileVersion[];
  tasks: Array<{ errorCode: string | null; id: string; status: string }>;
}

const categoryLabels: Readonly<Record<string, string>> = {
  academic_foundation: "学术基础",
  behavioral_evidence: "行为证据",
  experience_connections: "经历连接",
  gaps_contradictions_risks: "缺口、矛盾与风险",
  interdisciplinary_ai_depth: "跨学科与 AI 深度",
  interest_thread: "兴趣主线",
  one_sentence_label: "一句话标签",
  responsibility_impact: "职责与成果强度",
};

const statusLabels: Readonly<Record<ProfileVersion["status"], string>> = {
  approved: "已批准",
  archived: "已归档",
  draft: "草稿",
  in_review: "审核中",
  needs_review: "需要复查",
};

function changedCategories(
  current: ProfileVersion,
  previous: ProfileVersion | undefined,
): string[] {
  if (previous === undefined) return [];
  const previousByCategory = new Map(previous.claims.map((claim) => [claim.category, claim]));
  return current.claims
    .filter((claim) => {
      const old = previousByCategory.get(claim.category);
      return (
        old === undefined ||
        old.statement !== claim.statement ||
        old.informationNature !== claim.informationNature ||
        old.confidence !== claim.confidence ||
        JSON.stringify(old.evidence) !== JSON.stringify(claim.evidence)
      );
    })
    .map((claim) => categoryLabels[claim.category] ?? claim.category);
}

function ProfileEditor({
  onRefresh,
  profile,
  studentId,
}: Readonly<{
  onRefresh: (message: string) => Promise<void>;
  profile: ProfileVersion;
  studentId: string;
}>): JSX.Element {
  const [claims, setClaims] = useState(() => structuredClone(profile.claims));
  const [questions, setQuestions] = useState(() => structuredClone(profile.questionsToConfirm));
  const [archiveReason, setArchiveReason] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function updateClaim(index: number, patch: Partial<ProfileClaim>): void {
    setClaims((current) =>
      current.map((claim, candidateIndex) =>
        candidateIndex === index ? { ...claim, ...patch } : claim,
      ),
    );
  }

  function toggleEvidence(claimIndex: number, locatorId: string, checked: boolean): void {
    const claim = claims[claimIndex];
    if (claim === undefined) return;
    const evidence = checked
      ? [...claim.evidence, { locatorId, relation: "supports" as const }]
      : claim.evidence.filter((item) => item.locatorId !== locatorId);
    updateClaim(claimIndex, { evidence, evidenceCount: evidence.length });
  }

  async function sendRevision(): Promise<void> {
    setSubmitting(true);
    try {
      const response = await fetch(`/api/students/${studentId}/profiles/${profile.id}/revisions`, {
        body: JSON.stringify({
          claims: claims.map(
            ({ category, confidence, evidence, informationNature, statement }) => ({
              category,
              confidence,
              evidence,
              informationNature,
              statement,
            }),
          ),
          expectedSourceUpdatedAt: new Date(profile.updatedAt).toISOString(),
          questionsToConfirm: questions,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        await onRefresh(
          response.status === 409
            ? "画像已变化或证据已失效，请刷新后重试。"
            : "修改未保存，请检查字段与证据。 ",
        );
        return;
      }
      await onRefresh("修改已保存为新的不可变草稿版本。");
    } finally {
      setSubmitting(false);
    }
  }

  async function transition(action: "approve" | "archive" | "return" | "submit"): Promise<void> {
    setSubmitting(true);
    try {
      const reason = action === "return" ? returnReason : archiveReason;
      const body =
        action === "return" || action === "archive"
          ? { action, expectedUpdatedAt: new Date(profile.updatedAt).toISOString(), reason }
          : { action, expectedUpdatedAt: new Date(profile.updatedAt).toISOString() };
      const response = await fetch(
        `/api/students/${studentId}/profiles/${profile.id}/transitions`,
        {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) {
        await onRefresh(
          response.status === 409 ? "状态已变化或证据已失效，请刷新后重试。" : "状态操作未完成。",
        );
        return;
      }
      if (action === "return") setReturnReason("");
      if (action === "archive") setArchiveReason("");
      await onRefresh(
        action === "approve"
          ? "画像已由当前顾问批准。"
          : action === "submit"
            ? "画像已提交审核。"
            : action === "return"
              ? "画像已退回草稿。"
              : "画像已归档。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canRevise = ["approved", "draft", "needs_review"].includes(profile.status);
  return (
    <div className="profile-editor">
      {canRevise ? (
        <>
          <h3>完整修改</h3>
          <p>保存修改会创建新版本；原版本及其审核记录不会被覆盖。</p>
          {claims.map((claim, index) => (
            <fieldset key={claim.category}>
              <legend>{categoryLabels[claim.category] ?? claim.category}</legend>
              <textarea
                aria-label={`${claim.category}结论`}
                maxLength={1200}
                onChange={(event) => {
                  updateClaim(index, { statement: event.target.value });
                }}
                value={claim.statement}
              />
              <div className="form-grid-two">
                <label>
                  信息性质
                  <select
                    disabled={claim.category === "one_sentence_label"}
                    onChange={(event) => {
                      const informationNature = event.target.value as InformationNature;
                      updateClaim(index, {
                        confidence:
                          informationNature === "missing"
                            ? "unknown"
                            : claim.confidence === "unknown"
                              ? "medium"
                              : claim.confidence,
                        evidence: informationNature === "missing" ? [] : claim.evidence,
                        evidenceCount: informationNature === "missing" ? 0 : claim.evidence.length,
                        informationNature,
                      });
                    }}
                    value={claim.informationNature}
                  >
                    <option value="fact">事实</option>
                    <option value="inference">推断</option>
                    <option value="advisor_judgment">顾问判断</option>
                    <option value="missing">缺失</option>
                  </select>
                </label>
                <label>
                  置信度
                  <select
                    disabled={claim.informationNature === "missing"}
                    onChange={(event) => {
                      updateClaim(index, { confidence: event.target.value as Confidence });
                    }}
                    value={claim.confidence}
                  >
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                    <option value="unknown">未知</option>
                  </select>
                </label>
              </div>
              {claim.informationNature === "missing" ? null : (
                <div className="profile-evidence-options">
                  <strong>证据定位</strong>
                  {profile.availableEvidence.map((evidence) => {
                    const selected = claim.evidence.find(
                      (item) => item.locatorId === evidence.locatorId,
                    );
                    return (
                      <div key={evidence.locatorId}>
                        <label>
                          <input
                            checked={selected !== undefined}
                            onChange={(event) => {
                              toggleEvidence(index, evidence.locatorId, event.target.checked);
                            }}
                            type="checkbox"
                          />
                          {evidence.fieldKey} · {evidence.locatorId.slice(0, 8)}…
                        </label>
                        {selected === undefined ? null : (
                          <select
                            aria-label={`${evidence.fieldKey}证据关系`}
                            onChange={(event) => {
                              updateClaim(index, {
                                evidence: claim.evidence.map((item) =>
                                  item.locatorId === evidence.locatorId
                                    ? { ...item, relation: event.target.value as EvidenceRelation }
                                    : item,
                                ),
                              });
                            }}
                            value={selected.relation}
                          >
                            <option value="supports">支持</option>
                            <option value="partially_supports">部分支持</option>
                            <option value="contradicts">反驳</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </fieldset>
          ))}
          <fieldset>
            <legend>待确认问题</legend>
            {questions.map((question, questionIndex) => (
              <div className="profile-question" key={String(questionIndex)}>
                <input
                  aria-label={`待确认问题${String(questionIndex + 1)}`}
                  maxLength={500}
                  onChange={(event) => {
                    setQuestions((current) =>
                      current.map((item, index) =>
                        index === questionIndex ? { ...item, question: event.target.value } : item,
                      ),
                    );
                  }}
                  value={question.question}
                />
                <div className="profile-field-options">
                  {profile.availableFieldKeys.map((fieldKey) => (
                    <label key={fieldKey}>
                      <input
                        checked={question.relatedFieldKeys.includes(fieldKey)}
                        onChange={(event) => {
                          setQuestions((current) =>
                            current.map((item, index) =>
                              index === questionIndex
                                ? {
                                    ...item,
                                    relatedFieldKeys: event.target.checked
                                      ? [...item.relatedFieldKeys, fieldKey]
                                      : item.relatedFieldKeys.filter((key) => key !== fieldKey),
                                  }
                                : item,
                            ),
                          );
                        }}
                        type="checkbox"
                      />
                      {fieldKey}
                    </label>
                  ))}
                </div>
                <button
                  className="link-button danger-link"
                  onClick={() => {
                    setQuestions((current) =>
                      current.filter((_item, index) => index !== questionIndex),
                    );
                  }}
                  type="button"
                >
                  删除问题
                </button>
              </div>
            ))}
            <button
              className="secondary-button"
              disabled={questions.length >= 20}
              onClick={() => {
                setQuestions((current) => [...current, { question: "", relatedFieldKeys: [] }]);
              }}
              type="button"
            >
              添加问题
            </button>
          </fieldset>
          <button disabled={submitting} onClick={() => void sendRevision()} type="button">
            保存为新版本
          </button>
        </>
      ) : null}

      <h3>审核操作</h3>
      {profile.status === "draft" ? (
        <button disabled={submitting} onClick={() => void transition("submit")} type="button">
          提交审核
        </button>
      ) : null}
      {profile.status === "in_review" ? (
        <>
          <label>
            退回原因
            <input
              onChange={(event) => {
                setReturnReason(event.target.value);
              }}
              value={returnReason}
            />
          </label>
          <div className="record-actions">
            <button
              disabled={submitting || returnReason.trim() === ""}
              onClick={() => void transition("return")}
              type="button"
            >
              退回草稿
            </button>
            <button disabled={submitting} onClick={() => void transition("approve")} type="button">
              批准画像
            </button>
          </div>
        </>
      ) : null}
      {profile.status === "archived" ? null : (
        <>
          <label>
            归档原因
            <input
              onChange={(event) => {
                setArchiveReason(event.target.value);
              }}
              value={archiveReason}
            />
          </label>
          <button
            className="link-button danger-link"
            disabled={submitting || archiveReason.trim() === ""}
            onClick={() => void transition("archive")}
            type="button"
          >
            归档此版本
          </button>
        </>
      )}
    </div>
  );
}

export function ProfileDraftPanel({
  initialData,
  studentId,
}: Readonly<{ initialData: ProfileReadModel; studentId: string }>): JSX.Element {
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = data.tasks.some((task) => task.status === "queued" || task.status === "running");

  const refresh = useCallback(
    async (nextMessage = ""): Promise<void> => {
      const response = await fetch(`/api/students/${studentId}/profile-drafts`, {
        cache: "no-store",
      });
      if (response.ok) setData((await response.json()) as ProfileReadModel);
      setMessage(nextMessage);
    },
    [studentId],
  );

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      window.clearInterval(timer);
    };
  }, [pending, refresh]);

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
      await refresh("画像草稿已进入后台队列。页面会自动更新状态。");
    } finally {
      setSubmitting(false);
    }
  }

  const latest = data.profiles[0];
  return (
    <section className="detail-section record-section">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Profile workflow</p>
          <h2>学生画像与人工审核</h2>
        </div>
        <button disabled={submitting || pending} onClick={() => void generateDraft()} type="button">
          {pending ? "生成中…" : "生成新草稿"}
        </button>
      </div>
      <p>画像只能由已授权顾问修改和批准；保存修改会创建新版本，不覆盖历史记录。</p>
      {message === "" ? null : <p aria-live="polite">{message}</p>}
      {data.tasks[0]?.status === "failed" ? (
        <p className="record-warning">最近一次生成失败，可在核对事实与证据后重试。</p>
      ) : null}
      {latest === undefined ? (
        <p>尚无画像草稿。</p>
      ) : (
        <>
          <article className="record-item profile-current">
            <div className="record-item-heading">
              <h3>当前版本 v{latest.version}</h3>
              <span className="privacy-badge">{statusLabels[latest.status]}</span>
            </div>
            {latest.invalidationReason === null ? null : (
              <p className="record-warning">复查/归档原因：{latest.invalidationReason}</p>
            )}
            <div className="record-list">
              {latest.claims.map((claim) => (
                <div key={claim.category}>
                  <strong>{categoryLabels[claim.category] ?? claim.category}</strong>
                  <p>{claim.statement}</p>
                  <small>
                    {claim.informationNature} · {claim.confidence} · 证据 {claim.evidenceCount} 条
                  </small>
                </div>
              ))}
            </div>
            <h3>待确认问题</h3>
            {latest.questionsToConfirm.length === 0 ? (
              <p>无待确认问题。</p>
            ) : (
              <ul>
                {latest.questionsToConfirm.map((question, index) => (
                  <li key={String(index)}>{question.question}</li>
                ))}
              </ul>
            )}
            <ProfileEditor
              key={`${latest.id}:${new Date(latest.updatedAt).toISOString()}`}
              onRefresh={refresh}
              profile={latest}
              studentId={studentId}
            />
          </article>

          <details className="history-panel">
            <summary>版本历史与比较（{data.profiles.length}）</summary>
            <div className="record-list">
              {data.profiles.map((profile, index) => {
                const changed = changedCategories(profile, data.profiles[index + 1]);
                return (
                  <article className="record-item" key={profile.id}>
                    <div className="record-item-heading">
                      <h3>v{profile.version}</h3>
                      <span className="privacy-badge">{statusLabels[profile.status]}</span>
                    </div>
                    <p>
                      相对上一版本：
                      {changed.length === 0 ? "首个版本或无字段变化" : changed.join("、")}
                    </p>
                    <small>更新时间：{new Date(profile.updatedAt).toLocaleString("zh-CN")}</small>
                    {profile.reviews.map((review, reviewIndex) => (
                      <p key={`${review.action}-${String(reviewIndex)}`}>
                        {review.action} · {review.fromStatus ?? "新建"} → {review.toStatus}
                        {review.reason === null ? "" : ` · ${review.reason}`}
                      </p>
                    ))}
                  </article>
                );
              })}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
