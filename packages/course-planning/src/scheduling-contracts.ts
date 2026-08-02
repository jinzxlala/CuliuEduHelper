import { z } from "zod";

const StableCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_-]+$/u);
const StableTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_.-]*$/u);
const UniqueTagsSchema = z
  .array(StableTagSchema)
  .max(100)
  .refine((values) => new Set(values).size === values.length, "Tags must be unique.");

export const AvailabilityWindowSchema = z
  .object({
    endMinute: z.number().int().min(1).max(1440),
    startMinute: z.number().int().min(0).max(1439),
    weekday: z.number().int().min(1).max(7),
  })
  .strict()
  .refine((value) => value.endMinute > value.startMinute, {
    message: "Availability must end after it starts.",
    path: ["endMinute"],
  });
export type AvailabilityWindow = z.infer<typeof AvailabilityWindowSchema>;

const UnavailableDatesSchema = z
  .array(z.iso.date())
  .max(366)
  .refine((values) => new Set(values).size === values.length, "Dates must be unique.");

export const TeacherContentSchema = z
  .object({
    maxDailyMinutes: z.number().int().min(1).max(1440),
    maxWeeklyMinutes: z.number().int().min(1).max(10_080),
    name: z.string().trim().min(1).max(160),
    preferredTags: UniqueTagsSchema.default([]),
    qualificationTags: UniqueTagsSchema.min(1),
    unavailableDates: UnavailableDatesSchema.default([]),
    weeklyAvailability: z.array(AvailabilityWindowSchema).min(1).max(50),
  })
  .strict();
export type TeacherContent = z.infer<typeof TeacherContentSchema>;

export const LocationContentSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    unavailableDates: UnavailableDatesSchema.default([]),
    weeklyAvailability: z.array(AvailabilityWindowSchema).min(1).max(50),
  })
  .strict();
export type LocationContent = z.infer<typeof LocationContentSchema>;

export const CandidateOccurrenceSchema = z
  .object({
    endMinute: z.number().int().min(1).max(1440),
    sessionDate: z.iso.date(),
    startMinute: z.number().int().min(0).max(1439),
  })
  .strict()
  .refine((value) => value.endMinute > value.startMinute, {
    message: "A class session must end after it starts.",
    path: ["endMinute"],
  });
export type CandidateOccurrence = z.infer<typeof CandidateOccurrenceSchema>;

export const CandidateScheduleInputSchema = z
  .object({
    kind: z.enum(["weekly", "short_term"]),
    label: z.string().trim().min(1).max(160),
    occurrences: z.array(CandidateOccurrenceSchema).min(1).max(500),
    preferenceRank: z.number().int().min(1).max(1000).default(100),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.occurrences.map(
      (item) => `${item.sessionDate}:${String(item.startMinute)}:${String(item.endMinute)}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "Candidate occurrences must be unique." });
    }
  });
export type CandidateScheduleInput = z.infer<typeof CandidateScheduleInputSchema>;

export const OfferingContentSchema = z
  .object({
    allowedTeacherIds: z.array(z.uuid()).max(500).default([]),
    candidateSchedules: z.array(CandidateScheduleInputSchema).min(1).max(50),
    className: z.string().trim().min(1).max(200),
    courseVersionId: z.uuid(),
    endDate: z.iso.date(),
    locationVersionId: z.uuid(),
    priority: z.number().int().min(1).max(1000).default(100),
    requiredQualificationTags: UniqueTagsSchema.min(1),
    startDate: z.iso.date(),
    studentRosterText: z.array(z.string().trim().min(1).max(160)).max(500).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endDate < value.startDate) {
      context.addIssue({
        code: "custom",
        message: "End date precedes start date.",
        path: ["endDate"],
      });
    }
    if (new Set(value.allowedTeacherIds).size !== value.allowedTeacherIds.length) {
      context.addIssue({ code: "custom", message: "Allowed teacher IDs must be unique." });
    }
    if (new Set(value.studentRosterText).size !== value.studentRosterText.length) {
      context.addIssue({ code: "custom", message: "Roster entries must be unique." });
    }
    if (
      new Set(value.candidateSchedules.map((item) => item.label)).size !==
      value.candidateSchedules.length
    ) {
      context.addIssue({ code: "custom", message: "Candidate labels must be unique." });
    }
    for (const [scheduleIndex, schedule] of value.candidateSchedules.entries()) {
      for (const occurrence of schedule.occurrences) {
        if (occurrence.sessionDate < value.startDate || occurrence.sessionDate > value.endDate) {
          context.addIssue({
            code: "custom",
            message: "Every occurrence must be inside the class date range.",
            path: ["candidateSchedules", scheduleIndex, "occurrences"],
          });
          break;
        }
      }
    }
  });
export type OfferingContent = z.infer<typeof OfferingContentSchema>;

export const CreateTeacherInputSchema = z
  .object({ code: StableCodeSchema, content: TeacherContentSchema })
  .strict();
export const CreateLocationInputSchema = z
  .object({ code: StableCodeSchema, content: LocationContentSchema })
  .strict();
export const CreateOfferingInputSchema = z
  .object({ code: StableCodeSchema, content: OfferingContentSchema })
  .strict();
export const SchedulingTransitionInputSchema = z
  .object({
    action: z.enum(["approve", "archive"]),
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "archive" && value.reason === undefined) {
      context.addIssue({
        code: "custom",
        message: "Archiving requires a reason.",
        path: ["reason"],
      });
    }
  });
