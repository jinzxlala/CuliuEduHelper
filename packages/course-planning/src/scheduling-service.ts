import { randomUUID } from "node:crypto";

import { SessionPrincipalSchema, type SessionPrincipal } from "@culiu/authorization";
import {
  appUsers,
  auditEvents,
  candidateScheduleOccurrences,
  candidateSchedules,
  courseOfferingVersions,
  courseOfferings,
  courseVersions,
  teacherVersions,
  teachers,
  teachingLocationVersions,
  teachingLocations,
  type Database,
} from "@culiu/database/runtime";
import { and, asc, eq, inArray } from "drizzle-orm";

import {
  CreateLocationInputSchema,
  CreateOfferingInputSchema,
  CreateTeacherInputSchema,
  SchedulingTransitionInputSchema,
  type CandidateOccurrence,
  type LocationContent,
  type OfferingContent,
  type TeacherContent,
} from "./scheduling-contracts.js";
import {
  SchedulingAuthorizationError,
  SchedulingConflictError,
  SchedulingNotFoundError,
} from "./scheduling-errors.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type SchedulingKind = "location" | "offering" | "teacher";

async function requireAdmin(
  database: Pick<Database, "select">,
  rawPrincipal: SessionPrincipal,
): Promise<SessionPrincipal> {
  const principal = SessionPrincipalSchema.parse(rawPrincipal);
  const [account] = await database
    .select({ active: appUsers.active, email: appUsers.email, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.id, principal.id))
    .limit(1);
  if (
    account === undefined ||
    !account.active ||
    account.role !== "admin" ||
    principal.role !== "admin" ||
    account.email.toLowerCase() !== principal.email
  ) {
    throw new SchedulingAuthorizationError();
  }
  return principal;
}

async function audit(
  transaction: Transaction,
  actorUserId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const rawObjectId =
    metadata.versionId ?? metadata.teacherId ?? metadata.locationId ?? metadata.offeringId;
  const objectId = typeof rawObjectId === "string" ? rawObjectId : "catalog";
  await transaction.insert(auditEvents).values({
    action,
    actorType: "user",
    actorUserId,
    details: metadata,
    objectId,
    objectType: "scheduling_resource",
    requestCorrelationId: randomUUID(),
    result: "success",
  });
}

function ensureExpectedTimestamp(actual: Date, expected: string): void {
  if (actual.toISOString() !== new Date(expected).toISOString()) {
    throw new SchedulingConflictError();
  }
}

