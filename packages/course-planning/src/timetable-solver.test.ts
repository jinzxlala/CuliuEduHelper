import { describe, expect, it } from "vitest";

import { checkHighsRuntime, solveTimetable } from "./timetable-solver.js";
import type { TimetableInput } from "./timetable-contracts.js";

const teacherA = "00000000-0000-4000-8000-000000000001";
const teacherB = "00000000-0000-4000-8000-000000000002";
const location = "00000000-0000-4000-8000-000000000003";
const offeringA = "00000000-0000-4000-8000-000000000004";
const offeringB = "00000000-0000-4000-8000-000000000005";
const candidateA = "00000000-0000-4000-8000-000000000006";
const candidateB = "00000000-0000-4000-8000-000000000007";

function input(): TimetableInput {
  return {
    locations: [
      {
        id: location,
        unavailableDates: [],
        weeklyAvailability: [{ endMinute: 1200, startMinute: 480, weekday: 6 }],
      },
    ],
    offerings: [
      {
        allowedTeacherIds: [],
        candidates: [
          {
            id: candidateA,
            label: "A 完整方案",
            occurrences: [{ endMinute: 660, sessionDate: "2026-09-05", startMinute: 540 }],
            preferenceRank: 1,
          },
        ],
        className: "A 班",
        endDate: "2026-09-05",
        id: offeringA,
        locationId: location,
        lockedCandidateId: null,
        lockedTeacherId: null,
        priority: 100,
        requiredQualificationTags: ["programming"],
        startDate: "2026-09-05",
      },
      {
        allowedTeacherIds: [],
        candidates: [
          {
            id: candidateB,
            label: "B 完整方案",
            occurrences: [{ endMinute: 660, sessionDate: "2026-09-05", startMinute: 540 }],
            preferenceRank: 1,
          },
        ],
        className: "B 班",
        endDate: "2026-09-05",
        id: offeringB,
        locationId: location,
        lockedCandidateId: null,
        lockedTeacherId: null,
        priority: 10,
        requiredQualificationTags: ["programming"],
        startDate: "2026-09-05",
      },
    ],
    teachers: [
      {
        id: teacherA,
        maxDailyMinutes: 480,
        maxWeeklyMinutes: 1200,
        preferredTags: ["programming"],
        qualificationTags: ["programming"],
        unavailableDates: [],
        weeklyAvailability: [{ endMinute: 1200, startMinute: 480, weekday: 6 }],
      },
      {
        id: teacherB,
        maxDailyMinutes: 480,
        maxWeeklyMinutes: 1200,
        preferredTags: [],
        qualificationTags: ["art"],
        unavailableDates: [],
        weeklyAvailability: [{ endMinute: 1200, startMinute: 480, weekday: 6 }],
      },
    ],
    timeLimitSeconds: 5,
  };
}

describe("HiGHS class-teacher-candidate timetable solver", () => {
  it("loads the pinned WASM runtime", async () => {
    await expect(checkHighsRuntime()).resolves.toEqual({ available: true, version: "1.15.2" });
  });

  it("assigns a qualified teacher and prioritizes one class when the fixed location overlaps", async () => {
    const result = await solveTimetable(input());
    expect(result.status).toBe("partially_solved");
    expect(result.assignments).toEqual([
      expect.objectContaining({
        candidateId: candidateA,
        offeringId: offeringA,
        teacherId: teacherA,
      }),
    ]);
    expect(result.unassigned[0]?.offeringId).toBe(offeringB);
    expect(result.unassigned[0]?.reason).toContain("冲突");
  });

  it("honors a locked teacher and complete candidate timetable", async () => {
    const value = input();
    const firstOffering = value.offerings[0];
    if (firstOffering === undefined) throw new Error("Missing synthetic offering.");
    value.offerings = [
      {
        ...firstOffering,
        allowedTeacherIds: [teacherA],
        lockedCandidateId: candidateA,
        lockedTeacherId: teacherA,
      },
    ];
    const result = await solveTimetable(value);
    expect(result.status).toBe("solved");
    expect(result.assignments[0]).toEqual(
      expect.objectContaining({ candidateId: candidateA, teacherId: teacherA }),
    );
  });

  it("returns a safe reason when no qualified teacher can cover a complete candidate", async () => {
    const value = input();
    const firstOffering = value.offerings[0];
    const secondTeacher = value.teachers[1];
    if (firstOffering === undefined || secondTeacher === undefined)
      throw new Error("Missing synthetic fixture.");
    value.offerings = [firstOffering];
    value.teachers = [secondTeacher];
    const result = await solveTimetable(value);
    expect(result.status).toBe("infeasible");
    expect(result.unassigned[0]?.reason).toContain("教师资质");
  });
});
