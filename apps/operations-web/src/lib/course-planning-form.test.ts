import { describe, expect, it } from "vitest";

import {
  buildCreateManualPlanInput,
  createManualPlanFormState,
  type PlanningWorkspaceData,
} from "./course-planning-form";

const claimId = "00000000-0000-4000-8000-000000000010";
const profileId = "00000000-0000-4000-8000-000000000011";
const courseId = "00000000-0000-4000-8000-000000000012";
const courseVersionId = "00000000-0000-4000-8000-000000000013";

const workspace: PlanningWorkspaceData = {
  approvedProfile: {
    claims: [
      {
        category: "learning_characteristics",
        confidence: "high",
        id: claimId,
        informationNature: "fact",
        statement: "Synthetic approved observation.",
      },
    ],
    id: profileId,
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
  },
  catalog: {
    courses: [
      {
        code: "SYNTHETIC_01",
        content: {
          capabilityTags: ["synthetic_capability"],
          deliverables: ["Synthetic deliverable"],
          deliveryMode: "self_paced",
          difficulty: "foundation",
          durationWeeks: 8,
          notSuitableConditions: [],
          objectives: ["Synthetic objective"],
          projectTypes: [],
          schedule: [],
          stage: "Synthetic stage",
          subjectTags: ["synthetic_subject"],
          summary: "Synthetic course.",
          title: "Synthetic Course",
          totalInstructionMinutes: 600,
          weeklyLoadMinutes: 90,
        },
        courseId,
        courseVersionId,
        version: 1,
      },
    ],
    rules: [],
  },
  plans: [],
  studentId: "00000000-0000-4000-8000-000000000014",
};

describe("manual planning form contract", () => {
  it("creates a schema-valid two-route plan without hidden model generation", () => {
    const form = createManualPlanFormState(workspace, new Date("2026-08-02T00:00:00.000Z"));
    form.ageYears = "15";
    form.classroomFeedback = "Observed persistence in class.";
    form.classroomProfile = "Needs an observable project-based next step.";
    form.goal = "Choose a sustainable course route from observed evidence.";
    form.interestsText = "Project work";
    form.title = "Synthetic advisor-authored plan";
    form.routes[0].summary = "Test route A through a short project.";
    form.routes[1].summary = "Test route B through a structured course.";
    for (const comparison of form.routeComparison) {
      comparison.routeA = `${comparison.dimension} A`;
      comparison.routeB = `${comparison.dimension} B`;
    }
    const shortTermItem = form.shortTermItems[0];
    if (shortTermItem === undefined) throw new Error("Expected an initial short-term item.");
    form.shortTermItems[0] = {
      ...shortTermItem,
      expectedOutcome: "Complete one observable artifact.",
      reason: "The approved profile supports a short project trial.",
    };

    const input = buildCreateManualPlanInput(form, workspace);
    expect(input.content.routes.map((route) => route.key)).toEqual(["route_a", "route_b"]);
    expect(input.content.routeComparison).toHaveLength(6);
    expect(input.content.shortTermItems).toHaveLength(1);
    expect(input.sourcePlanVersionId).toBeUndefined();
    expect(input.studentInput.classroomFeedback[0]?.supportingClaimIds).toEqual([claimId]);
  });

  it("rejects an empty evidence selection before making an API request", () => {
    const form = createManualPlanFormState(workspace, new Date("2026-08-02T00:00:00.000Z"));
    form.supportingClaimIds = [];
    expect(() => buildCreateManualPlanInput(form, workspace)).toThrow();
  });
});
