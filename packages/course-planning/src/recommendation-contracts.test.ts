import { describe, expect, it } from "vitest";

import {
  type CourseRecommendationOutput,
  CourseRecommendationSnapshotPayloadSchema,
  validateRecommendationOutput,
} from "./recommendation-contracts.js";

const payload = CourseRecommendationSnapshotPayloadSchema.parse({
  claims: [
    {
      category: "interest_thread",
      id: "00000000-0000-4000-8000-000000000001",
      statement: "虚构学生对编程项目有持续兴趣。",
    },
  ],
  courses: [
    {
      courseId: "00000000-0000-4000-8000-000000000002",
      courseVersionId: "00000000-0000-4000-8000-000000000003",
      title: "虚构课程",
    },
  ],
  offerings: [
    {
      className: "虚构班级",
      courseVersionId: "00000000-0000-4000-8000-000000000003",
      offeringVersionId: "00000000-0000-4000-8000-000000000004",
    },
  ],
});
const claimId = "00000000-0000-4000-8000-000000000001";
const courseVersionId = "00000000-0000-4000-8000-000000000003";
const offeringVersionId = "00000000-0000-4000-8000-000000000004";

function item(
  selectedCourseVersionId = courseVersionId,
): CourseRecommendationOutput["recommendations"][number] {
  return {
    claimIds: [claimId],
    courseVersionId: selectedCourseVersionId,
    expectedOutcome: "完成虚构项目",
    knowledgeLink: "衔接已有兴趣",
    offeringVersionIds: [offeringVersionId],
    rationale: "依据画像中的持续兴趣",
    risk: "需关注时间投入",
  };
}

describe("course recommendation output boundary", () => {
  it("accepts only frozen course, class, and claim IDs", () => {
    const parsed = validateRecommendationOutput(
      { alternative: item(), recommendations: [item()] },
      payload,
    );
    expect(parsed.recommendations).toHaveLength(1);
  });

  it("rejects a model-created course ID", () => {
    expect(() =>
      validateRecommendationOutput(
        {
          alternative: item(),
          recommendations: [item("00000000-0000-4000-8000-000000000099")],
        },
        payload,
      ),
    ).toThrow(/ineligible course/u);
  });
});
