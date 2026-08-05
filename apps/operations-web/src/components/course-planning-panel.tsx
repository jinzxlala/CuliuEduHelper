"use client";

import { useState, type JSX } from "react";

import {
  buildCreateManualPlanInput,
  createManualPlanFormState,
  toIsoString,
  type ManualPlanFormState,
  type PlanWorkspaceItem,
  type PlanningWorkspaceData,
} from "../lib/course-planning-form";

const statusLabels = {
  approved: "已批准",
  archived: "已归档",
  draft: "草稿",
  in_review: "审核中",
  needs_review: "需要复查",
} as const;

const categoryLabels: Record<string, string> = {
  ability_boundary: "能力边界",
  course_performance: "课程表现",
  current_technical_stack: "当前技术栈",
  interest_direction: "兴趣方向",
  learning_characteristics: "学习特征",
  next_stage_priority: "下一阶段重点",
  one_sentence_label: "一句话标签",
  risk_alerts: "风险提醒",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formattedDate(value: Date | string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : fallback;
  } catch {
    return fallback;
  }
}

function toggleValue(values: string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function CourseChecks({
  selected,
  setSelected,
  workspace,
}: Readonly<{
  selected: string[];
  setSelected: (values: string[]) => void;
  workspace: PlanningWorkspaceData;
}>): JSX.Element {
  return (
    <div className="planning-check-grid">
      {workspace.catalog.courses.map((course) => (
        <label key={course.courseVersionId}>
          <input
            checked={selected.includes(course.courseVersionId)}
            onChange={(event) => {
              setSelected(toggleValue(selected, course.courseVersionId, event.target.checked));
            }}
            type="checkbox"
          />
          <span>
            <strong>{course.code}</strong> · {course.content.title}
            <small>
              {course.content.stage} · 每周 {course.content.weeklyLoadMinutes} 分钟
            </small>
          </span>
        </label>
      ))}
    </div>
  );
}

function PlanHistory({
  plan,
  workspace,
}: Readonly<{ plan: PlanWorkspaceItem; workspace: PlanningWorkspaceData }>): JSX.Element {
  return (
    <article className="record-item planning-history-card">
      <div className="record-item-heading">
        <h3>
          v{plan.version} · {plan.content.title}
        </h3>
        <span className={`plan-status ${plan.status}`}>{statusLabels[plan.status]}</span>
      </div>
      <p>{plan.content.goal}</p>
      <small>
        画像 v
        {workspace.approvedProfile?.id === plan.profileVersionId
          ? workspace.approvedProfile.version
          : "历史"}
        {" · "}复查日期 {plan.reviewDueDate} · 更新于 {formattedDate(plan.updatedAt)}
      </small>
      {plan.invalidationReason === null ? null : (
        <p className="record-warning">失效/归档原因：{plan.invalidationReason}</p>
      )}
      <details className="history-panel">
        <summary>
          审核记录（{plan.reviews.length}）与规则覆盖（{plan.overrides.length}）
        </summary>
        <ol className="planning-audit-list">
          {plan.reviews.map((review) => (
            <li key={review.id}>
              {formattedDate(review.createdAt)} · {review.action} ·{" "}
              {review.actorDisplayName ?? "系统"}
              {review.reason === null ? "" : ` · ${review.reason}`}
            </li>
          ))}
          {plan.overrides.map((override) => (
            <li key={override.id}>
              规则覆盖 {override.scopeKey} · {override.status} · 申请理由：{override.reason}
              {override.decidedByDisplayName === null
                ? ""
                : ` · 审批人：${override.decidedByDisplayName}`}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

export function CoursePlanningPanel({
  initialData,
  recommendedCourseVersionIds = [],
  studentId,
}: Readonly<{
  initialData: PlanningWorkspaceData;
  recommendedCourseVersionIds?: string[];
  studentId: string;
}>): JSX.Element {
  const [workspace, setWorkspace] = useState(initialData);
  const [form, setForm] = useState<ManualPlanFormState>(() => {
    const initial = createManualPlanFormState(initialData);
    if (recommendedCourseVersionIds.length === 0) return initial;
    const template = initial.shortTermItems[0];
    if (template === undefined) return initial;
    return {
      ...initial,
      shortTermItems: recommendedCourseVersionIds.slice(0, 3).map((courseVersionId) => ({
        ...template,
        courseVersionId,
        reason: "来自已接受的画像驱动课程推荐，待顾问补充和复核。",
      })),
    };
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transitionReason, setTransitionReason] = useState("");
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const latest = workspace.plans[0];

  function update<K extends keyof ManualPlanFormState>(
    key: K,
    value: ManualPlanFormState[K],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeRoute(
    routeIndex: number,
    change: (route: ManualPlanFormState["routes"][number]) => void,
  ): void {
    const routes = structuredClone(form.routes);
    const route = routes[routeIndex];
    if (route === undefined) return;
    change(route);
    update("routes", routes);
  }

  function changePhase(
    routeIndex: number,
    phaseIndex: number,
    change: (phase: ManualPlanFormState["routes"][number]["phases"][number]) => void,
  ): void {
    changeRoute(routeIndex, (route) => {
      const phase = route.phases[phaseIndex];
      if (phase !== undefined) change(phase);
    });
  }

  function changeComparison(
    index: number,
    change: (comparison: ManualPlanFormState["routeComparison"][number]) => void,
  ): void {
    const comparisons = structuredClone(form.routeComparison);
    const comparison = comparisons[index];
    if (comparison === undefined) return;
    change(comparison);
    update("routeComparison", comparisons);
  }

  async function refresh(successMessage?: string): Promise<void> {
    const response = await fetch(`/api/students/${studentId}/plans`, { cache: "no-store" });
    if (!response.ok) {
      setError(await responseMessage(response, "规划工作台刷新失败。"));
      return;
    }
    const data = (await response.json()) as PlanningWorkspaceData;
    setWorkspace(data);
    setForm(createManualPlanFormState(data));
    setMessage(successMessage ?? "");
    setError("");
  }

  async function savePlan(): Promise<void> {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const input = buildCreateManualPlanInput(form, workspace);
      const response = await fetch(`/api/students/${studentId}/plans`, {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(await responseMessage(response, "规划未保存，请检查必填字段、日期与课程规则。"));
        return;
      }
      await refresh(latest === undefined ? "规划草稿已创建。" : "已基于最新版本创建修订草稿。 ");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "规划字段不完整。请确保所有建议引用画像结论，并完成六维路线对比。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function transition(action: "approve" | "archive" | "return" | "submit"): Promise<void> {
    if (latest === undefined) return;
    setBusy(true);
    setError("");
    const input =
      action === "return" || action === "archive"
        ? { action, expectedUpdatedAt: toIsoString(latest.updatedAt), reason: transitionReason }
        : { action, expectedUpdatedAt: toIsoString(latest.updatedAt) };
    try {
      const response = await fetch(`/api/students/${studentId}/plans/${latest.id}/transitions`, {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(await responseMessage(response, "状态操作未完成。"));
        return;
      }
      setTransitionReason("");
      await refresh(
        `规划已${action === "submit" ? "提交审核" : action === "approve" ? "批准" : action === "return" ? "退回草稿" : "归档"}。`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function requestOverride(scopeKey: string, violationKey: string): Promise<void> {
    if (latest === undefined) return;
    const key = `${scopeKey}:${violationKey}`;
    setBusy(true);
    try {
      const response = await fetch(`/api/students/${studentId}/plans/${latest.id}/overrides`, {
        body: JSON.stringify({
          expectedPlanUpdatedAt: toIsoString(latest.updatedAt),
          reason: overrideReasons[key] ?? "",
          scopeKey,
          violationKey,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(await responseMessage(response, "规则覆盖申请未创建。"));
        return;
      }
      await refresh("规则覆盖申请已记录，需由有审批权限的人员明确批准。 ");
    } finally {
      setBusy(false);
    }
  }

  async function decideOverride(overrideId: string, action: "approve" | "reject"): Promise<void> {
    if (latest === undefined) return;
    const override = latest.overrides.find((item) => item.id === overrideId);
    if (override === undefined) return;
    setBusy(true);
    try {
      const reason = overrideReasons[overrideId] ?? "";
      const input =
        action === "approve"
          ? { action, expectedUpdatedAt: toIsoString(override.updatedAt) }
          : { action, expectedUpdatedAt: toIsoString(override.updatedAt), reason };
      const response = await fetch(
        `/api/students/${studentId}/plans/${latest.id}/overrides/${overrideId}/decisions`,
        {
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) {
        setError(await responseMessage(response, "规则覆盖审批未完成。"));
        return;
      }
      await refresh(action === "approve" ? "规则覆盖已批准。" : "规则覆盖已拒绝。 ");
    } finally {
      setBusy(false);
    }
  }

  const blockingReason =
    workspace.approvedProfile === null
      ? "尚无已批准学生画像，不能创建规划。"
      : workspace.catalog.courses.length === 0
        ? "课程目录中尚无已批准课程，不能创建规划。"
        : null;

  return (
    <>
      <section className="detail-section planning-overview">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Manual course planning</p>
            <h2>人工课程规划工作台</h2>
          </div>
          <span>{workspace.plans.length} 个版本</span>
        </div>
        <p>
          规划只引用已批准画像和已批准课程目录。系统负责确定性规则检查；建议正文由顾问填写，不调用模型自动生成。
        </p>
        {message ? <p className="form-message success">{message}</p> : null}
        {error ? <p className="form-message error">{error}</p> : null}
        {blockingReason === null ? null : <p className="record-warning">{blockingReason}</p>}
      </section>

      {blockingReason === null ? (
        <section className="detail-section planning-form">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">
                {latest === undefined ? "New draft" : `Revision from v${String(latest.version)}`}
              </p>
              <h2>{latest === undefined ? "创建首版规划" : "编辑下一版本"}</h2>
            </div>
            <span>画像 v{workspace.approvedProfile?.version}</span>
          </div>

          <fieldset>
            <legend>1. 规划范围与学生输入</legend>
            <label>
              标题
              <input
                maxLength={200}
                onChange={(event) => {
                  update("title", event.target.value);
                }}
                value={form.title}
              />
            </label>
            <label>
              规划目标
              <textarea
                maxLength={2000}
                onChange={(event) => {
                  update("goal", event.target.value);
                }}
                value={form.goal}
              />
            </label>
            <div className="form-grid-three">
              <label>
                学生年龄
                <input
                  min="3"
                  max="100"
                  onChange={(event) => {
                    update("ageYears", event.target.value);
                  }}
                  type="number"
                  value={form.ageYears}
                />
              </label>
              <label>
                开始日期
                <input
                  onChange={(event) => {
                    update("planStartDate", event.target.value);
                  }}
                  type="date"
                  value={form.planStartDate}
                />
              </label>
              <label>
                结束日期
                <input
                  onChange={(event) => {
                    update("planEndDate", event.target.value);
                  }}
                  type="date"
                  value={form.planEndDate}
                />
              </label>
            </div>
            <label>
              兴趣方向（每行一项）
              <textarea
                onChange={(event) => {
                  update("interestsText", event.target.value);
                }}
                value={form.interestsText}
              />
            </label>
            <label>
              限制条件（每行一项，可留空）
              <textarea
                onChange={(event) => {
                  update("constraintsText", event.target.value);
                }}
                value={form.constraintsText}
              />
            </label>
            <label>
              课堂反馈（每行一条）
              <textarea
                onChange={(event) => {
                  update("classroomFeedback", event.target.value);
                }}
                value={form.classroomFeedback}
              />
            </label>
            <label>
              课堂画像结论
              <textarea
                onChange={(event) => {
                  update("classroomProfile", event.target.value);
                }}
                value={form.classroomProfile}
              />
            </label>
            <div className="planning-check-grid">
              {workspace.approvedProfile?.claims
                .filter((claim) => claim.informationNature !== "missing")
                .map((claim) => (
                  <label key={claim.id}>
                    <input
                      checked={form.supportingClaimIds.includes(claim.id)}
                      onChange={(event) => {
                        update(
                          "supportingClaimIds",
                          toggleValue(form.supportingClaimIds, claim.id, event.target.checked),
                        );
                      }}
                      type="checkbox"
                    />
                    <span>
                      <strong>{categoryLabels[claim.category] ?? claim.category}</strong> ·{" "}
                      {claim.statement}
                      <small>
                        {claim.informationNature} · {claim.confidence}
                      </small>
                    </span>
                  </label>
                ))}
            </div>
            <h3>已完成课程</h3>
            <CourseChecks
              selected={workspace.catalog.courses
                .filter((course) => form.completedCourseIds.includes(course.courseId))
                .map((course) => course.courseVersionId)}
              setSelected={(versionIds) => {
                update(
                  "completedCourseIds",
                  workspace.catalog.courses
                    .filter((course) => versionIds.includes(course.courseVersionId))
                    .map((course) => course.courseId),
                );
              }}
              workspace={workspace}
            />
            <h3>正在进行的课程</h3>
            <CourseChecks
              selected={form.inProgressCourseVersionIds}
              setSelected={(values) => {
                update("inProgressCourseVersionIds", values);
              }}
              workspace={workspace}
            />
          </fieldset>

          <fieldset>
            <legend>2. 短期优先项（1—3 项）</legend>
            {form.shortTermItems.map((item, index) => (
              <div className="planning-subcard" key={`short-${String(index)}`}>
                <div className="record-item-heading">
                  <h3>优先项 {index + 1}</h3>
                  {form.shortTermItems.length > 1 ? (
                    <button
                      className="link-button danger-link"
                      onClick={() => {
                        update(
                          "shortTermItems",
                          form.shortTermItems.filter((_, candidate) => candidate !== index),
                        );
                      }}
                      type="button"
                    >
                      删除
                    </button>
                  ) : null}
                </div>
                <label>
                  课程
                  <select
                    onChange={(event) => {
                      const next = [...form.shortTermItems];
                      next[index] = { ...item, courseVersionId: event.target.value };
                      update("shortTermItems", next);
                    }}
                    value={item.courseVersionId}
                  >
                    {workspace.catalog.courses.map((course) => (
                      <option key={course.courseVersionId} value={course.courseVersionId}>
                        {course.code} · {course.content.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="form-grid-two">
                  <label>
                    开始
                    <input
                      onChange={(event) => {
                        const next = [...form.shortTermItems];
                        next[index] = { ...item, startDate: event.target.value };
                        update("shortTermItems", next);
                      }}
                      type="date"
                      value={item.startDate}
                    />
                  </label>
                  <label>
                    结束
                    <input
                      onChange={(event) => {
                        const next = [...form.shortTermItems];
                        next[index] = { ...item, endDate: event.target.value };
                        update("shortTermItems", next);
                      }}
                      type="date"
                      value={item.endDate}
                    />
                  </label>
                </div>
                <label>
                  推荐理由
                  <textarea
                    onChange={(event) => {
                      const next = [...form.shortTermItems];
                      next[index] = { ...item, reason: event.target.value };
                      update("shortTermItems", next);
                    }}
                    value={item.reason}
                  />
                </label>
                <label>
                  预期结果
                  <textarea
                    onChange={(event) => {
                      const next = [...form.shortTermItems];
                      next[index] = { ...item, expectedOutcome: event.target.value };
                      update("shortTermItems", next);
                    }}
                    value={item.expectedOutcome}
                  />
                </label>
                <label>
                  风险（每行一项，可留空）
                  <textarea
                    onChange={(event) => {
                      const next = [...form.shortTermItems];
                      next[index] = { ...item, risksText: event.target.value };
                      update("shortTermItems", next);
                    }}
                    value={item.risksText}
                  />
                </label>
              </div>
            ))}
            {form.shortTermItems.length < 3 ? (
              <button
                className="secondary-button"
                onClick={() => {
                  update("shortTermItems", [
                    ...form.shortTermItems,
                    {
                      courseVersionId: workspace.catalog.courses[0]?.courseVersionId ?? "",
                      endDate: form.planEndDate,
                      expectedOutcome: "",
                      reason: "",
                      risksText: "",
                      startDate: form.planStartDate,
                    },
                  ]);
                }}
                type="button"
              >
                ＋ 添加优先项
              </button>
            ) : null}
          </fieldset>

          <fieldset>
            <legend>3. 两条中性并行路线</legend>
            {form.routes.map((route, routeIndex) => (
              <div className="planning-route" key={routeIndex === 0 ? "route-a" : "route-b"}>
                <h3>路线 {routeIndex === 0 ? "A" : "B"}</h3>
                <label>
                  路线名称
                  <input
                    onChange={(event) => {
                      changeRoute(routeIndex, (candidate) => {
                        candidate.name = event.target.value;
                      });
                    }}
                    value={route.name}
                  />
                </label>
                <label>
                  路线说明
                  <textarea
                    onChange={(event) => {
                      changeRoute(routeIndex, (candidate) => {
                        candidate.summary = event.target.value;
                      });
                    }}
                    value={route.summary}
                  />
                </label>
                {route.phases.map((phase, phaseIndex) => (
                  <div
                    className="planning-subcard"
                    key={`${String(routeIndex)}-${String(phaseIndex)}`}
                  >
                    <div className="record-item-heading">
                      <strong>阶段 {phaseIndex + 1}</strong>
                      {route.phases.length > 1 ? (
                        <button
                          className="link-button danger-link"
                          onClick={() => {
                            changeRoute(routeIndex, (candidate) => {
                              candidate.phases.splice(phaseIndex, 1);
                            });
                          }}
                          type="button"
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                    <label>
                      阶段名称
                      <input
                        onChange={(event) => {
                          changePhase(routeIndex, phaseIndex, (candidate) => {
                            candidate.label = event.target.value;
                          });
                        }}
                        value={phase.label}
                      />
                    </label>
                    <div className="form-grid-two">
                      <label>
                        开始
                        <input
                          onChange={(event) => {
                            changePhase(routeIndex, phaseIndex, (candidate) => {
                              candidate.startDate = event.target.value;
                            });
                          }}
                          type="date"
                          value={phase.startDate}
                        />
                      </label>
                      <label>
                        结束
                        <input
                          onChange={(event) => {
                            changePhase(routeIndex, phaseIndex, (candidate) => {
                              candidate.endDate = event.target.value;
                            });
                          }}
                          type="date"
                          value={phase.endDate}
                        />
                      </label>
                    </div>
                    <CourseChecks
                      selected={phase.courseVersionIds}
                      setSelected={(values) => {
                        changePhase(routeIndex, phaseIndex, (candidate) => {
                          candidate.courseVersionIds = values;
                        });
                      }}
                      workspace={workspace}
                    />
                  </div>
                ))}
                <button
                  className="secondary-button"
                  onClick={() => {
                    changeRoute(routeIndex, (candidate) => {
                      candidate.phases.push({
                        courseVersionIds: [],
                        endDate: form.planEndDate,
                        label: `阶段 ${String(route.phases.length + 1)}`,
                        startDate: form.planStartDate,
                      });
                    });
                  }}
                  type="button"
                >
                  ＋ 添加阶段
                </button>
              </div>
            ))}
          </fieldset>

          <fieldset>
            <legend>4. 路线对比、重合与缺口</legend>
            <div className="planning-comparison-table">
              <strong>维度</strong>
              <strong>路线 A</strong>
              <strong>路线 B</strong>
              {form.routeComparison.map((comparison, index) => (
                <div
                  className="planning-comparison-row"
                  key={`${comparison.dimension}-${String(index)}`}
                >
                  <input
                    aria-label={`对比维度 ${String(index + 1)}`}
                    onChange={(event) => {
                      changeComparison(index, (candidate) => {
                        candidate.dimension = event.target.value;
                      });
                    }}
                    value={comparison.dimension}
                  />
                  <textarea
                    aria-label={`${comparison.dimension}路线A`}
                    onChange={(event) => {
                      changeComparison(index, (candidate) => {
                        candidate.routeA = event.target.value;
                      });
                    }}
                    value={comparison.routeA}
                  />
                  <textarea
                    aria-label={`${comparison.dimension}路线B`}
                    onChange={(event) => {
                      changeComparison(index, (candidate) => {
                        candidate.routeB = event.target.value;
                      });
                    }}
                    value={comparison.routeB}
                  />
                </div>
              ))}
            </div>
            <label>
              两条路线的重合点（每行一项）
              <textarea
                onChange={(event) => {
                  update("overlapText", event.target.value);
                }}
                value={form.overlapText}
              />
            </label>
            <label>
              路线 A 缺口（每行一项，可留空）
              <textarea
                onChange={(event) => {
                  update("routeAGapsText", event.target.value);
                }}
                value={form.routeAGapsText}
              />
            </label>
            <label>
              路线 B 缺口（每行一项，可留空）
              <textarea
                onChange={(event) => {
                  update("routeBGapsText", event.target.value);
                }}
                value={form.routeBGapsText}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>5. 决策时间点与复查</legend>
            <label>
              到期决策问题
              <textarea
                onChange={(event) => {
                  update("decisionQuestion", event.target.value);
                }}
                value={form.decisionQuestion}
              />
            </label>
            <label>
              可观察信号（每行一项）
              <textarea
                onChange={(event) => {
                  update("decisionSignalsText", event.target.value);
                }}
                value={form.decisionSignalsText}
              />
            </label>
            <div className="form-grid-three">
              <label>
                观察开始
                <input
                  onChange={(event) => {
                    update("decisionStartDate", event.target.value);
                  }}
                  type="date"
                  value={form.decisionStartDate}
                />
              </label>
              <label>
                观察结束
                <input
                  onChange={(event) => {
                    update("decisionEndDate", event.target.value);
                  }}
                  type="date"
                  value={form.decisionEndDate}
                />
              </label>
              <label>
                规划复查日
                <input
                  min={today()}
                  onChange={(event) => {
                    update("reviewDueDate", event.target.value);
                  }}
                  type="date"
                  value={form.reviewDueDate}
                />
              </label>
            </div>
            <label>
              总体风险（每行一项）
              <textarea
                onChange={(event) => {
                  update("risksText", event.target.value);
                }}
                value={form.risksText}
              />
            </label>
          </fieldset>

          <button disabled={busy} onClick={() => void savePlan()} type="button">
            {busy ? "处理中…" : latest === undefined ? "保存首版草稿" : "创建修订草稿"}
          </button>
        </section>
      ) : null}

      {latest === undefined ? null : (
        <section className="detail-section planning-review">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">Rule review</p>
              <h2>当前版本规则检查与审批</h2>
            </div>
            <span>
              {latest.evaluation.hardViolationCount} 个硬阻断 · {latest.evaluation.warningCount}{" "}
              个提醒
            </span>
          </div>
          {latest.evaluation.scopes.flatMap((scope) =>
            scope.result.violations.map((violation) => ({ scope, violation })),
          ).length === 0 ? (
            <p className="form-message success">确定性课程规则检查通过。</p>
          ) : (
            <div className="record-list">
              {latest.evaluation.scopes
                .flatMap((scope) =>
                  scope.result.violations.map((violation) => ({ scope, violation })),
                )
                .map(({ scope, violation }) => {
                  const existing = latest.overrides.find(
                    (item) =>
                      item.violationKey === violation.violationKey && item.status !== "rejected",
                  );
                  const key = `${scope.scopeKey}:${violation.violationKey}`;
                  return (
                    <article className="record-item" key={key}>
                      <div className="record-item-heading">
                        <h3>{scope.label}</h3>
                        <span
                          className={`plan-status ${violation.severity === "hard" ? "needs_review" : "draft"}`}
                        >
                          {violation.severity === "hard" ? "硬阻断" : "提醒"}
                        </span>
                      </div>
                      <p>{violation.message}</p>
                      <small>
                        {violation.ruleType} · 规则版本 {violation.ruleVersionId.slice(0, 8)}
                      </small>
                      {violation.severity === "hard" &&
                      existing === undefined &&
                      ["draft", "in_review"].includes(latest.status) ? (
                        <>
                          <label>
                            人工覆盖理由
                            <textarea
                              onChange={(event) => {
                                setOverrideReasons((current) => ({
                                  ...current,
                                  [key]: event.target.value,
                                }));
                              }}
                              value={overrideReasons[key] ?? ""}
                            />
                          </label>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void requestOverride(scope.scopeKey, violation.violationKey)
                            }
                            type="button"
                          >
                            申请规则覆盖
                          </button>
                        </>
                      ) : null}
                      {existing === undefined ? null : (
                        <div className="planning-override">
                          <p>
                            覆盖状态：{existing.status} · 申请人 {existing.requestedByDisplayName}
                          </p>
                          <p>理由：{existing.reason}</p>
                          {existing.status === "pending" ? (
                            <>
                              <label>
                                拒绝理由（批准时无需填写）
                                <textarea
                                  onChange={(event) => {
                                    setOverrideReasons((current) => ({
                                      ...current,
                                      [existing.id]: event.target.value,
                                    }));
                                  }}
                                  value={overrideReasons[existing.id] ?? ""}
                                />
                              </label>
                              <div className="record-actions">
                                <button
                                  disabled={busy}
                                  onClick={() => void decideOverride(existing.id, "approve")}
                                  type="button"
                                >
                                  批准覆盖
                                </button>
                                <button
                                  className="danger-button"
                                  disabled={busy}
                                  onClick={() => void decideOverride(existing.id, "reject")}
                                  type="button"
                                >
                                  拒绝覆盖
                                </button>
                              </div>
                            </>
                          ) : null}
                        </div>
                      )}
                    </article>
                  );
                })}
            </div>
          )}
          <div className="planning-transition-box">
            {latest.status === "draft" ? (
              <button disabled={busy} onClick={() => void transition("submit")} type="button">
                提交审核
              </button>
            ) : null}
            {latest.status === "in_review" ? (
              <>
                <button disabled={busy} onClick={() => void transition("approve")} type="button">
                  批准规划
                </button>
                <label>
                  退回理由
                  <textarea
                    onChange={(event) => {
                      setTransitionReason(event.target.value);
                    }}
                    value={transitionReason}
                  />
                </label>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void transition("return")}
                  type="button"
                >
                  退回草稿
                </button>
              </>
            ) : null}
            {latest.status === "approved" ? (
              <a
                className="primary-link"
                href={`/api/students/${studentId}/plans/${latest.id}/export`}
              >
                导出 Markdown
              </a>
            ) : null}
            {latest.status !== "archived" ? (
              <>
                <label>
                  归档原因
                  <textarea
                    onChange={(event) => {
                      setTransitionReason(event.target.value);
                    }}
                    value={transitionReason}
                  />
                </label>
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() => void transition("archive")}
                  type="button"
                >
                  归档当前版本
                </button>
              </>
            ) : null}
          </div>
        </section>
      )}

      <section className="detail-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Version history</p>
            <h2>规划版本历史</h2>
          </div>
        </div>
        {workspace.plans.length === 0 ? (
          <p>尚无规划版本。</p>
        ) : (
          <div className="record-list">
            {workspace.plans.map((plan) => (
              <PlanHistory key={plan.id} plan={plan} workspace={workspace} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
