import { describe, expect, it } from "vitest";

import { OfferingContentSchema } from "./scheduling-contracts.js";

describe("scheduling contracts", () => {
  it("requires complete candidate schedules and keeps the roster as text only", () => {
    const parsed = OfferingContentSchema.parse({
      allowedTeacherIds: [],
      candidateSchedules: [
        {
          kind: "short_term",
          label: "方案 A",
          occurrences: [
            { endMinute: 660, sessionDate: "2026-09-05", startMinute: 540 },
            { endMinute: 660, sessionDate: "2026-09-06", startMinute: 540 },
          ],
          preferenceRank: 1,
        },
      ],
      className: "合成测试班",
      courseVersionId: "00000000-0000-4000-8000-000000000001",
      endDate: "2026-09-06",
      locationVersionId: "00000000-0000-4000-8000-000000000002",
      priority: 10,
      requiredQualificationTags: ["synthetic_subject"],
      startDate: "2026-09-05",
      studentRosterText: ["虚构学生甲", "虚构学生乙"],
    });
    expect(parsed.studentRosterText).toEqual(["虚构学生甲", "虚构学生乙"]);
    expect(parsed).not.toHaveProperty("teacherVersionId");
    expect(parsed.candidateSchedules[0]?.occurrences).toHaveLength(2);
  });

  it("rejects partial candidate occurrences outside the class date range", () => {
    expect(() =>
      OfferingContentSchema.parse({
        allowedTeacherIds: [],
        candidateSchedules: [
          {
            kind: "weekly",
            label: "越界方案",
            occurrences: [{ endMinute: 660, sessionDate: "2026-09-12", startMinute: 540 }],
            preferenceRank: 1,
          },
        ],
        className: "合成测试班",
        courseVersionId: "00000000-0000-4000-8000-000000000001",
        endDate: "2026-09-06",
        locationVersionId: "00000000-0000-4000-8000-000000000002",
        requiredQualificationTags: ["synthetic_subject"],
        startDate: "2026-09-05",
      }),
    ).toThrow(/inside the class date range/u);
  });
});
