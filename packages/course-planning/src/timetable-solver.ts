import highsLoader from "highs";

import {
  TimetableInputSchema,
  type TimetableInput,
  type TimetableSolveResult,
} from "./timetable-contracts.js";

interface Combination {
  candidate: TimetableInput["offerings"][number]["candidates"][number];
  index: number;
  offering: TimetableInput["offerings"][number];
  teacher: TimetableInput["teachers"][number];
  variable: string;
}
interface SolverColumn {
  Primal: number;
}
interface SolverResult {
  Columns?: Record<string, SolverColumn>;
  ObjectiveValue?: number;
  Status: string;
}
interface Solver {
  solve(problem: string, options?: Record<string, unknown>): SolverResult;
}

function weekday(value: string): number {
  const day = new Date(`${value}T12:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
function duration(occurrence: { startMinute: number; endMinute: number }): number {
  return occurrence.endMinute - occurrence.startMinute;
}
function contains(
  windows: Array<{ weekday: number; startMinute: number; endMinute: number }>,
  occurrence: { sessionDate: string; startMinute: number; endMinute: number },
): boolean {
  const day = weekday(occurrence.sessionDate);
  return windows.some(
    (window) =>
      window.weekday === day &&
      window.startMinute <= occurrence.startMinute &&
      window.endMinute >= occurrence.endMinute,
  );
}
function overlap(
  left: { sessionDate: string; startMinute: number; endMinute: number },
  right: { sessionDate: string; startMinute: number; endMinute: number },
): boolean {
  return (
    left.sessionDate === right.sessionDate &&
    left.startMinute < right.endMinute &&
    right.startMinute < left.endMinute
  );
}
function schedulesOverlap(left: Combination, right: Combination): boolean {
  return left.candidate.occurrences.some((first) =>
    right.candidate.occurrences.some((second) => overlap(first, second)),
  );
}
function mondayKey(dateValue: string): string {
  const date = new Date(`${dateValue}T12:00:00.000Z`);
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}
function coefficient(value: number, variable: string): string {
  return `${value >= 0 ? "+" : "-"} ${String(Math.abs(value))} ${variable}`;
}
function constraint(
  name: string,
  terms: Array<[number, string]>,
  relation: "<=" | ">=" | "=",
  rhs: number,
): string {
  return ` ${name}: ${terms.map(([value, variable]) => coefficient(value, variable)).join(" ")} ${relation} ${String(rhs)}`;
}

function validCombination(
  offering: TimetableInput["offerings"][number],
  candidate: TimetableInput["offerings"][number]["candidates"][number],
  teacher: TimetableInput["teachers"][number],
  location: TimetableInput["locations"][number],
): boolean {
  if (offering.allowedTeacherIds.length > 0 && !offering.allowedTeacherIds.includes(teacher.id))
    return false;
  if (offering.lockedTeacherId !== null && offering.lockedTeacherId !== teacher.id) return false;
  if (offering.lockedCandidateId !== null && offering.lockedCandidateId !== candidate.id)
    return false;
  if (!offering.requiredQualificationTags.every((tag) => teacher.qualificationTags.includes(tag)))
    return false;
  const daily = new Map<string, number>();
  const weekly = new Map<string, number>();
  for (const occurrence of candidate.occurrences) {
    if (occurrence.sessionDate < offering.startDate || occurrence.sessionDate > offering.endDate)
      return false;
    if (
      teacher.unavailableDates.includes(occurrence.sessionDate) ||
      location.unavailableDates.includes(occurrence.sessionDate)
    )
      return false;
    if (
      !contains(teacher.weeklyAvailability, occurrence) ||
      !contains(location.weeklyAvailability, occurrence)
    )
      return false;
    daily.set(
      occurrence.sessionDate,
      (daily.get(occurrence.sessionDate) ?? 0) + duration(occurrence),
    );
    const week = mondayKey(occurrence.sessionDate);
    weekly.set(week, (weekly.get(week) ?? 0) + duration(occurrence));
  }
  return (
    [...daily.values()].every((value) => value <= teacher.maxDailyMinutes) &&
    [...weekly.values()].every((value) => value <= teacher.maxWeeklyMinutes)
  );
}

export function buildTimetableModel(rawInput: unknown): {
  combinations: Combination[];
  lp: string;
} {
  const input = TimetableInputSchema.parse(rawInput);
  const locations = new Map(input.locations.map((location) => [location.id, location]));
  const combinations: Combination[] = [];
  for (const offering of input.offerings) {
    const location = locations.get(offering.locationId);
    if (location === undefined) continue;
    for (const teacher of input.teachers) {
      for (const candidate of offering.candidates) {
        if (validCombination(offering, candidate, teacher, location)) {
          const index = combinations.length;
          combinations.push({ candidate, index, offering, teacher, variable: `x${String(index)}` });
        }
      }
    }
  }
  const objective: Array<[number, string]> = combinations.map((combo) => {
    const teacherPenalty = combo.teacher.preferredTags.some((tag) =>
      combo.offering.requiredQualificationTags.includes(tag),
    )
      ? 0
      : 1;
    const stablePenalty = combo.index + 1;
    return [
      combo.offering.priority * 1_000_000_000 -
        combo.candidate.preferenceRank * 1_000_000 -
        teacherPenalty * 1_000 -
        stablePenalty,
      combo.variable,
    ];
  });
  const constraints: string[] = [];
  const gapVariables: string[] = [];
  for (const [offeringIndex, offering] of input.offerings.entries()) {
    const relevant = combinations.filter((combo) => combo.offering.id === offering.id);
    if (relevant.length > 0)
      constraints.push(
        constraint(
          `class_${String(offeringIndex)}`,
          relevant.map((combo) => [1, combo.variable]),
          offering.lockedCandidateId !== null || offering.lockedTeacherId !== null ? "=" : "<=",
          1,
        ),
      );
  }
  let conflictIndex = 0;
  let gapIndex = 0;
  for (let leftIndex = 0; leftIndex < combinations.length; leftIndex += 1) {
    const left = combinations[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < combinations.length; rightIndex += 1) {
      const right = combinations[rightIndex];
      if (
        right === undefined ||
        left.offering.id === right.offering.id ||
        !schedulesOverlap(left, right)
      )
        continue;
      if (
        left.teacher.id === right.teacher.id ||
        left.offering.locationId === right.offering.locationId
      ) {
        constraints.push(
          constraint(
            `conflict_${String(conflictIndex++)}`,
            [
              [1, left.variable],
              [1, right.variable],
            ],
            "<=",
            1,
          ),
        );
      }
    }
  }
  for (let leftIndex = 0; leftIndex < combinations.length; leftIndex += 1) {
    const left = combinations[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < combinations.length; rightIndex += 1) {
      const right = combinations[rightIndex];
      if (
        right === undefined ||
        left.offering.id === right.offering.id ||
        left.teacher.id !== right.teacher.id ||
        schedulesOverlap(left, right)
      )
        continue;
      const gaps = left.candidate.occurrences
        .flatMap((first) =>
          right.candidate.occurrences
            .filter((second) => second.sessionDate === first.sessionDate)
            .map((second) =>
              Math.max(
                second.startMinute - first.endMinute,
                first.startMinute - second.endMinute,
                0,
              ),
            ),
        )
        .filter((gap) => gap > 0);
      if (gaps.length === 0) continue;
      const variable = `g${String(gapIndex)}`;
      gapIndex += 1;
      gapVariables.push(variable);
      objective.push([-Math.min(...gaps), variable]);
      constraints.push(
        constraint(
          `gap_${String(gapIndex)}`,
          [
            [1, variable],
            [-1, left.variable],
            [-1, right.variable],
          ],
          ">=",
          -1,
        ),
      );
    }
  }
  for (const [teacherIndex, teacher] of input.teachers.entries()) {
    const relevant = combinations.filter((combo) => combo.teacher.id === teacher.id);
    const dates = new Set(
      relevant.flatMap((combo) => combo.candidate.occurrences.map((item) => item.sessionDate)),
    );
    for (const date of dates) {
      const terms = relevant
        .map(
          (combo) =>
            [
              combo.candidate.occurrences
                .filter((item) => item.sessionDate === date)
                .reduce((sum, item) => sum + duration(item), 0),
              combo.variable,
            ] as [number, string],
        )
        .filter(([minutes]) => minutes > 0);
      constraints.push(
        constraint(
          `daily_${String(teacherIndex)}_${date.replaceAll("-", "")}`,
          terms,
          "<=",
          teacher.maxDailyMinutes,
        ),
      );
    }
    const weeks = new Set(
      relevant.flatMap((combo) =>
        combo.candidate.occurrences.map((item) => mondayKey(item.sessionDate)),
      ),
    );
    for (const week of weeks) {
      const terms = relevant
        .map(
          (combo) =>
            [
              combo.candidate.occurrences
                .filter((item) => mondayKey(item.sessionDate) === week)
                .reduce((sum, item) => sum + duration(item), 0),
              combo.variable,
            ] as [number, string],
        )
        .filter(([minutes]) => minutes > 0);
      constraints.push(
        constraint(
          `weekly_${String(teacherIndex)}_${week.replaceAll("-", "")}`,
          terms,
          "<=",
          teacher.maxWeeklyMinutes,
        ),
      );
    }
  }
  const variables = [...combinations.map((combo) => combo.variable), ...gapVariables];
  const lp = [
    `Maximize`,
    ` objective: ${objective.map(([value, variable]) => coefficient(value, variable)).join(" ") || "0 empty"}`,
    `Subject To`,
    ...(constraints.length > 0 ? constraints : [" empty_constraint: 0 empty <= 0"]),
    `Bounds`,
    ...(variables.length > 0
      ? variables.map((variable) => ` 0 <= ${variable} <= 1`)
      : [" 0 <= empty <= 0"]),
    `Binary`,
    ...(variables.length > 0 ? variables.map((variable) => ` ${variable}`) : []),
    `End`,
  ].join("\n");
  return { combinations, lp };
}

export async function solveTimetable(
  rawInput: unknown,
  injectedSolver?: Solver,
): Promise<TimetableSolveResult> {
  const input = TimetableInputSchema.parse(rawInput);
  const { combinations, lp } = buildTimetableModel(input);
  if (combinations.length === 0)
    return {
      assignments: [],
      objectiveValue: 0,
      solverStatus: "No valid variables",
      status: "infeasible",
      unassigned: input.offerings.map((offering) => ({
        offeringId: offering.id,
        reason: "没有同时满足教师资质、教师/地点可用时间与完整候选课表的组合。",
      })),
    };
  const solver = injectedSolver ?? (await highsLoader());
  const solution = solver.solve(lp, {
    mip_rel_gap: 0,
    presolve: "on",
    time_limit: input.timeLimitSeconds,
  });
  if (solution.Status !== "Optimal" && solution.Status !== "Time limit reached")
    return {
      assignments: [],
      objectiveValue: solution.ObjectiveValue ?? 0,
      solverStatus: solution.Status,
      status: solution.Status.includes("Infeasible") ? "infeasible" : "failed",
      unassigned: input.offerings.map((offering) => ({
        offeringId: offering.id,
        reason: "求解器未找到可审核方案。",
      })),
    };
  const selected = combinations.filter(
    (combo) => (solution.Columns?.[combo.variable]?.Primal ?? 0) > 0.5,
  );
  const assignedIds = new Set(selected.map((combo) => combo.offering.id));
  return {
    assignments: selected.map((combo) => ({
      candidateId: combo.candidate.id,
      offeringId: combo.offering.id,
      occurrences: combo.candidate.occurrences,
      teacherId: combo.teacher.id,
    })),
    objectiveValue: solution.ObjectiveValue ?? 0,
    solverStatus: solution.Status,
    status: assignedIds.size === input.offerings.length ? "solved" : "partially_solved",
    unassigned: input.offerings
      .filter((offering) => !assignedIds.has(offering.id))
      .map((offering) => ({
        offeringId: offering.id,
        reason: combinations.some((combo) => combo.offering.id === offering.id)
          ? "与更高优先级班级的教师或固定地点发生冲突。"
          : "没有合法的教师与完整候选课表组合。",
      })),
  };
}

export async function checkHighsRuntime(): Promise<{ available: true; version: "1.15.2" }> {
  const solver = await highsLoader();
  const solution = solver.solve(
    "Maximize\n objective: + 1 x\nSubject To\n c: + 1 x <= 1\nBounds\n 0 <= x <= 1\nBinary\n x\nEnd",
  );
  if (solution.Status !== "Optimal") throw new Error("HiGHS startup self-check failed.");
  return { available: true, version: "1.15.2" };
}
