import {
  evidenceInvalidations,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  profileInputSnapshotEvidence,
  profileInputSnapshotFacts,
  profileInputSnapshots,
  studentFacts,
  type Database,
} from "@culiu/database/runtime";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { ProfileInputSnapshotPayloadSchema, sha256, stableJson } from "./contracts.js";
import { ProfileDraftProcessingError } from "./errors.js";

export async function validateCurrentProfileSnapshot(
  database: Database,
  input: { inputSnapshotHash: string; inputSnapshotId: string; studentId: string },
): Promise<ReturnType<typeof ProfileInputSnapshotPayloadSchema.parse>> {
  const rows = await database
    .select({
      payload: profileInputSnapshots.payload,
      snapshotHash: profileInputSnapshots.snapshotHash,
    })
    .from(profileInputSnapshots)
    .where(
      and(
        eq(profileInputSnapshots.id, input.inputSnapshotId),
        eq(profileInputSnapshots.studentId, input.studentId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.snapshotHash !== input.inputSnapshotHash) {
    throw new ProfileDraftProcessingError("snapshot_mismatch");
  }
  const snapshot = ProfileInputSnapshotPayloadSchema.parse(row.payload);
  if (sha256(stableJson(snapshot)) !== row.snapshotHash) {
    throw new ProfileDraftProcessingError("snapshot_hash_invalid");
  }
  const factIds = snapshot.facts.map((fact) => fact.factId);
  const locatorIds = [
    ...new Set(
      snapshot.facts.flatMap((fact) => fact.evidence.map((evidence) => evidence.locatorId)),
    ),
  ];
  const factRows = await database
    .select({ id: studentFacts.id })
    .from(studentFacts)
    .where(
      and(
        inArray(studentFacts.id, factIds),
        eq(studentFacts.studentId, input.studentId),
        eq(studentFacts.confirmationStatus, "confirmed"),
        isNull(studentFacts.validTo),
        sql`${studentFacts.accessLevel} in ('internal', 'sensitive')`,
      ),
    );
  const factChildren = await database
    .select({ supersedesId: studentFacts.supersedesId })
    .from(studentFacts)
    .where(inArray(studentFacts.supersedesId, factIds));
  const locatorRows = await database
    .select({
      id: evidenceLocators.id,
      invalidationId: evidenceInvalidations.id,
      objectId: evidenceObjects.id,
    })
    .from(evidenceLocators)
    .innerJoin(evidenceObjects, eq(evidenceObjects.id, evidenceLocators.evidenceObjectId))
    .leftJoin(evidenceInvalidations, eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id))
    .where(
      and(
        inArray(evidenceLocators.id, locatorIds),
        eq(evidenceObjects.dataDomain, "student"),
        eq(evidenceObjects.studentId, input.studentId),
        sql`${evidenceObjects.accessLevel} in ('internal', 'sensitive')`,
      ),
    );
  const objectIds = locatorRows.map((locator) => locator.objectId);
  const evidenceChildren = await database
    .select({ supersedesId: evidenceObjects.supersedesId })
    .from(evidenceObjects)
    .where(inArray(evidenceObjects.supersedesId, objectIds));
  const snapshotFactRows = await database
    .select({ id: profileInputSnapshotFacts.studentFactId })
    .from(profileInputSnapshotFacts)
    .where(eq(profileInputSnapshotFacts.snapshotId, input.inputSnapshotId));
  const snapshotEvidenceRows = await database
    .select({ id: profileInputSnapshotEvidence.evidenceLocatorId })
    .from(profileInputSnapshotEvidence)
    .where(eq(profileInputSnapshotEvidence.snapshotId, input.inputSnapshotId));
  const linkRows = await database
    .select({
      evidenceLocatorId: factEvidence.evidenceLocatorId,
      relation: factEvidence.relation,
      studentFactId: factEvidence.studentFactId,
      validationStatus: factEvidence.validationStatus,
    })
    .from(factEvidence)
    .where(
      and(
        inArray(factEvidence.studentFactId, factIds),
        inArray(factEvidence.evidenceLocatorId, locatorIds),
      ),
    );
  const expectedLinks = new Set(
    snapshot.facts.flatMap((fact) =>
      fact.evidence.map((evidence) => `${fact.factId}:${evidence.locatorId}:${evidence.relation}`),
    ),
  );
  const validLinks = new Set(
    linkRows
      .filter((link) => link.validationStatus === "valid")
      .map((link) => `${link.studentFactId}:${link.evidenceLocatorId}:${link.relation}`),
  );
  if (
    factRows.length !== factIds.length ||
    factChildren.length > 0 ||
    locatorRows.length !== locatorIds.length ||
    locatorRows.some((locator) => locator.invalidationId !== null) ||
    evidenceChildren.length > 0 ||
    snapshotFactRows.length !== factIds.length ||
    snapshotEvidenceRows.length !== locatorIds.length ||
    snapshotFactRows.some((fact) => !factIds.includes(fact.id)) ||
    snapshotEvidenceRows.some((locator) => !locatorIds.includes(locator.id)) ||
    expectedLinks.size !== validLinks.size ||
    [...expectedLinks].some((link) => !validLinks.has(link))
  ) {
    throw new ProfileDraftProcessingError("snapshot_source_stale");
  }
  return snapshot;
}
