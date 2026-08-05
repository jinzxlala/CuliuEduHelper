"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type JSX,
  type SyntheticEvent,
} from "react";

import {
  generateWeeklyOccurrences,
  normalizeStableCode,
  normalizeTag,
  timeToMinutes,
  uniqueNonEmptyLines,
} from "../lib/scheduling-form";

interface AvailabilityDraft {
  endTime: string;
  id: string;
  startTime: string;
  weekday: number;
}

interface OccurrenceDraft {
  endTime: string;
  id: string;
  sessionDate: string;
  startTime: string;
}

interface CandidateScheduleDraft {
  endTime: string;
  id: string;
  kind: "short_term" | "weekly";
  label: string;
  occurrences: OccurrenceDraft[];
  preferenceRank: number;
  startTime: string;
  weekday: number;
}

interface Catalog {
  courses: Array<{
    code: string;
    content: { title: string };
    courseVersionId: string;
  }>;
  locations: Array<{
    code: string;
    content: { name: string };
    locationId: string;
    status: string;
    updatedAt: string;
    versionId: string;
  }>;
  offerings: Array<{
    code: string;
    content: {
      candidateSchedules: Array<{ label: string; occurrences: unknown[] }>;
      className: string;
      locationVersionId: string;
      studentRosterText: string[];
    };
    status: string;
    updatedAt: string;
    versionId: string;
  }>;
  teachers: Array<{
    code: string;
    content: { name: string; qualificationTags: string[] };
    status: string;
    teacherId: string;
    updatedAt: string;
    versionId: string;
  }>;
  timetableRuns: Array<{
    createdAt: string;
    id: string;
    output: {
      assignments?: unknown[];
      unassigned?: Array<{ offeringId: string; reason: string }>;
    } | null;
    runtimeMs: number | null;
    status: string;
  }>;
}

type ConfigurationAction = "create_location" | "create_offering" | "create_teacher";
type SaveConfiguration = (action: ConfigurationAction, input: unknown) => Promise<boolean>;

const WEEKDAYS = [
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [7, "周日"],
] as const;

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  return `${prefix}-${String(localId)}`;
}

function newAvailability(): AvailabilityDraft {
  return { endTime: "20:00", id: nextId("availability"), startTime: "08:00", weekday: 6 };
}

function newOccurrence(): OccurrenceDraft {
  return {
    endTime: "11:00",
    id: nextId("occurrence"),
    sessionDate: "",
    startTime: "09:00",
  };
}

function newCandidateSchedule(): CandidateScheduleDraft {
  return {
    endTime: "11:00",
    id: nextId("schedule"),
    kind: "weekly",
    label: "",
    occurrences: [newOccurrence()],
    preferenceRank: 1,
    startTime: "09:00",
    weekday: 6,
  };
}

function serializeAvailability(rows: AvailabilityDraft[]): Array<{
  endMinute: number;
  startMinute: number;
  weekday: number;
}> {
  if (rows.length === 0) throw new Error("请至少添加一个每周可用时段。");
  return rows.map((row) => {
    const startMinute = timeToMinutes(row.startTime);
    const endMinute = timeToMinutes(row.endTime);
    if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || endMinute <= startMinute) {
      throw new Error("每个可用时段的结束时间必须晚于开始时间。");
    }
    return { endMinute, startMinute, weekday: row.weekday };
  });
}

