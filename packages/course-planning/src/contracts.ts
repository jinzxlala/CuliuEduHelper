import { z } from "zod";

const UniqueTextArraySchema = (minimum: number, maximum: number): z.ZodType<string[]> =>
  z
    .array(z.string().trim().min(1).max(200))
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "Values must be unique.");

const StableTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_.-]*$/u, "Use a stable lowercase tag.");

const UniqueTagArraySchema = (minimum: number, maximum: number): z.ZodType<string[]> =>
  z
    .array(StableTagSchema)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "Tags must be unique.");

export const CourseCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_-]+$/u);

export const CourseRuleKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]+$/u);

export const CourseCatalogStatusSchema = z.enum(["draft", "approved", "archived"]);
export const CourseDifficultySchema = z.enum(["foundation", "intermediate", "advanced"]);
export const CourseDeliveryModeSchema = z.enum(["scheduled", "self_paced"]);
export const CourseRuleSeveritySchema = z.enum(["hard", "warning"]);
export const CourseRuleTypeSchema = z.enum([
  "prerequisite",
  "mutual_exclusion",
  "age_range",
  "time_conflict",
  "load_limit",
]);

export const WeeklySessionSchema = z
  .object({
    endMinute: z.number().int().min(1).max(1440),
    startMinute: z.number().int().min(0).max(1439),
    weekday: z.number().int().min(1).max(7),
  })
  .strict()
  .refine((value) => value.endMinute > value.startMinute, {
    message: "A session must end after it starts.",
    path: ["endMinute"],
  });
export type WeeklySession = z.infer<typeof WeeklySessionSchema>;

function sessionsOverlap(first: WeeklySession, second: WeeklySession): boolean {
  return (
    first.weekday === second.weekday &&
    first.startMinute < second.endMinute &&
    second.startMinute < first.endMinute
  );
}

export const CourseVersionContentSchema = z
  .object({
    capabilityTags: UniqueTagArraySchema(1, 50),
    deliverables: UniqueTextArraySchema(1, 30),
    deliveryMode: CourseDeliveryModeSchema,
    difficulty: CourseDifficultySchema,
    durationWeeks: z.number().int().min(1).max(104),
    notSuitableConditions: UniqueTextArraySchema(0, 30).default([]),
    objectives: UniqueTextArraySchema(1, 30),
    projectTypes: UniqueTagArraySchema(0, 30).default([]),
    schedule: z.array(WeeklySessionSchema).max(30).default([]),
    stage: z.string().trim().min(1).max(128),
    subjectTags: UniqueTagArraySchema(1, 30),
    summary: z.string().trim().min(1).max(4000),
    termEndDate: z.iso.date().optional(),
    termStartDate: z.iso.date().optional(),
    title: z.string().trim().min(1).max(200),
    totalInstructionMinutes: z.number().int().min(1).max(100_000),
    weeklyLoadMinutes: z.number().int().min(1).max(10_080),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.deliveryMode === "scheduled") {
      if (value.termStartDate === undefined || value.termEndDate === undefined) {
        context.addIssue({
          code: "custom",
          message: "Scheduled courses require both term dates.",
          path: ["termStartDate"],
        });
      }
      if (value.schedule.length === 0) {
        context.addIssue({
          code: "custom",
          message: "Scheduled courses require at least one weekly session.",
          path: ["schedule"],
        });
      }
    } else if (value.schedule.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Self-paced courses cannot declare fixed weekly sessions.",
        path: ["schedule"],
      });
    }
    if ((value.termStartDate === undefined) !== (value.termEndDate === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Term dates must be provided together.",
        path: ["termEndDate"],
      });
    }
    if (
      value.termStartDate !== undefined &&
      value.termEndDate !== undefined &&
      value.termEndDate < value.termStartDate
    ) {
      context.addIssue({
        code: "custom",
        message: "The term end date cannot be before the start date.",
        path: ["termEndDate"],
      });
    }
    for (let first = 0; first < value.schedule.length; first += 1) {
      const firstSession = value.schedule[first];
      if (firstSession === undefined) continue;
      for (let second = first + 1; second < value.schedule.length; second += 1) {
        const secondSession = value.schedule[second];
        if (secondSession !== undefined && sessionsOverlap(firstSession, secondSession)) {
          context.addIssue({
            code: "custom",
            message: "A course cannot contain overlapping weekly sessions.",
            path: ["schedule", second],
          });
        }
      }
    }
  });
