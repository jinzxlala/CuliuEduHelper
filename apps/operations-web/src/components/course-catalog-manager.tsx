"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type JSX, type SyntheticEvent } from "react";

import type { CourseCatalogVersion } from "@culiu/course-planning";

import {
  hoursToMinutes,
  linesFromInput,
  minuteToTime,
  minutesToHours,
  tagsFromInput,
} from "../lib/course-catalog-form";
import { normalizeStableCode, timeToMinutes } from "../lib/scheduling-form";

interface WeeklySessionDraft {
  endTime: string;
  id: string;
  startTime: string;
  weekday: number;
}

const WEEKDAYS = [
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [7, "周日"],
] as const;

const STATUS_LABELS: Record<CourseCatalogVersion["status"], string> = {
  approved: "已批准",
  archived: "已归档",
  draft: "草稿",
};

const DIFFICULTY_LABELS = {
  advanced: "进阶",
  foundation: "基础",
  intermediate: "中阶",
} as const;

let localId = 0;
function nextId(): string {
  localId += 1;
  return `course-session-${String(localId)}`;
}

function emptySession(): WeeklySessionDraft {
  return { endTime: "11:00", id: nextId(), startTime: "09:00", weekday: 6 };
}

function sessionsFromCourse(source: CourseCatalogVersion | null): WeeklySessionDraft[] {
  if (source === null || source.content.schedule.length === 0) return [emptySession()];
  return source.content.schedule.map((session) => ({
    endTime: minuteToTime(session.endMinute),
    id: nextId(),
    startTime: minuteToTime(session.startMinute),
    weekday: session.weekday,
  }));
}

function TextListField({
  hint,
  label,
  onChange,
  required = false,
  value,
}: Readonly<{
  hint: string;
  label: string;
  onChange: (value: string) => void;
  required?: boolean;
  value: string;
}>): JSX.Element {
  return (
    <label>
      {label}
      <textarea
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder="每行填写一项"
        required={required}
        rows={4}
        value={value}
      />
      <small>{hint}</small>
    </label>
  );
}

function TagField({
  hint,
  label,
  onChange,
  required = false,
  value,
}: Readonly<{
  hint: string;
  label: string;
  onChange: (value: string) => void;
  required?: boolean;
  value: string;
}>): JSX.Element {
  return (
    <label>
      {label}
      <input
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder="例如 programming, ai-tools"
        required={required}
        value={value}
      />
      <small>{hint}</small>
    </label>
  );
}

