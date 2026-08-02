"use client";

import { useCallback, useEffect, useState, type JSX, type SyntheticEvent } from "react";

interface Catalog {
  locations: Array<{
    code: string;
    content: { name: string };
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

const samples = {
  create_location: {
    code: "ROOM_A",
    content: {
      name: "A 教室",
      unavailableDates: [],
      weeklyAvailability: [{ endMinute: 1200, startMinute: 480, weekday: 6 }],
    },
  },
  create_offering: {
    code: "CLASS_2026_A",
    content: {
      allowedTeacherIds: [],
      candidateSchedules: [
        {
          kind: "weekly",
          label: "周六上午完整方案",
          preferenceRank: 1,
          occurrences: [{ endMinute: 660, sessionDate: "2026-09-05", startMinute: 540 }],
        },
      ],
      className: "2026 秋季 A 班",
      courseVersionId: "在此填写已批准课程版本 UUID",
      endDate: "2026-09-05",
      locationVersionId: "在此填写已批准地点版本 UUID",
      priority: 100,
      requiredQualificationTags: ["programming"],
      startDate: "2026-09-05",
      studentRosterText: [],
    },
  },
  create_teacher: {
    code: "TEACHER_A",
    content: {
      maxDailyMinutes: 480,
      maxWeeklyMinutes: 1200,
      name: "教师姓名",
      preferredTags: [],
      qualificationTags: ["programming"],
      unavailableDates: [],
      weeklyAvailability: [{ endMinute: 1200, startMinute: 480, weekday: 6 }],
    },
  },
} as const;

export function SchedulingCatalog(): JSX.Element {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [kind, setKind] = useState<keyof typeof samples>("create_teacher");
  const [json, setJson] = useState(JSON.stringify(samples.create_teacher, null, 2));
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/scheduling", { cache: "no-store" });
    if (response.ok) setCatalog((await response.json()) as Catalog);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage("正在保存……");
    let input: unknown;
    try {
      input = JSON.parse(json) as unknown;
    } catch {
      setMessage("JSON 格式不正确。");
      return;
    }
    const response = await fetch("/api/scheduling", {
      body: JSON.stringify({ action: kind, input }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    setMessage(response.ok ? "已保存为草稿。" : (body.message ?? "保存失败，请检查字段。 "));
    if (response.ok) await refresh();
  }

  async function timetableAction(
    action: "approve_timetable" | "solve_timetable",
    runId?: string,
  ): Promise<void> {
    setMessage(action === "solve_timetable" ? "排课任务已提交……" : "正在批准课表……");
    const response = await fetch("/api/scheduling", {
      body: JSON.stringify({ action, ...(runId === undefined ? {} : { runId }) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    setMessage(
      response.ok
        ? action === "solve_timetable"
          ? "Worker 正在使用 HiGHS 求解；稍后刷新结果。"
          : "课表已批准。"
        : (body.message ?? "操作失败。"),
    );
    if (response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refresh();
    }
  }

  async function approveResource(
    resourceKind: "location" | "offering" | "teacher",
    versionId: string,
    updatedAt: string,
  ): Promise<void> {
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
  }

  return (
    <div className="planning-grid">
      <section className="editor-panel">
        <h2>新增配置草稿</h2>
        <label>
          配置类型
          <select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as keyof typeof samples;
              setKind(next);
              setJson(JSON.stringify(samples[next], null, 2));
            }}
          >
            <option value="create_teacher">教师</option>
            <option value="create_location">地点</option>
            <option value="create_offering">实际班级与完整候选课表</option>
          </select>
        </label>
        <form onSubmit={(event) => void submit(event)}>
          <textarea
            aria-label="配置 JSON"
            onChange={(event) => {
              setJson(event.target.value);
            }}
            rows={24}
            value={json}
          />
          <button type="submit">保存草稿</button>
        </form>
        {message && <p className="status-note">{message}</p>}
      </section>
      <section className="editor-panel">
        <h2>当前配置</h2>
        <p>班级地点在运行前固定；教师不会写入班级草稿，由排课求解器选择。</p>
        <h3>教师</h3>
        <ul>
          {catalog?.teachers.map((item) => (
            <li key={item.versionId}>
              {item.code} · {item.content.name} · {item.status} ·{" "}
              {item.content.qualificationTags.join("、")}{" "}
              {item.status === "draft" && (
                <button
                  onClick={() => void approveResource("teacher", item.versionId, item.updatedAt)}
                  type="button"
                >
                  批准
                </button>
              )}
            </li>
          ))}
        </ul>
        <h3>地点</h3>
        <ul>
          {catalog?.locations.map((item) => (
            <li key={item.versionId}>
              {item.code} · {item.content.name} · {item.status}{" "}
              {item.status === "draft" && (
                <button
                  onClick={() => void approveResource("location", item.versionId, item.updatedAt)}
                  type="button"
                >
                  批准
                </button>
              )}
            </li>
          ))}
        </ul>
        <h3>实际班级</h3>
        <ul>
          {catalog?.offerings.map((item) => (
            <li key={item.versionId}>
              {item.code} · {item.content.className} · {item.status} ·{" "}
              {item.content.candidateSchedules.length} 套完整候选课表 · 文本名单{" "}
              {item.content.studentRosterText.length} 人{" "}
              {item.status === "draft" && (
                <button
                  onClick={() => void approveResource("offering", item.versionId, item.updatedAt)}
                  type="button"
                >
                  批准
                </button>
              )}
            </li>
          ))}
        </ul>
        <h3>整数规划排课</h3>
        <button onClick={() => void timetableAction("solve_timetable")} type="button">
          分配教师并选择完整候选课表
        </button>
        <ul>
          {catalog?.timetableRuns.map((run) => (
            <li key={run.id}>
              {new Date(run.createdAt).toLocaleString("zh-CN")} · {run.status} ·{" "}
              {run.runtimeMs ?? "—"} ms
              {run.output?.unassigned?.map((item) => (
                <p key={item.offeringId}>
                  {item.offeringId}：{item.reason}
                </p>
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
    </div>
  );
}
