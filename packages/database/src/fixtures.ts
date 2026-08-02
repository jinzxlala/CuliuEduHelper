import type { Database } from "./client.js";
import {
  appUsers,
  authorizationContextSnapshots,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  sourceDocuments,
  studentAuthorizations,
  studentFacts,
  students,
} from "./schema.js";

export const REDACTED_FIXTURE_IDS = {
  advisorUser: "00000000-0000-4000-8000-000000000001",
  authorization: "00000000-0000-4000-8000-000000000003",
  authorizationContext: "00000000-0000-4000-8000-000000000004",
  evidenceLocator: "00000000-0000-4000-8000-000000000007",
  evidenceObject: "00000000-0000-4000-8000-000000000006",
  knowledgeAuthorizationContext: "00000000-0000-4000-8000-000000000010",
  knowledgeServiceUser: "00000000-0000-4000-8000-000000000009",
  sourceDocument: "00000000-0000-4000-8000-000000000005",
  student: "00000000-0000-4000-8000-000000000002",
  studentFact: "00000000-0000-4000-8000-000000000008",
} as const;

const syntheticHash = "a".repeat(64);

export async function seedRedactedFixtures(database: Database): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .insert(appUsers)
      .values({
        displayName: "Synthetic Advisor",
        email: "advisor@example.invalid",
        id: REDACTED_FIXTURE_IDS.advisorUser,
        role: "advisor",
      })
      .onConflictDoNothing();

    await transaction
      .insert(appUsers)
      .values({
        displayName: "Synthetic Knowledge Importer",
        email: "knowledge-importer@example.invalid",
        id: REDACTED_FIXTURE_IDS.knowledgeServiceUser,
        role: "service",
      })
      .onConflictDoNothing();

    await transaction
      .insert(authorizationContextSnapshots)
      .values({
        actorUserId: REDACTED_FIXTURE_IDS.knowledgeServiceUser,
        allowedActions: ["knowledge.import"],
        contextHash: "d".repeat(64),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        id: REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext,
        maxAccessLevel: "restricted",
      })
      .onConflictDoNothing();

    await transaction
      .insert(students)
      .values({
        id: REDACTED_FIXTURE_IDS.student,
        ownerUserId: REDACTED_FIXTURE_IDS.advisorUser,
        privacyLevel: "sensitive",
        publicCode: "student_demo_001",
      })
      .onConflictDoNothing();

    await transaction
      .insert(studentAuthorizations)
      .values({
        allowedActions: [
          "student:read",
          "student:write",
          "student:profile:generate",
          "student:recommendation:generate",
          "student:recommendation:review",
          "student:profile:review",
          "student:profile:approve",
          "student:plan:write",
          "student:plan:review",
          "student:plan:approve",
          "student:plan:export",
        ],
        grantedByUserId: REDACTED_FIXTURE_IDS.advisorUser,
        id: REDACTED_FIXTURE_IDS.authorization,
        maxAccessLevel: "sensitive",
        studentId: REDACTED_FIXTURE_IDS.student,
        userId: REDACTED_FIXTURE_IDS.advisorUser,
      })
      .onConflictDoUpdate({
        target: [studentAuthorizations.userId, studentAuthorizations.studentId],
        set: {
          allowedActions: [
            "student:read",
            "student:write",
            "student:profile:generate",
            "student:recommendation:generate",
            "student:recommendation:review",
            "student:profile:review",
            "student:profile:approve",
            "student:plan:write",
            "student:plan:review",
            "student:plan:approve",
            "student:plan:export",
          ],
          maxAccessLevel: "sensitive",
        },
      });

    await transaction
      .insert(authorizationContextSnapshots)
      .values({
        actorUserId: REDACTED_FIXTURE_IDS.advisorUser,
        allowedActions: [
          "student:read",
          "student:write",
          "student:profile:generate",
          "student:recommendation:generate",
          "student:recommendation:review",
          "student:profile:review",
          "student:profile:approve",
          "student:plan:write",
          "student:plan:review",
          "student:plan:approve",
          "student:plan:export",
        ],
        contextHash: "b".repeat(64),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        id: REDACTED_FIXTURE_IDS.authorizationContext,
        maxAccessLevel: "sensitive",
        studentId: REDACTED_FIXTURE_IDS.student,
      })
      .onConflictDoNothing();

    await transaction
      .insert(sourceDocuments)
      .values({
        contentHash: syntheticHash,
        dataDomain: "knowledge",
        documentType: "analysis_markdown",
        id: REDACTED_FIXTURE_IDS.sourceDocument,
        mimeType: "text/markdown",
        sourcePath: "fixtures/anonymous_lecture.md",
      })
      .onConflictDoNothing();

    await transaction
      .insert(evidenceObjects)
      .values({
        accessLevel: "sensitive",
        contentHash: "c".repeat(64),
        dataDomain: "student",
        id: REDACTED_FIXTURE_IDS.evidenceObject,
        storageKey: `student/${REDACTED_FIXTURE_IDS.student}/cc/${"c".repeat(64)}`,
        studentId: REDACTED_FIXTURE_IDS.student,
        uploadedByUserId: REDACTED_FIXTURE_IDS.advisorUser,
      })
      .onConflictDoNothing();

    await transaction
      .insert(evidenceLocators)
      .values({
        evidenceObjectId: REDACTED_FIXTURE_IDS.evidenceObject,
        id: REDACTED_FIXTURE_IDS.evidenceLocator,
        locator: { field: "synthetic_field" },
        locatorType: "record_field",
      })
      .onConflictDoNothing();

    await transaction
      .insert(studentFacts)
      .values({
        confirmationStatus: "confirmed",
        fieldKey: "synthetic_readiness",
        id: REDACTED_FIXTURE_IDS.studentFact,
        sourceType: "evidence",
        studentId: REDACTED_FIXTURE_IDS.student,
        value: { level: "synthetic-baseline" },
      })
      .onConflictDoNothing();

    await transaction
      .insert(factEvidence)
      .values({
        evidenceLocatorId: REDACTED_FIXTURE_IDS.evidenceLocator,
        relation: "supports",
        studentFactId: REDACTED_FIXTURE_IDS.studentFact,
        validationStatus: "valid",
      })
      .onConflictDoNothing();
  });
}