function WeeklyScheduleEditor({
  onChange,
  sessions,
}: Readonly<{
  onChange: (sessions: WeeklySessionDraft[]) => void;
  sessions: WeeklySessionDraft[];
}>): JSX.Element {
  function update(id: string, patch: Partial<WeeklySessionDraft>): void {
    onChange(sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)));
  }
  return (
    <fieldset>
      <legend>固定每周上课时段</legend>
      <p className="field-hint">排课型课程至少需要一个时段；可以添加每周多次课。</p>
      <div className="repeatable-list">
        {sessions.map((session) => (
          <div className="availability-row" key={session.id}>
            <label>
              星期
              <select
                onChange={(event) => {
                  update(session.id, { weekday: Number(event.target.value) });
                }}
                value={session.weekday}
              >
                {WEEKDAYS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              开始
              <input
                onChange={(event) => {
                  update(session.id, { startTime: event.target.value });
                }}
                required
                type="time"
                value={session.startTime}
              />
            </label>
            <label>
              结束
              <input
                onChange={(event) => {
                  update(session.id, { endTime: event.target.value });
                }}
                required
                type="time"
                value={session.endTime}
              />
            </label>
            <button
              className="remove-row-button"
              disabled={sessions.length === 1}
              onClick={() => {
                onChange(sessions.filter((item) => item.id !== session.id));
              }}
              type="button"
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <button
        className="secondary-action add-row-button"
        onClick={() => {
          onChange([...sessions, emptySession()]);
        }}
        type="button"
      >
        ＋ 添加每周时段
      </button>
    </fieldset>
  );
}

function CourseTemplateForm({
  onCancel,
  onSaved,
  source,
}: Readonly<{
  onCancel: () => void;
  onSaved: () => Promise<void>;
  source: CourseCatalogVersion | null;
}>): JSX.Element {
  const [capabilityTags, setCapabilityTags] = useState(
    source?.content.capabilityTags.join(", ") ?? "",
  );
  const [code, setCode] = useState(source?.code ?? "");
  const [deliverables, setDeliverables] = useState(source?.content.deliverables.join("\n") ?? "");
  const [deliveryMode, setDeliveryMode] = useState<"scheduled" | "self_paced">(
    source?.content.deliveryMode ?? "scheduled",
  );
  const [difficulty, setDifficulty] = useState<"advanced" | "foundation" | "intermediate">(
    source?.content.difficulty ?? "foundation",
  );
  const [durationWeeks, setDurationWeeks] = useState(String(source?.content.durationWeeks ?? 12));
  const [error, setError] = useState("");
  const [notSuitable, setNotSuitable] = useState(
    source?.content.notSuitableConditions.join("\n") ?? "",
  );
  const [objectives, setObjectives] = useState(source?.content.objectives.join("\n") ?? "");
  const [pending, setPending] = useState(false);
  const [projectTypes, setProjectTypes] = useState(source?.content.projectTypes.join(", ") ?? "");
  const [schedule, setSchedule] = useState<WeeklySessionDraft[]>(sessionsFromCourse(source));
  const [stage, setStage] = useState(source?.content.stage ?? "");
  const [subjectTags, setSubjectTags] = useState(source?.content.subjectTags.join(", ") ?? "");
  const [summary, setSummary] = useState(source?.content.summary ?? "");
  const [termEndDate, setTermEndDate] = useState(source?.content.termEndDate ?? "");
  const [termStartDate, setTermStartDate] = useState(source?.content.termStartDate ?? "");
  const [title, setTitle] = useState(source?.content.title ?? "");
  const [totalHours, setTotalHours] = useState(
    source === null ? "24" : minutesToHours(source.content.totalInstructionMinutes),
  );
  const [weeklyHours, setWeeklyHours] = useState(
    source === null ? "2" : minutesToHours(source.content.weeklyLoadMinutes),
  );

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const parsedObjectives = linesFromInput(objectives);
      const parsedDeliverables = linesFromInput(deliverables);
      const parsedCapabilityTags = tagsFromInput(capabilityTags);
      const parsedSubjectTags = tagsFromInput(subjectTags);
      if (parsedObjectives.length === 0) throw new Error("请至少填写一项课程目标。");
      if (parsedDeliverables.length === 0) throw new Error("请至少填写一项课程成果。");
      if (parsedCapabilityTags.length === 0) throw new Error("请至少填写一个能力标签。");
      if (parsedSubjectTags.length === 0) throw new Error("请至少填写一个学科标签。");
      if (deliveryMode === "scheduled" && (!termStartDate || !termEndDate)) {
        throw new Error("排课型课程必须填写开始和结束日期。");
      }
      if (termStartDate && termEndDate && termEndDate < termStartDate) {
        throw new Error("课程结束日期不能早于开始日期。");
      }
      const serializedSchedule =
        deliveryMode === "self_paced"
          ? []
          : schedule.map((session) => {
              const startMinute = timeToMinutes(session.startTime);
              const endMinute = timeToMinutes(session.endTime);
              if (
                !Number.isFinite(startMinute) ||
                !Number.isFinite(endMinute) ||
                endMinute <= startMinute
              ) {
                throw new Error("每个上课时段的结束时间必须晚于开始时间。");
              }
              return { endMinute, startMinute, weekday: session.weekday };
            });
      const content = {
        capabilityTags: parsedCapabilityTags,
        deliverables: parsedDeliverables,
        deliveryMode,
        difficulty,
        durationWeeks: Number(durationWeeks),
        notSuitableConditions: linesFromInput(notSuitable),
        objectives: parsedObjectives,
        projectTypes: tagsFromInput(projectTypes),
        schedule: serializedSchedule,
        stage: stage.trim(),
        subjectTags: parsedSubjectTags,
        summary: summary.trim(),
        ...(deliveryMode === "scheduled" ? { termEndDate, termStartDate } : {}),
        title: title.trim(),
        totalInstructionMinutes: hoursToMinutes(totalHours),
        weeklyLoadMinutes: hoursToMinutes(weeklyHours),
      };
      const body =
        source === null
          ? { action: "create_course", input: { code: normalizeStableCode(code), content } }
          : {
              action: "revise_course",
              courseVersionId: source.courseVersionId,
              input: { content, expectedSourceUpdatedAt: source.updatedAt },
            };
      const response = await fetch("/api/courses", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const responseBody = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(responseBody.message ?? "课程模板保存失败。");
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请检查课程模板内容。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="scheduling-form course-template-form" onSubmit={(event) => void submit(event)}>
      <div className="form-grid-two">
        <label>
          课程编号
          <input
            disabled={source !== null}
            onBlur={() => {
              setCode(normalizeStableCode(code));
            }}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            placeholder="例如 USACO_SILVER"
            required
            value={code}
          />
          <small>建议使用英文或拼音；创建后编号保持不变。</small>
        </label>
        <label>
          课程名称
          <input
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            placeholder="例如 USACO Silver 进阶课程"
            required
            value={title}
          />
        </label>
        <label>
          适用阶段
          <input
            onChange={(event) => {
              setStage(event.target.value);
            }}
            placeholder="例如 G7-G10／竞赛进阶"
            required
            value={stage}
          />
        </label>
        <label>
          难度
          <select
            onChange={(event) => {
              setDifficulty(event.target.value as typeof difficulty);
            }}
            value={difficulty}
          >
            <option value="foundation">基础</option>
            <option value="intermediate">中阶</option>
            <option value="advanced">进阶</option>
          </select>
        </label>
        <label>
          授课方式
          <select
            onChange={(event) => {
              setDeliveryMode(event.target.value as typeof deliveryMode);
            }}
            value={deliveryMode}
          >
            <option value="scheduled">固定排课</option>
            <option value="self_paced">自主学习／无固定时段</option>
          </select>
        </label>
        <label>
          课程周期（周）
          <input
            max="104"
            min="1"
            onChange={(event) => {
              setDurationWeeks(event.target.value);
            }}
            required
            type="number"
            value={durationWeeks}
          />
        </label>
        <label>
          总授课时数
          <input
            min="0.5"
            onChange={(event) => {
              setTotalHours(event.target.value);
            }}
            required
            step="0.5"
            type="number"
            value={totalHours}
          />
        </label>
        <label>
          每周学习负荷（小时）
          <input
            min="0.25"
            onChange={(event) => {
              setWeeklyHours(event.target.value);
            }}
            required
            step="0.25"
            type="number"
            value={weeklyHours}
          />
        </label>
      </div>
      <label>
        课程简介
        <textarea
          maxLength={4000}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
          placeholder="说明课程面向谁、解决什么学习问题，以及主要学习方式。"
          required
          rows={5}
          value={summary}
        />
      </label>
      <div className="form-grid-two align-start">
        <TextListField
          hint="例如掌握图论基础、能够独立完成竞赛题建模。"
          label="课程目标"
          onChange={setObjectives}
          required
          value={objectives}
        />
        <TextListField
          hint="例如完成结课项目、形成错题复盘文档。"
          label="课程成果／交付物"
          onChange={setDeliverables}
          required
          value={deliverables}
        />
        <TextListField
          hint="可留空；每行填写一种不适用情况。"
          label="不适用条件"
          onChange={setNotSuitable}
          value={notSuitable}
        />
        <div className="course-tag-fields">
          <TagField
            hint="用于匹配教师资质，使用英文或拼音短标签。"
            label="能力标签"
            onChange={setCapabilityTags}
            required
            value={capabilityTags}
          />
          <TagField
            hint="用于课程检索和规划筛选。"
            label="学科标签"
            onChange={setSubjectTags}
            required
            value={subjectTags}
          />
          <TagField
            hint="可留空，例如 research, portfolio。"
            label="项目类型标签"
            onChange={setProjectTypes}
            value={projectTypes}
          />
        </div>
      </div>
      {deliveryMode === "scheduled" && (
        <>
          <div className="form-grid-two">
            <label>
              课程开始日期
              <input
                onChange={(event) => {
                  setTermStartDate(event.target.value);
                }}
                required
                type="date"
                value={termStartDate}
              />
            </label>
            <label>
              课程结束日期
              <input
                min={termStartDate || undefined}
                onChange={(event) => {
                  setTermEndDate(event.target.value);
                }}
                required
                type="date"
                value={termEndDate}
              />
            </label>
          </div>
          <WeeklyScheduleEditor onChange={setSchedule} sessions={schedule} />
        </>
      )}
      {error && <p className="form-message error">{error}</p>}
      <div className="form-action-row">
        <button className="submit-configuration" disabled={pending} type="submit">
          {pending ? "正在保存……" : source === null ? "保存课程模板草稿" : "保存为新修订草稿"}
        </button>
        {source !== null && (
          <button className="secondary-action" onClick={onCancel} type="button">
            取消修订
          </button>
        )}
      </div>
    </form>
  );
}

function ArchiveCourseControl({
  course,
  onTransition,
}: Readonly<{
  course: CourseCatalogVersion;
  onTransition: (
    course: CourseCatalogVersion,
    action: "approve" | "archive",
    reason?: string,
  ) => Promise<void>;
}>): JSX.Element {
  const [reason, setReason] = useState("");
  return (
    <details className="archive-control">
      <summary>归档此版本</summary>
      <label>
        归档原因
        <input
          onChange={(event) => {
            setReason(event.target.value);
          }}
          placeholder="例如课程已停用或被新版替代"
          value={reason}
        />
      </label>
      <button
        className="danger-action"
        disabled={!reason.trim()}
        onClick={() => {
          void onTransition(course, "archive", reason.trim());
        }}
        type="button"
      >
        确认归档
      </button>
    </details>
  );
}

export function CourseCatalogManager(): JSX.Element {
  const [courses, setCourses] = useState<CourseCatalogVersion[]>([]);
  const [editing, setEditing] = useState<CourseCatalogVersion | null>(null);
  const [formGeneration, setFormGeneration] = useState(0);
  const [message, setMessage] = useState("正在读取课程模板……");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/courses", { cache: "no-store" });
    if (!response.ok) {
      setMessage("课程模板读取失败，请刷新页面重试。");
      return;
    }
    const body = (await response.json()) as { courses: CourseCatalogVersion[] };
    setCourses(body.courses);
    setMessage(body.courses.length === 0 ? "目前还没有课程模板，请先创建第一门课程。" : "");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function formSaved(): Promise<void> {
    setEditing(null);
    setFormGeneration((value) => value + 1);
    setMessage("课程模板草稿已保存，请在下方检查并批准。批准后即可用于班级排课。");
    await refresh();
  }

  async function transition(
    course: CourseCatalogVersion,
    action: "approve" | "archive",
    reason?: string,
  ): Promise<void> {
    setPending(true);
    setMessage(action === "approve" ? "正在批准课程模板……" : "正在归档课程模板……");
    try {
      const response = await fetch("/api/courses", {
        body: JSON.stringify({
          action: "transition_course",
          courseVersionId: course.courseVersionId,
          input: {
            action,
            expectedUpdatedAt: course.updatedAt,
            ...(action === "archive" ? { reason } : {}),
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setMessage(
        response.ok
          ? action === "approve"
            ? "课程模板已批准，现在可以在排课页面选择。"
            : "课程模板版本已归档。"
          : (body.message ?? "课程模板状态变更失败。"),
      );
      if (response.ok) await refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="course-catalog-workspace">
      <section className="editor-panel scheduling-create-panel">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Step 1 · Create or revise</p>
            <h2>{editing === null ? "新增课程模板" : `修订 ${editing.content.title}`}</h2>
          </div>
          <span className="workflow-badge">草稿不会自动进入排课</span>
        </div>
        <CourseTemplateForm
          key={`${editing?.courseVersionId ?? "new"}-${String(formGeneration)}`}
          onCancel={() => {
            setEditing(null);
          }}
          onSaved={formSaved}
          source={editing}
        />
      </section>

      <section className="editor-panel course-version-panel">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Step 2 · Review and approve</p>
            <h2>课程模板与版本</h2>
          </div>
          <Link className="secondary-link" href="/scheduling">
            前往班级与排课 →
          </Link>
        </div>
        {message && (
          <p className="status-note" role="status">
            {message}
          </p>
        )}
        <div className="course-version-grid">
          {courses.map((course) => (
            <article
              className={`course-version-card status-${course.status}`}
              key={course.courseVersionId}
            >
              <div className="section-heading-row">
                <div>
                  <p className="eyebrow">
                    {course.code} · V{course.version}
                  </p>
                  <h3>{course.content.title}</h3>
                </div>
                <span className="status-pill">{STATUS_LABELS[course.status]}</span>
              </div>
              <p>{course.content.summary}</p>
              <dl className="course-facts">
                <div>
                  <dt>阶段</dt>
                  <dd>{course.content.stage}</dd>
                </div>
                <div>
                  <dt>难度</dt>
                  <dd>{DIFFICULTY_LABELS[course.content.difficulty]}</dd>
                </div>
                <div>
                  <dt>周期</dt>
                  <dd>{course.content.durationWeeks} 周</dd>
                </div>
                <div>
                  <dt>总课时</dt>
                  <dd>{minutesToHours(course.content.totalInstructionMinutes)} 小时</dd>
                </div>
              </dl>
              <div className="chip-list">
                {course.content.capabilityTags.map((tag) => (
                  <span className="static-chip" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
              {course.status !== "archived" && (
                <div className="course-card-actions">
                  {course.status === "draft" && (
                    <button
                      disabled={pending}
                      onClick={() => {
                        void transition(course, "approve");
                      }}
                      type="button"
                    >
                      批准并开放给排课
                    </button>
                  )}
                  <button
                    className="secondary-action"
                    disabled={pending}
                    onClick={() => {
                      setEditing(course);
                    }}
                    type="button"
                  >
                    创建修订草稿
                  </button>
                  <ArchiveCourseControl course={course} onTransition={transition} />
                </div>
              )}
              {course.status === "archived" && course.invalidationReason !== null && (
                <p className="archive-reason">归档原因：{course.invalidationReason}</p>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
