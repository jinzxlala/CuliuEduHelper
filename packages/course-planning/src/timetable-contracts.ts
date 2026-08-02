import { z } from "zod";

import { AvailabilityWindowSchema, CandidateOccurrenceSchema } from "./scheduling-contracts.js";

export const TimetableTeacherSchema = z
  .object({
    id: z.uuid(),
    maxDailyMinutes: z.number().int().positive(),
    maxWeeklyMinutes: z.number().int().positive(),
    preferredTags: z.array(z.string()),
    qualificationTags: z.array(z.string()).min(1),
    unavailableDates: z.array(z.iso.date()),
    weeklyAvailability: z.array(AvailabilityWindowSchema).min(1),
  })
  .strict();
export const TimetableLocationSchema = z
  .object({
    id: z.uuid(),
    unavailableDates: z.array(z.iso.date()),
    weeklyAvailability: z.array(AvailabilityWindowSchema).min(1),
  })
  .strict();
export const TimetableCandidateSchema = z
  .object({
    id: z.uuid(),
    label: z.string().min(1),
    occurrences: z.array(CandidateOccurrenceSchema).min(1).max(500),
    preferenceRank: z.number().int().min(1).max(1000),
  })
  .strict();
export const TimetableOfferingSchema = z
  .object({
    allowedTeacherIds: z.array(z.uuid()),
    candidates: z.array(TimetableCandidateSchema).min(1),
    className: z.string().min(1),
    endDate: z.iso.date(),
    id: z.uuid(),
    locationId: z.uuid(),
    lockedCandidateId: z.uuid().nullable(),
    lockedTeacherId: z.uuid().nullable(),
    priority: z.number().int().min(1).max(1000),
    requiredQualificationTags: z.array(z.string()).min(1),
    startDate: z.iso.date(),
  })
  .strict();
export const TimetableInputSchema = z
  .object({
    locations: z.array(TimetableLocationSchema).min(1),
    offerings: z.array(TimetableOfferingSchema).min(1).max(500),
    teachers: z.array(TimetableTeacherSchema).min(1).max(500),
    timeLimitSeconds: z.number().positive().max(300).default(30),
  })
  .strict();
export type TimetableInput = z.infer<typeof TimetableInputSchema>;

export interface TimetableAssignment {
  candidateId: string;
  offeringId: string;
  occurrences: Array<z.infer<typeof CandidateOccurrenceSchema>>;
  teacherId: string;
}
export interface TimetableSolveResult {
  assignments: TimetableAssignment[];
  objectiveValue: number;
  solverStatus: string;
  status: "solved" | "partially_solved" | "infeasible" | "failed";
  unassigned: Array<{ offeringId: string; reason: string }>;
}