function weekdayForIsoDate(value: string): number {
  const day = new Date(`${value}T12:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function windowContains(
  windows: Array<{ weekday: number; startMinute: number; endMinute: number }>,
  occurrence: CandidateOccurrence,
): boolean {
  const weekday = weekdayForIsoDate(occurrence.sessionDate);
  return windows.some(
    (window) =>
      window.weekday === weekday &&
      window.startMinute <= occurrence.startMinute &&
      window.endMinute >= occurrence.endMinute,
  );
}

async function validateOfferingReferences(
  transaction: Transaction,
  content: OfferingContent,
): Promise<void> {
  const [course] = await transaction
    .select({ id: courseVersions.id, status: courseVersions.status })
    .from(courseVersions)
    .where(eq(courseVersions.id, content.courseVersionId))
    .limit(1);
  const [location] = await transaction
    .select({
      id: teachingLocationVersions.id,
      status: teachingLocationVersions.status,
      unavailableDates: teachingLocationVersions.unavailableDates,
      weeklyAvailability: teachingLocationVersions.weeklyAvailability,
    })
    .from(teachingLocationVersions)
    .where(eq(teachingLocationVersions.id, content.locationVersionId))
    .limit(1);
  if (course?.status !== "approved" || location?.status !== "approved") {
    throw new SchedulingConflictError("A class requires approved course and location versions.");
  }
  if (content.allowedTeacherIds.length > 0) {
    const allowed = await transaction
      .select({ teacherId: teacherVersions.teacherId })
      .from(teacherVersions)
      .where(
        and(
          inArray(teacherVersions.teacherId, content.allowedTeacherIds),
          eq(teacherVersions.status, "approved"),
        ),
      );
    if (new Set(allowed.map((item) => item.teacherId)).size !== content.allowedTeacherIds.length) {
      throw new SchedulingConflictError("Every allowed teacher must have an approved version.");
    }
  }
  for (const schedule of content.candidateSchedules) {
    for (const occurrence of schedule.occurrences) {
      if (
        location.unavailableDates.includes(occurrence.sessionDate) ||
        !windowContains(location.weeklyAvailability, occurrence)
      ) {
        throw new SchedulingConflictError(
          `Candidate schedule ${schedule.label} is outside the fixed location availability.`,
        );
      }
    }
  }
}

export async function createTeacher(
  database: Database,
  rawPrincipal: SessionPrincipal,
  rawInput: unknown,
): Promise<{ teacherId: string; versionId: string; updatedAt: Date }> {
  const principal = await requireAdmin(database, rawPrincipal);
  const input = CreateTeacherInputSchema.parse(rawInput);
  return database.transaction(async (transaction) => {
    const [teacher] = await transaction
      .insert(teachers)
      .values({ code: input.code, createdByUserId: principal.id })
      .returning({ id: teachers.id });
    if (teacher === undefined) throw new SchedulingConflictError();
    const [version] = await transaction
      .insert(teacherVersions)
      .values({
        ...input.content,
        createdByUserId: principal.id,
        status: "draft",
        teacherId: teacher.id,
        version: 1,
      })
      .returning({ id: teacherVersions.id, updatedAt: teacherVersions.updatedAt });
    if (version === undefined) throw new SchedulingConflictError();
    await audit(transaction, principal.id, "scheduling.teacher.created", {
      teacherId: teacher.id,
      versionId: version.id,
    });
    return { teacherId: teacher.id, versionId: version.id, updatedAt: version.updatedAt };
  });
}

export async function createTeachingLocation(
  database: Database,
  rawPrincipal: SessionPrincipal,
  rawInput: unknown,
): Promise<{ locationId: string; versionId: string; updatedAt: Date }> {
  const principal = await requireAdmin(database, rawPrincipal);
  const input = CreateLocationInputSchema.parse(rawInput);
  return database.transaction(async (transaction) => {
    const [location] = await transaction
      .insert(teachingLocations)
      .values({ code: input.code, createdByUserId: principal.id })
      .returning({ id: teachingLocations.id });
    if (location === undefined) throw new SchedulingConflictError();
    const [version] = await transaction
      .insert(teachingLocationVersions)
      .values({
        ...input.content,
        createdByUserId: principal.id,
        locationId: location.id,
        status: "draft",
        version: 1,
      })
      .returning({
        id: teachingLocationVersions.id,
        updatedAt: teachingLocationVersions.updatedAt,
      });
    if (version === undefined) throw new SchedulingConflictError();
    await audit(transaction, principal.id, "scheduling.location.created", {
      locationId: location.id,
      versionId: version.id,
    });
    return { locationId: location.id, versionId: version.id, updatedAt: version.updatedAt };
  });
}

export async function createCourseOffering(
  database: Database,
  rawPrincipal: SessionPrincipal,
  rawInput: unknown,
): Promise<{ offeringId: string; versionId: string; updatedAt: Date }> {
  const principal = await requireAdmin(database, rawPrincipal);
  const input = CreateOfferingInputSchema.parse(rawInput);
  return database.transaction(async (transaction) => {
    await validateOfferingReferences(transaction, input.content);
    const [offering] = await transaction
      .insert(courseOfferings)
      .values({ code: input.code, createdByUserId: principal.id })
      .returning({ id: courseOfferings.id });
    if (offering === undefined) throw new SchedulingConflictError();
    const { candidateSchedules: schedules, ...content } = input.content;
    const [version] = await transaction
      .insert(courseOfferingVersions)
      .values({
        ...content,
        createdByUserId: principal.id,
        offeringId: offering.id,
        status: "draft",
        version: 1,
      })
      .returning({ id: courseOfferingVersions.id, updatedAt: courseOfferingVersions.updatedAt });
    if (version === undefined) throw new SchedulingConflictError();
    for (const schedule of schedules) {
      const [created] = await transaction
        .insert(candidateSchedules)
        .values({
          kind: schedule.kind,
          label: schedule.label,
          offeringVersionId: version.id,
          preferenceRank: schedule.preferenceRank,
        })
        .returning({ id: candidateSchedules.id });
      if (created === undefined) throw new SchedulingConflictError();
      await transaction.insert(candidateScheduleOccurrences).values(
        schedule.occurrences.map((occurrence) => ({
          ...occurrence,
          candidateScheduleId: created.id,
        })),
      );
    }
    await audit(transaction, principal.id, "scheduling.offering.created", {
      candidateScheduleCount: schedules.length,
      fixedLocationVersionId: content.locationVersionId,
      offeringId: offering.id,
      versionId: version.id,
    });
    return { offeringId: offering.id, versionId: version.id, updatedAt: version.updatedAt };
  });
}

export async function transitionSchedulingVersion(
  database: Database,
  rawPrincipal: SessionPrincipal,
  kind: SchedulingKind,
  versionId: string,
  rawInput: unknown,
): Promise<{ status: "approved" | "archived"; updatedAt: Date }> {
  const principal = await requireAdmin(database, rawPrincipal);
  const input = SchedulingTransitionInputSchema.parse(rawInput);
  return database.transaction(async (transaction) => {
    const table =
      kind === "teacher"
        ? teacherVersions
        : kind === "location"
          ? teachingLocationVersions
          : courseOfferingVersions;
    const [current] = await transaction
      .select({ status: table.status, updatedAt: table.updatedAt })
      .from(table)
      .where(eq(table.id, versionId))
      .limit(1);
    if (current === undefined) throw new SchedulingNotFoundError();
    ensureExpectedTimestamp(current.updatedAt, input.expectedUpdatedAt);
    if (input.action === "approve" && current.status !== "draft") {
      throw new SchedulingConflictError("Only a draft can be approved.");
    }
    if (input.action === "archive" && current.status === "archived") {
      throw new SchedulingConflictError("The version is already archived.");
    }
    const [updated] = await transaction
      .update(table)
      .set(
        input.action === "approve"
          ? {
              approvedAt: new Date(),
              approvedByUserId: principal.id,
              status: "approved" as const,
              updatedAt: new Date(),
            }
          : {
              archivedReason: input.reason,
              status: "archived" as const,
              updatedAt: new Date(),
            },
      )
      .where(eq(table.id, versionId))
      .returning({ status: table.status, updatedAt: table.updatedAt });
    if (updated === undefined) throw new SchedulingConflictError();
    await audit(transaction, principal.id, `scheduling.${kind}.${input.action}`, { versionId });
    return { status: updated.status as "approved" | "archived", updatedAt: updated.updatedAt };
  });
}

export interface SchedulingCatalogSnapshot {
  locations: Array<{
    code: string;
    content: LocationContent;
    locationId: string;
    status: "approved" | "archived" | "draft";
    updatedAt: Date;
    versionId: string;
  }>;
  offerings: Array<{
    code: string;
    content: Omit<OfferingContent, "candidateSchedules"> & {
      candidateSchedules: Array<{
        id: string;
        kind: "short_term" | "weekly";
        label: string;
        occurrences: CandidateOccurrence[];
        preferenceRank: number;
      }>;
    };
    offeringId: string;
    status: "approved" | "archived" | "draft";
    updatedAt: Date;
    versionId: string;
  }>;
  teachers: Array<{
    code: string;
    content: TeacherContent;
    status: "approved" | "archived" | "draft";
    updatedAt: Date;
    teacherId: string;
    versionId: string;
  }>;
}

export async function readSchedulingCatalog(
  database: Database,
  rawPrincipal: SessionPrincipal,
): Promise<SchedulingCatalogSnapshot> {
  await requireAdmin(database, rawPrincipal);
  const teacherRows = await database
    .select({ code: teachers.code, identityId: teachers.id, version: teacherVersions })
    .from(teacherVersions)
    .innerJoin(teachers, eq(teachers.id, teacherVersions.teacherId))
    .orderBy(asc(teachers.code), asc(teacherVersions.version));
  const locationRows = await database
    .select({
      code: teachingLocations.code,
      identityId: teachingLocations.id,
      version: teachingLocationVersions,
    })
    .from(teachingLocationVersions)
    .innerJoin(teachingLocations, eq(teachingLocations.id, teachingLocationVersions.locationId))
    .orderBy(asc(teachingLocations.code), asc(teachingLocationVersions.version));
  const offeringRows = await database
    .select({
      code: courseOfferings.code,
      identityId: courseOfferings.id,
      version: courseOfferingVersions,
    })
    .from(courseOfferingVersions)
    .innerJoin(courseOfferings, eq(courseOfferings.id, courseOfferingVersions.offeringId))
    .orderBy(asc(courseOfferings.code), asc(courseOfferingVersions.version));
  const offeringVersionIds = offeringRows.map((row) => row.version.id);
  const scheduleRows =
    offeringVersionIds.length === 0
      ? []
      : await database
          .select()
          .from(candidateSchedules)
          .where(inArray(candidateSchedules.offeringVersionId, offeringVersionIds));
  const scheduleIds = scheduleRows.map((row) => row.id);
  const occurrences =
    scheduleIds.length === 0
      ? []
      : await database
          .select()
          .from(candidateScheduleOccurrences)
          .where(inArray(candidateScheduleOccurrences.candidateScheduleId, scheduleIds));
  return {
    locations: locationRows.map(({ code, identityId, version }) => ({
      code,
      content: {
        name: version.name,
        unavailableDates: version.unavailableDates,
        weeklyAvailability: version.weeklyAvailability,
      },
      locationId: identityId,
      status: version.status,
      updatedAt: version.updatedAt,
      versionId: version.id,
    })),
    offerings: offeringRows.map(({ code, identityId, version }) => ({
      code,
      content: {
        allowedTeacherIds: version.allowedTeacherIds,
        candidateSchedules: scheduleRows
          .filter((schedule) => schedule.offeringVersionId === version.id)
          .map((schedule) => ({
            id: schedule.id,
            kind: schedule.kind,
            label: schedule.label,
            occurrences: occurrences
              .filter((item) => item.candidateScheduleId === schedule.id)
              .map((item) => ({
                endMinute: item.endMinute,
                sessionDate: item.sessionDate,
                startMinute: item.startMinute,
              })),
            preferenceRank: schedule.preferenceRank,
          })),
        className: version.className,
        courseVersionId: version.courseVersionId,
        endDate: version.endDate,
        locationVersionId: version.locationVersionId,
        priority: version.priority,
        requiredQualificationTags: version.requiredQualificationTags,
        startDate: version.startDate,
        studentRosterText: version.studentRosterText,
      },
      offeringId: identityId,
      status: version.status,
      updatedAt: version.updatedAt,
      versionId: version.id,
    })),
    teachers: teacherRows.map(({ code, identityId, version }) => ({
      code,
      content: {
        maxDailyMinutes: version.maxDailyMinutes,
        maxWeeklyMinutes: version.maxWeeklyMinutes,
        name: version.name,
        preferredTags: version.preferredTags,
        qualificationTags: version.qualificationTags,
        unavailableDates: version.unavailableDates,
        weeklyAvailability: version.weeklyAvailability,
      },
      status: version.status,
      updatedAt: version.updatedAt,
      teacherId: identityId,
      versionId: version.id,
    })),
  };
}