function TagEditor({
  hint,
  label,
  onChange,
  suggestions,
  values,
}: Readonly<{
  hint: string;
  label: string;
  onChange: (values: string[]) => void;
  suggestions: string[];
  values: string[];
}>): JSX.Element {
  const [draft, setDraft] = useState("");
  const listId = useId();
  function addTag(): void {
    const tag = normalizeTag(draft);
    if (tag && !values.includes(tag)) onChange([...values, tag]);
    setDraft("");
  }
  return (
    <fieldset className="tag-editor">
      <legend>{label}</legend>
      <p className="field-hint">{hint}</p>
      <div className="inline-entry-row">
        <input
          aria-label={`${label}输入`}
          list={listId}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="输入后按回车或点击添加"
          value={draft}
        />
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <button className="secondary-action" onClick={addTag} type="button">
          添加
        </button>
      </div>
      <div className="chip-list" aria-label={`${label}已选内容`}>
        {values.length === 0 && <span className="empty-inline">尚未添加</span>}
        {values.map((value) => (
          <button
            className="removable-chip"
            key={value}
            onClick={() => {
              onChange(values.filter((item) => item !== value));
            }}
            title={`删除 ${value}`}
            type="button"
          >
            {value} ×
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function DateListEditor({
  label,
  onChange,
  values,
}: Readonly<{
  label: string;
  onChange: (values: string[]) => void;
  values: string[];
}>): JSX.Element {
  const [draft, setDraft] = useState("");
  function addDate(): void {
    if (draft && !values.includes(draft)) onChange([...values, draft].sort());
    setDraft("");
  }
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="inline-entry-row">
        <input
          aria-label={`${label}日期`}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          type="date"
          value={draft}
        />
        <button className="secondary-action" onClick={addDate} type="button">
          添加日期
        </button>
      </div>
      <div className="chip-list">
        {values.length === 0 && <span className="empty-inline">没有特殊不可用日期</span>}
        {values.map((value) => (
          <button
            className="removable-chip"
            key={value}
            onClick={() => {
              onChange(values.filter((item) => item !== value));
            }}
            type="button"
          >
            {value} ×
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function AvailabilityEditor({
  label,
  onChange,
  rows,
}: Readonly<{
  label: string;
  onChange: (rows: AvailabilityDraft[]) => void;
  rows: AvailabilityDraft[];
}>): JSX.Element {
  function update(id: string, patch: Partial<AvailabilityDraft>): void {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  return (
    <fieldset>
      <legend>{label}</legend>
      <p className="field-hint">可以添加多天或同一天的多个时间段。</p>
      <div className="repeatable-list">
        {rows.map((row) => (
          <div className="availability-row" key={row.id}>
            <label>
              星期
              <select
                onChange={(event) => {
                  update(row.id, { weekday: Number(event.target.value) });
                }}
                value={row.weekday}
              >
                {WEEKDAYS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              开始
              <input
                onChange={(event) => {
                  update(row.id, { startTime: event.target.value });
                }}
                required
                type="time"
                value={row.startTime}
              />
            </label>
            <label>
              结束
              <input
                onChange={(event) => {
                  update(row.id, { endTime: event.target.value });
                }}
                required
                type="time"
                value={row.endTime}
              />
            </label>
            <button
              className="remove-row-button"
              disabled={rows.length === 1}
              onClick={() => {
                onChange(rows.filter((item) => item.id !== row.id));
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
          onChange([...rows, newAvailability()]);
        }}
        type="button"
      >
        ＋ 添加可用时段
      </button>
    </fieldset>
  );
}

function TeacherForm({
  onSave,
  suggestions,
}: Readonly<{ onSave: SaveConfiguration; suggestions: string[] }>): JSX.Element {
  const [availability, setAvailability] = useState<AvailabilityDraft[]>([newAvailability()]);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [preferredTags, setPreferredTags] = useState<string[]>([]);
  const [qualificationTags, setQualificationTags] = useState<string[]>([]);
  const [unavailableDates, setUnavailableDates] = useState<string[]>([]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (qualificationTags.length === 0) throw new Error("请至少添加一项授课能力。");
      await onSave("create_teacher", {
        code: normalizeStableCode(code),
        content: {
          maxDailyMinutes: Math.round(Number(form.get("maxDailyHours")) * 60),
          maxWeeklyMinutes: Math.round(Number(form.get("maxWeeklyHours")) * 60),
          name: name.trim(),
          preferredTags,
          qualificationTags,
          unavailableDates,
          weeklyAvailability: serializeAvailability(availability),
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请检查教师信息。");
    }
  }

  return (
    <form className="scheduling-form" onSubmit={(event) => void submit(event)}>
      <div className="form-grid-two">
        <label>
          教师编号
          <input
            onBlur={() => {
              setCode(normalizeStableCode(code));
            }}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            placeholder="例如 TEACHER_LI"
            required
            value={code}
          />
          <small>建议使用英文或拼音；空格会自动转为下划线并转为大写。</small>
        </label>
        <label>
          教师姓名
          <input
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
            value={name}
          />
        </label>
        <label>
          每日最多授课小时
          <input
            defaultValue="8"
            min="0.5"
            name="maxDailyHours"
            required
            step="0.5"
            type="number"
          />
        </label>
        <label>
          每周最多授课小时
          <input
            defaultValue="20"
            min="0.5"
            name="maxWeeklyHours"
            required
            step="0.5"
            type="number"
          />
        </label>
      </div>
      <TagEditor
        hint="用于判断教师是否具备班级要求的授课能力。"
        label="授课能力"
        onChange={setQualificationTags}
        suggestions={suggestions}
        values={qualificationTags}
      />
      <TagEditor
        hint="可选，用于在多个合格教师之间优先匹配。"
        label="偏好课程标签"
        onChange={setPreferredTags}
        suggestions={suggestions}
        values={preferredTags}
      />
      <AvailabilityEditor label="每周可用时间" onChange={setAvailability} rows={availability} />
      <DateListEditor
        label="临时不可用日期"
        onChange={setUnavailableDates}
        values={unavailableDates}
      />
      {error && <p className="form-message error">{error}</p>}
      <button className="submit-configuration" type="submit">
        保存教师草稿
      </button>
    </form>
  );
}

function LocationForm({ onSave }: Readonly<{ onSave: SaveConfiguration }>): JSX.Element {
  const [availability, setAvailability] = useState<AvailabilityDraft[]>([newAvailability()]);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [unavailableDates, setUnavailableDates] = useState<string[]>([]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      await onSave("create_location", {
        code: normalizeStableCode(code),
        content: {
          name: name.trim(),
          unavailableDates,
          weeklyAvailability: serializeAvailability(availability),
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请检查地点信息。");
    }
  }

  return (
    <form className="scheduling-form" onSubmit={(event) => void submit(event)}>
      <div className="form-grid-two">
        <label>
          地点编号
          <input
            onBlur={() => {
              setCode(normalizeStableCode(code));
            }}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            placeholder="例如 ROOM_NANSHAN_A"
            required
            value={code}
          />
        </label>
        <label>
          地点名称
          <input
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="例如 南山校区 A 教室"
            required
            value={name}
          />
        </label>
      </div>
      <AvailabilityEditor label="地点每周开放时间" onChange={setAvailability} rows={availability} />
      <DateListEditor
        label="地点临时停用日期"
        onChange={setUnavailableDates}
        values={unavailableDates}
      />
      {error && <p className="form-message error">{error}</p>}
      <button className="submit-configuration" type="submit">
        保存地点草稿
      </button>
    </form>
  );
}

function CandidateSchedulesEditor({
  classEndDate,
  classStartDate,
  onChange,
  schedules,
}: Readonly<{
  classEndDate: string;
  classStartDate: string;
  onChange: (schedules: CandidateScheduleDraft[]) => void;
  schedules: CandidateScheduleDraft[];
}>): JSX.Element {
  function updateSchedule(id: string, patch: Partial<CandidateScheduleDraft>): void {
    onChange(
      schedules.map((schedule) => (schedule.id === id ? { ...schedule, ...patch } : schedule)),
    );
  }
  function updateOccurrence(
    scheduleId: string,
    occurrenceId: string,
    patch: Partial<OccurrenceDraft>,
  ): void {
    onChange(
      schedules.map((schedule) =>
        schedule.id === scheduleId
          ? {
              ...schedule,
              occurrences: schedule.occurrences.map((occurrence) =>
                occurrence.id === occurrenceId ? { ...occurrence, ...patch } : occurrence,
              ),
            }
          : schedule,
      ),
    );
  }
  return (
    <fieldset className="candidate-schedules-editor">
      <legend>完整候选课表</legend>
      <p className="field-hint">
        每套方案必须列出这个班的全部课次。求解器会从这些完整方案中选择一套，不会拼接不同方案。
      </p>
      {schedules.map((schedule, scheduleIndex) => (
        <section className="candidate-schedule-card" key={schedule.id}>
          <div className="section-heading-row">
            <h4>候选方案 {scheduleIndex + 1}</h4>
            <button
              className="remove-row-button"
              disabled={schedules.length === 1}
              onClick={() => {
                onChange(schedules.filter((item) => item.id !== schedule.id));
              }}
              type="button"
            >
              删除方案
            </button>
          </div>
          <div className="form-grid-three">
            <label>
              方案名称
              <input
                onChange={(event) => {
                  updateSchedule(schedule.id, { label: event.target.value });
                }}
                placeholder="例如 周六上午方案"
                required
                value={schedule.label}
              />
            </label>
            <label>
              方案类型
              <select
                onChange={(event) => {
                  updateSchedule(schedule.id, {
                    kind: event.target.value as CandidateScheduleDraft["kind"],
                  });
                }}
                value={schedule.kind}
              >
                <option value="weekly">每周一次</option>
                <option value="short_term">短期营／集中上课</option>
              </select>
            </label>
            <label>
              偏好顺序
              <input
                min="1"
                onChange={(event) => {
                  updateSchedule(schedule.id, { preferenceRank: Number(event.target.value) });
                }}
                required
                type="number"
                value={schedule.preferenceRank}
              />
              <small>1 表示最优先。</small>
            </label>
          </div>
          {schedule.kind === "weekly" && (
            <div className="schedule-generator">
              <strong>快速生成每周课次</strong>
              <div className="availability-row">
                <label>
                  星期
                  <select
                    onChange={(event) => {
                      updateSchedule(schedule.id, { weekday: Number(event.target.value) });
                    }}
                    value={schedule.weekday}
                  >
                    {WEEKDAYS.map(([value, name]) => (
                      <option key={value} value={value}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  开始
                  <input
                    onChange={(event) => {
                      updateSchedule(schedule.id, { startTime: event.target.value });
                    }}
                    type="time"
                    value={schedule.startTime}
                  />
                </label>
                <label>
                  结束
                  <input
                    onChange={(event) => {
                      updateSchedule(schedule.id, { endTime: event.target.value });
                    }}
                    type="time"
                    value={schedule.endTime}
                  />
                </label>
                <button
                  className="secondary-action"
                  disabled={!classStartDate || !classEndDate}
                  onClick={() => {
                    const generated = generateWeeklyOccurrences({
                      endDate: classEndDate,
                      endTime: schedule.endTime,
                      startDate: classStartDate,
                      startTime: schedule.startTime,
                      weekday: schedule.weekday,
                    }).map((occurrence) => ({ ...occurrence, id: nextId("occurrence") }));
                    if (generated.length > 0)
                      updateSchedule(schedule.id, { occurrences: generated });
                  }}
                  type="button"
                >
                  按班级日期生成
                </button>
              </div>
            </div>
          )}
          <div className="occurrence-list">
            <strong>全部课次（共 {schedule.occurrences.length} 次）</strong>
            {schedule.occurrences.map((occurrence, occurrenceIndex) => (
              <div className="occurrence-row" key={occurrence.id}>
                <span>第 {occurrenceIndex + 1} 次</span>
                <label>
                  日期
                  <input
                    max={classEndDate || undefined}
                    min={classStartDate || undefined}
                    onChange={(event) => {
                      updateOccurrence(schedule.id, occurrence.id, {
                        sessionDate: event.target.value,
                      });
                    }}
                    required
                    type="date"
                    value={occurrence.sessionDate}
                  />
                </label>
                <label>
                  开始
                  <input
                    onChange={(event) => {
                      updateOccurrence(schedule.id, occurrence.id, {
                        startTime: event.target.value,
                      });
                    }}
                    required
                    type="time"
                    value={occurrence.startTime}
                  />
                </label>
                <label>
                  结束
                  <input
                    onChange={(event) => {
                      updateOccurrence(schedule.id, occurrence.id, {
                        endTime: event.target.value,
                      });
                    }}
                    required
                    type="time"
                    value={occurrence.endTime}
                  />
                </label>
                <button
                  className="remove-row-button"
                  disabled={schedule.occurrences.length === 1}
                  onClick={() => {
                    updateSchedule(schedule.id, {
                      occurrences: schedule.occurrences.filter((item) => item.id !== occurrence.id),
                    });
                  }}
                  type="button"
                >
                  删除
                </button>
              </div>
            ))}
            <button
              className="secondary-action add-row-button"
              onClick={() => {
                updateSchedule(schedule.id, {
                  occurrences: [...schedule.occurrences, newOccurrence()],
                });
              }}
              type="button"
            >
              ＋ 添加单次课程
            </button>
          </div>
        </section>
      ))}
      <button
        className="secondary-action add-row-button"
        onClick={() => {
          onChange([...schedules, newCandidateSchedule()]);
        }}
        type="button"
      >
        ＋ 添加另一套完整方案
      </button>
    </fieldset>
  );
}

function OfferingForm({
  catalog,
  onSave,
  suggestions,
}: Readonly<{ catalog: Catalog; onSave: SaveConfiguration; suggestions: string[] }>): JSX.Element {
  const approvedLocations = catalog.locations.filter((item) => item.status === "approved");
  const approvedTeachers = catalog.teachers.filter((item) => item.status === "approved");
  const [allowedTeacherIds, setAllowedTeacherIds] = useState<string[]>([]);
  const [className, setClassName] = useState("");
  const [code, setCode] = useState("");
  const [courseVersionId, setCourseVersionId] = useState("");
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState("");
  const [locationVersionId, setLocationVersionId] = useState("");
  const [requiredQualificationTags, setRequiredQualificationTags] = useState<string[]>([]);
  const [rosterText, setRosterText] = useState("");
  const [schedules, setSchedules] = useState<CandidateScheduleDraft[]>([newCandidateSchedule()]);
  const [startDate, setStartDate] = useState("");

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (!courseVersionId) throw new Error("请选择课程模板。");
      if (!locationVersionId) throw new Error("请选择班级的固定上课地点。");
      if (requiredQualificationTags.length === 0) throw new Error("请至少添加一项教师资质要求。");
      if (endDate < startDate) throw new Error("结束日期不能早于开始日期。");
      const candidateSchedules = schedules.map((schedule) => {
        if (!schedule.label.trim()) throw new Error("请填写每套候选课表的名称。");
        return {
          kind: schedule.kind,
          label: schedule.label.trim(),
          occurrences: schedule.occurrences.map((occurrence) => {
            const startMinute = timeToMinutes(occurrence.startTime);
            const endMinute = timeToMinutes(occurrence.endTime);
            if (
              !occurrence.sessionDate ||
              !Number.isFinite(startMinute) ||
              !Number.isFinite(endMinute) ||
              endMinute <= startMinute
            ) {
              throw new Error(`请检查“${schedule.label}”中的日期和上下课时间。`);
            }
            return { endMinute, sessionDate: occurrence.sessionDate, startMinute };
          }),
          preferenceRank: schedule.preferenceRank,
        };
      });
      await onSave("create_offering", {
        code: normalizeStableCode(code),
        content: {
          allowedTeacherIds,
          candidateSchedules,
          className: className.trim(),
          courseVersionId,
          endDate,
          locationVersionId,
          priority: Number(form.get("priority")),
          requiredQualificationTags,
          startDate,
          studentRosterText: uniqueNonEmptyLines(rosterText),
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请检查班级信息。");
    }
  }

  const unavailableReason =
    catalog.courses.length === 0
      ? "请先在课程目录中批准至少一个课程模板。"
      : approvedLocations.length === 0
        ? "请先新增并批准至少一个上课地点。"
        : null;

  return (
    <form className="scheduling-form" onSubmit={(event) => void submit(event)}>
      {unavailableReason && (
        <p className="form-message error">
          {unavailableReason}{" "}
          {catalog.courses.length === 0 && <Link href="/courses">前往课程模板管理 →</Link>}
        </p>
      )}
      <div className="form-grid-two">
        <label>
          班级编号
          <input
            onBlur={() => {
              setCode(normalizeStableCode(code));
            }}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            placeholder="例如 USACO_SILVER_FALL_A"
            required
            value={code}
          />
        </label>
        <label>
          班级名称
          <input
            onChange={(event) => {
              setClassName(event.target.value);
            }}
            placeholder="例如 2026 秋季 USACO Silver A 班"
            required
            value={className}
          />
        </label>
        <label>
          课程模板
          <select
            onChange={(event) => {
              setCourseVersionId(event.target.value);
            }}
            required
            value={courseVersionId}
          >
            <option value="">请选择已批准课程</option>
            {catalog.courses.map((course) => (
              <option key={course.courseVersionId} value={course.courseVersionId}>
                {course.code} · {course.content.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          固定上课地点
          <select
            onChange={(event) => {
              setLocationVersionId(event.target.value);
            }}
            required
            value={locationVersionId}
          >
            <option value="">请选择已批准地点</option>
            {approvedLocations.map((location) => (
              <option key={location.versionId} value={location.versionId}>
                {location.code} · {location.content.name}
              </option>
            ))}
          </select>
          <small>地点在排课前固定，求解器不会更换地点。</small>
        </label>
        <label>
          开始日期
          <input
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
            required
            type="date"
            value={startDate}
          />
        </label>
        <label>
          结束日期
          <input
            min={startDate || undefined}
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
            required
            type="date"
            value={endDate}
          />
        </label>
        <label>
          排课优先级
          <input defaultValue="100" max="1000" min="1" name="priority" required type="number" />
          <small>数字越大，无法全部排入时越优先保留。</small>
        </label>
      </div>
      <TagEditor
        hint="求解器只会选择同时具备这些能力的教师。"
        label="教师资质要求"
        onChange={setRequiredQualificationTags}
        suggestions={suggestions}
        values={requiredQualificationTags}
      />
      <fieldset>
        <legend>可选教师范围</legend>
        <p className="field-hint">不勾选表示所有资质合格的已批准教师都可以参与排课。</p>
        <div className="teacher-choice-grid">
          {approvedTeachers.length === 0 && <span className="empty-inline">尚无已批准教师</span>}
          {approvedTeachers.map((teacher) => (
            <label className="choice-card" key={teacher.teacherId}>
              <input
                checked={allowedTeacherIds.includes(teacher.teacherId)}
                onChange={(event) => {
                  setAllowedTeacherIds(
                    event.target.checked
                      ? [...allowedTeacherIds, teacher.teacherId]
                      : allowedTeacherIds.filter((id) => id !== teacher.teacherId),
                  );
                }}
                type="checkbox"
              />
              <span>
                <strong>{teacher.content.name}</strong>
                <small>{teacher.content.qualificationTags.join("、")}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        学生名单（仅用于人工查看）
        <textarea
          onChange={(event) => {
            setRosterText(event.target.value);
          }}
          placeholder="每行一名学生；当前不会自动分班，也不会用该名单判断冲突。"
          rows={5}
          value={rosterText}
        />
      </label>
      <CandidateSchedulesEditor
        classEndDate={endDate}
        classStartDate={startDate}
        onChange={setSchedules}
        schedules={schedules}
      />
      {error && <p className="form-message error">{error}</p>}
      <button className="submit-configuration" disabled={unavailableReason !== null} type="submit">
        保存班级与候选课表草稿
      </button>
    </form>
  );
}

const STATUS_LABELS: Record<string, string> = {
  approved: "已批准",
  archived: "已归档",
  draft: "草稿",
  failed: "失败",
  infeasible: "无可行方案",
  partially_solved: "部分排入",
  solved: "已求解",
  solving: "求解中",
};

export function SchedulingCatalog(): JSX.Element {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [kind, setKind] = useState<ConfigurationAction>("create_teacher");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/scheduling", { cache: "no-store" });
    if (response.ok) setCatalog((await response.json()) as Catalog);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tagSuggestions = useMemo(() => {
    if (catalog === null) return [];
    return [
      ...new Set([
        ...catalog.teachers.flatMap((teacher) => teacher.content.qualificationTags),
        ...catalog.courses.flatMap((course) => {
          const content = course.content as { capabilityTags?: string[]; subjectTags?: string[] };
          return [...(content.capabilityTags ?? []), ...(content.subjectTags ?? [])];
        }),
      ]),
    ].sort();
  }, [catalog]);

  const saveConfiguration: SaveConfiguration = async (action, input) => {
    setPending(true);
    setMessage("正在保存草稿……");
    try {
      const response = await fetch("/api/scheduling", {
        body: JSON.stringify({ action, input }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setMessage(
        response.ok
          ? "草稿已保存，可在右侧检查后批准。"
          : (body.message ?? "保存失败，请检查表单。"),
      );
      if (response.ok) await refresh();
      return response.ok;
    } finally {
      setPending(false);
    }
  };

  async function timetableAction(
    action: "approve_timetable" | "solve_timetable",
    runId?: string,
  ): Promise<void> {
    setPending(true);
    setMessage(action === "solve_timetable" ? "排课任务已提交……" : "正在批准课表……");
    try {
      const response = await fetch("/api/scheduling", {
        body: JSON.stringify({ action, ...(runId === undefined ? {} : { runId }) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setMessage(
        response.ok
          ? action === "solve_timetable"
            ? "Worker 正在使用 HiGHS 求解，页面稍后会刷新结果。"
            : "课表已批准。"
          : (body.message ?? "操作失败。"),
      );
      if (response.ok) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await refresh();
      }
    } finally {
      setPending(false);
    }
  }

  async function approveResource(
    resourceKind: "location" | "offering" | "teacher",
    versionId: string,
    updatedAt: string,
  ): Promise<void> {
    setPending(true);
    try {
      const response = await fetch("/api/scheduling", {
        body: JSON.stringify({
          action: "transition",
          input: { action: "approve", expectedUpdatedAt: updatedAt },
          kind: resourceKind,
          versionId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setMessage(response.ok ? "配置已批准。" : "批准失败，请刷新后重试。");
      await refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`scheduling-workspace${pending ? " is-pending" : ""}`}>
      <section className="editor-panel scheduling-create-panel">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Step 1 · Create draft</p>
            <h2>新增配置草稿</h2>
          </div>
          <label className="configuration-kind-selector">
            要配置什么？
            <select
              onChange={(event) => {
                setKind(event.target.value as ConfigurationAction);
              }}
              value={kind}
            >
              <option value="create_teacher">教师</option>
              <option value="create_location">地点</option>
              <option value="create_offering">实际班级与候选课表</option>
            </select>
          </label>
        </div>
        {kind === "create_teacher" && (
          <TeacherForm onSave={saveConfiguration} suggestions={tagSuggestions} />
        )}
        {kind === "create_location" && <LocationForm onSave={saveConfiguration} />}
        {kind === "create_offering" && catalog !== null && (
          <OfferingForm catalog={catalog} onSave={saveConfiguration} suggestions={tagSuggestions} />
        )}
        {catalog === null && <p className="status-note">正在读取课程与排课配置……</p>}
        {message && (
          <p className="status-note" role="status">
            {message}
          </p>
        )}
      </section>

      <section className="editor-panel scheduling-summary-panel">
        <div>
          <p className="eyebrow">Step 2 · Review and approve</p>
          <h2>当前配置</h2>
          <p>先批准教师、地点和班级草稿，再运行排课。教师由求解器分配，班级地点保持固定。</p>
        </div>
        <div className="catalog-summary-grid">
          <section>
            <h3>教师</h3>
            {catalog?.teachers.length === 0 && <p className="empty-inline">尚无教师</p>}
            <ul className="configuration-list">
              {catalog?.teachers.map((item) => (
                <li key={item.versionId}>
                  <div>
                    <strong>{item.content.name}</strong>
                    <small>
                      {item.code} · {STATUS_LABELS[item.status] ?? item.status}
                    </small>
                  </div>
                  <span>{item.content.qualificationTags.join("、")}</span>
                  {item.status === "draft" && (
                    <button
                      onClick={() =>
                        void approveResource("teacher", item.versionId, item.updatedAt)
                      }
                      type="button"
                    >
                      批准
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>地点</h3>
            {catalog?.locations.length === 0 && <p className="empty-inline">尚无地点</p>}
            <ul className="configuration-list">
              {catalog?.locations.map((item) => (
                <li key={item.versionId}>
                  <div>
                    <strong>{item.content.name}</strong>
                    <small>
                      {item.code} · {STATUS_LABELS[item.status] ?? item.status}
                    </small>
                  </div>
                  {item.status === "draft" && (
                    <button
                      onClick={() =>
                        void approveResource("location", item.versionId, item.updatedAt)
                      }
                      type="button"
                    >
                      批准
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>实际班级</h3>
            {catalog?.offerings.length === 0 && <p className="empty-inline">尚无班级</p>}
            <ul className="configuration-list">
              {catalog?.offerings.map((item) => (
                <li key={item.versionId}>
                  <div>
                    <strong>{item.content.className}</strong>
                    <small>
                      {item.code} · {STATUS_LABELS[item.status] ?? item.status}
                    </small>
                  </div>
                  <span>
                    {item.content.candidateSchedules.length} 套课表 · 名单{" "}
                    {item.content.studentRosterText.length} 人
                  </span>
                  {item.status === "draft" && (
                    <button
                      onClick={() =>
                        void approveResource("offering", item.versionId, item.updatedAt)
                      }
                      type="button"
                    >
                      批准
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <section className="timetable-run-panel">
          <div className="section-heading-row">
            <div>
              <h3>整数规划排课</h3>
              <p>从每个班级的完整候选课表中选一套，并分配合格教师。</p>
            </div>
            <button
              disabled={pending}
              onClick={() => void timetableAction("solve_timetable")}
              type="button"
            >
              开始排课
            </button>
          </div>
          <ul className="configuration-list">
            {catalog?.timetableRuns.map((run) => (
              <li key={run.id}>
                <div>
                  <strong>{new Date(run.createdAt).toLocaleString("zh-CN")}</strong>
                  <small>
                    {STATUS_LABELS[run.status] ?? run.status} · {run.runtimeMs ?? "—"} ms · 已排{" "}
                    {run.output?.assignments?.length ?? 0} 班
                  </small>
                </div>
                {run.output?.unassigned?.map((item) => (
                  <p key={item.offeringId}>{item.reason}</p>
                ))}
                {(run.status === "solved" || run.status === "partially_solved") && (
                  <button
                    onClick={() => void timetableAction("approve_timetable", run.id)}
                    type="button"
                  >
                    批准为正式课表
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </section>
    </div>
  );
}
