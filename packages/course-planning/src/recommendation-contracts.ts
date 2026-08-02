import { createHash } from "node:crypto";

import { z } from "zod";

export const COURSE_RECOMMENDATION_MODEL = "deepseek-v4-flash";
export const COURSE_RECOMMENDATION_PROMPT_VERSION = "course-recommendation.v1";
export const COURSE_RECOMMENDATION_SCHEMA_VERSION = "course-recommendation-output.v1";
export const COURSE_RECOMMENDATION_REDACTION_VERSION = "course-recommendation-outbound.v1";
export const COURSE_RECOMMENDATION_PRICING_VERSION = "deepseek-v4-flash-cny-2026-08-02";

const RecommendationItemSchema = z
  .object({
    claimIds: z.array(z.uuid()).min(1).max(20),
    courseVersionId: z.uuid(),
    expectedOutcome: z.string().trim().min(1).max(1000),
    knowledgeLink: z.string().trim().min(1).max(1000),
    offeringVersionIds: z.array(z.uuid()).max(20),
    rationale: z.string().trim().min(1).max(1600),
    risk: z.string().trim().min(1).max(1000),
  })
  .strict();

export const CourseRecommendationOutputSchema = z
  .object({
    alternative: RecommendationItemSchema,
    recommendations: z.array(RecommendationItemSchema).min(1).max(3),
  })
  .strict();
export type CourseRecommendationOutput = z.infer<typeof CourseRecommendationOutputSchema>;

export const CourseRecommendationSnapshotPayloadSchema = z
  .object({
    claims: z.array(
      z
        .object({
          id: z.uuid(),
          category: z.string().min(1),
          statement: z.string().min(1).max(1200),
        })
        .strict(),
    ),
    courses: z
      .array(
        z
          .object({
            courseId: z.uuid(),
            courseVersionId: z.uuid(),
            title: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1),
    offerings: z.array(
      z
        .object({
          className: z.string().min(1).max(200),
          courseVersionId: z.uuid(),
          offeringVersionId: z.uuid(),
        })
        .strict(),
    ),
  })
  .strict();
export type CourseRecommendationSnapshotPayload = z.infer<
  typeof CourseRecommendationSnapshotPayloadSchema
>;

export const COURSE_RECOMMENDATION_SYSTEM_PROMPT = `你是内部课程顾问辅助工具。只从输入给出的课程版本、班级版本和画像 claim ID 中选择，不得创造任何 ID、课程、班级或学生事实。输出严格 JSON：recommendations 为 1 至 3 项，alternative 为 1 项。每项包含 courseVersionId、offeringVersionIds、claimIds、rationale、knowledgeLink、expectedOutcome、risk。没有可选班级时 offeringVersionIds 使用空数组，并在理由中明确当前无可选班级。所有理由都必须基于输入画像结论，输出只是待人工审核草稿。`;

export function stableRecommendationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRecommendationJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableRecommendationJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function recommendationHash(value: unknown): string {
  return createHash("sha256").update(stableRecommendationJson(value), "utf8").digest("hex");
}

export const COURSE_RECOMMENDATION_PROMPT_HASH = recommendationHash(
  COURSE_RECOMMENDATION_SYSTEM_PROMPT,
);
export const COURSE_RECOMMENDATION_SCHEMA_HASH = recommendationHash(
  CourseRecommendationOutputSchema.toJSONSchema(),
);

export function buildRecommendationUserPrompt(
  payload: CourseRecommendationSnapshotPayload,
): string {
  return `以下是确定性规则筛选后的唯一合法候选集合。请生成课程推荐草稿：\n${stableRecommendationJson(payload)}`;
}

export function validateRecommendationOutput(
  raw: unknown,
  payload: CourseRecommendationSnapshotPayload,
): CourseRecommendationOutput {
  const output = CourseRecommendationOutputSchema.parse(raw);
  const courseIds = new Set(payload.courses.map((item) => item.courseVersionId));
  const offeringIds = new Set(payload.offerings.map((item) => item.offeringVersionId));
  const claimIds = new Set(payload.claims.map((item) => item.id));
  const all = [...output.recommendations, output.alternative];
  for (const item of all) {
    if (!courseIds.has(item.courseVersionId))
      throw new Error("Model returned an ineligible course ID.");
    if (item.offeringVersionIds.some((id) => !offeringIds.has(id)))
      throw new Error("Model returned an ineligible class ID.");
    if (item.claimIds.some((id) => !claimIds.has(id)))
      throw new Error("Model returned an out-of-snapshot claim ID.");
    if (
      item.offeringVersionIds.some(
        (id) =>
          payload.offerings.find((offering) => offering.offeringVersionId === id)
            ?.courseVersionId !== item.courseVersionId,
      )
    ) {
      throw new Error("Model linked a class to the wrong course.");
    }
  }
  return output;
}