export type CourseVersionContent = z.infer<typeof CourseVersionContentSchema>;

export const CreateCourseInputSchema = z
  .object({ code: CourseCodeSchema, content: CourseVersionContentSchema })
  .strict();
export type CreateCourseInput = z.input<typeof CreateCourseInputSchema>;

export const ReviseCourseVersionInputSchema = z
  .object({
    content: CourseVersionContentSchema,
    expectedSourceUpdatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ReviseCourseVersionInput = z.input<typeof ReviseCourseVersionInputSchema>;

export const CatalogTransitionInputSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("approve"), expectedUpdatedAt: z.iso.datetime({ offset: true }) })
    .strict(),
  z
    .object({
      action: z.literal("archive"),
      expectedUpdatedAt: z.iso.datetime({ offset: true }),
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type CatalogTransitionInput = z.infer<typeof CatalogTransitionInputSchema>;

const RuleBaseShape = {
  message: z.string().trim().min(1).max(500),
  severity: CourseRuleSeveritySchema,
};

const PrerequisiteRuleDefinitionSchema = z
  .object({
    ...RuleBaseShape,
    requiredCourseId: z.uuid(),
    ruleType: z.literal("prerequisite"),
    subjectCourseId: z.uuid(),
  })
  .strict()
  .refine((value) => value.subjectCourseId !== value.requiredCourseId, {
    message: "A course cannot require itself.",
    path: ["requiredCourseId"],
  });

const MutualExclusionRuleDefinitionSchema = z
  .object({
    ...RuleBaseShape,
    courseAId: z.uuid(),
    courseBId: z.uuid(),
    ruleType: z.literal("mutual_exclusion"),
  })
  .strict()
  .refine((value) => value.courseAId !== value.courseBId, {
    message: "A course cannot exclude itself.",
    path: ["courseBId"],
  });

const AgeRangeRuleDefinitionSchema = z
  .object({
    ...RuleBaseShape,
    maxAge: z.number().int().min(3).max(100).optional(),
    minAge: z.number().int().min(3).max(100).optional(),
    ruleType: z.literal("age_range"),
    subjectCourseId: z.uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minAge === undefined && value.maxAge === undefined) {
      context.addIssue({ code: "custom", message: "An age rule requires a bound." });
    }
    if (value.minAge !== undefined && value.maxAge !== undefined && value.maxAge < value.minAge) {
      context.addIssue({
        code: "custom",
        message: "The maximum age cannot be below the minimum age.",
        path: ["maxAge"],
      });
    }
  });

const TimeConflictRuleDefinitionSchema = z
  .object({ ...RuleBaseShape, ruleType: z.literal("time_conflict") })
  .strict();

const LoadLimitRuleDefinitionSchema = z
  .object({
    ...RuleBaseShape,
    maxConcurrentCourses: z.number().int().min(1).max(50).optional(),
    maxWeeklyMinutes: z.number().int().min(1).max(10_080).optional(),
    ruleType: z.literal("load_limit"),
  })
  .strict()
  .refine(
    (value) => value.maxConcurrentCourses !== undefined || value.maxWeeklyMinutes !== undefined,
    "A load rule requires at least one limit.",
  );

export const CourseRuleDefinitionSchema = z.discriminatedUnion("ruleType", [
  PrerequisiteRuleDefinitionSchema,
  MutualExclusionRuleDefinitionSchema,
  AgeRangeRuleDefinitionSchema,
  TimeConflictRuleDefinitionSchema,
  LoadLimitRuleDefinitionSchema,
]);
export type CourseRuleDefinition = z.infer<typeof CourseRuleDefinitionSchema>;

export const CreateCourseRuleInputSchema = z
  .object({ definition: CourseRuleDefinitionSchema, key: CourseRuleKeySchema })
  .strict();
export type CreateCourseRuleInput = z.input<typeof CreateCourseRuleInputSchema>;

export const ReviseCourseRuleInputSchema = z
  .object({
    definition: CourseRuleDefinitionSchema,
    expectedSourceUpdatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ReviseCourseRuleInput = z.input<typeof ReviseCourseRuleInputSchema>;

const ApprovedCourseShape = {
  code: CourseCodeSchema,
  courseId: z.uuid(),
  courseVersionId: z.uuid(),
  version: z.number().int().positive(),
};

export const ApprovedCourseSchema = z
  .object({ ...ApprovedCourseShape, content: CourseVersionContentSchema })
  .strict();
export type ApprovedCourse = z.infer<typeof ApprovedCourseSchema>;

const ApprovedRuleMetadataShape = {
  key: CourseRuleKeySchema,
  ruleId: z.uuid(),
  ruleVersionId: z.uuid(),
  version: z.number().int().positive(),
};

export const ApprovedCourseRuleSchema = z.intersection(
  z.object(ApprovedRuleMetadataShape).strict(),
  CourseRuleDefinitionSchema,
);
export type ApprovedCourseRule = z.infer<typeof ApprovedCourseRuleSchema>;

export const ApprovedCourseCatalogSnapshotSchema = z
  .object({
    courses: z.array(ApprovedCourseSchema).max(5000),
    rules: z.array(ApprovedCourseRuleSchema).max(20_000),
  })
  .strict()
  .superRefine((value, context) => {
    const courseIds = value.courses.map((course) => course.courseId);
    const courseVersionIds = value.courses.map((course) => course.courseVersionId);
    const ruleIds = value.rules.map((rule) => rule.ruleId);
    const ruleVersionIds = value.rules.map((rule) => rule.ruleVersionId);
    for (const [values, path] of [
      [courseIds, "courses.courseId"],
      [courseVersionIds, "courses.courseVersionId"],
      [ruleIds, "rules.ruleId"],
      [ruleVersionIds, "rules.ruleVersionId"],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: `${path} values must be unique.` });
      }
    }
    const knownCourseIds = new Set(courseIds);
    for (let index = 0; index < value.rules.length; index += 1) {
      const rule = value.rules[index];
      if (rule === undefined) continue;
      const references =
        rule.ruleType === "prerequisite"
          ? [rule.subjectCourseId, rule.requiredCourseId]
          : rule.ruleType === "mutual_exclusion"
            ? [rule.courseAId, rule.courseBId]
            : rule.ruleType === "age_range"
              ? [rule.subjectCourseId]
              : [];
      for (const reference of references) {
        if (!knownCourseIds.has(reference)) {
          context.addIssue({
            code: "custom",
            message: "Approved rules must reference an approved course.",
            path: ["rules", index],
          });
        }
      }
    }
  });
export type ApprovedCourseCatalogSnapshot = z.infer<typeof ApprovedCourseCatalogSnapshotSchema>;

export const CourseSelectionInputSchema = z
  .object({
    ageYears: z.number().int().min(3).max(100),
    completedCourseIds: z.array(z.uuid()).max(500),
    selectedCourseVersionIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.completedCourseIds).size !== value.completedCourseIds.length) {
      context.addIssue({
        code: "custom",
        message: "Completed course IDs must be unique.",
        path: ["completedCourseIds"],
      });
    }
    if (new Set(value.selectedCourseVersionIds).size !== value.selectedCourseVersionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Selected course version IDs must be unique.",
        path: ["selectedCourseVersionIds"],
      });
    }
  });
export type CourseSelectionInput = z.infer<typeof CourseSelectionInputSchema>;

export const CourseRuleViolationSchema = z
  .object({
    courseIds: z.array(z.uuid()).min(1).max(2),
    message: z.string().min(1).max(500),
    ruleType: CourseRuleTypeSchema,
    ruleVersionId: z.uuid(),
    severity: CourseRuleSeveritySchema,
  })
  .strict();
export type CourseRuleViolation = z.infer<typeof CourseRuleViolationSchema>;

export const CourseSelectionResultSchema = z
  .object({
    eligible: z.boolean(),
    selectedCourseVersionIds: z.array(z.uuid()).min(1).max(50),
    totalWeeklyLoadMinutes: z.number().int().nonnegative(),
    violations: z.array(CourseRuleViolationSchema),
  })
  .strict();
export type CourseSelectionResult = z.infer<typeof CourseSelectionResultSchema>;
