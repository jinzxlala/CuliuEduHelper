import { randomUUID } from "node:crypto";

import {
  appUsers,
  knowledgeAnalysisConversations,
  knowledgeAnalysisSources,
  knowledgeAnalysisWorkspaceMembers,
  knowledgeAnalysisWorkspaces,
  knowledgeCaseVersions,
  knowledgeImportBatches,
  knowledgeLectureVersions,
  sourceDocuments,
  type Database,
} from "@culiu/database/runtime";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  AddKnowledgeWorkspaceSourcesInputSchema,
  CreateKnowledgeConversationInputSchema,
  CreateKnowledgeWorkspaceInputSchema,
  KNOWLEDGE_ANALYSIS_MAX_SOURCES,
  KnowledgeAnalysisSourceIdSchema,
  KnowledgeWorkspaceIdSchema,
  SetKnowledgeWorkspaceMemberInputSchema,
  UpdateKnowledgeWorkspaceInputSchema,
  type KnowledgeSourceReference,
  type KnowledgeWorkspaceRole,
} from "./contracts.js";
import {
  canPerformKnowledgeWorkspaceAction,
  type KnowledgeWorkspaceAction,
} from "./permissions.js";

export class KnowledgeWorkspaceNotFoundError extends Error {
  constructor() {
    super("Knowledge workspace was not found.");
    this.name = "KnowledgeWorkspaceNotFoundError";
  }
}

export class KnowledgeWorkspaceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeWorkspaceConflictError";
  }
}

interface Membership {
  role: KnowledgeWorkspaceRole;
  workspaceStatus: "active" | "archived";
}

export interface KnowledgeSourceCatalogItem {
  alreadyAdded: boolean;
  sourceId: string;
  sourceType: "lecture" | "case";
  summary: string;
  title: string;
}

async function requireMembership(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  action: KnowledgeWorkspaceAction,
): Promise<Membership> {
  KnowledgeWorkspaceIdSchema.parse(workspaceId);
  const rows = await database
    .select({
      active: appUsers.active,
      role: knowledgeAnalysisWorkspaceMembers.role,
      userRole: appUsers.role,
      workspaceStatus: knowledgeAnalysisWorkspaces.status,
    })
    .from(knowledgeAnalysisWorkspaceMembers)
    .innerJoin(appUsers, eq(appUsers.id, knowledgeAnalysisWorkspaceMembers.userId))
    .innerJoin(
      knowledgeAnalysisWorkspaces,
      eq(knowledgeAnalysisWorkspaces.id, knowledgeAnalysisWorkspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(knowledgeAnalysisWorkspaceMembers.workspaceId, workspaceId),
        eq(knowledgeAnalysisWorkspaceMembers.userId, actorUserId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    row === undefined ||
    !row.active ||
    row.userRole === "service" ||
    !canPerformKnowledgeWorkspaceAction(row.role, action) ||
    (row.workspaceStatus === "archived" && action !== "read" && action !== "download_report")
  ) {
    throw new KnowledgeWorkspaceNotFoundError();
  }
  return { role: row.role, workspaceStatus: row.workspaceStatus };
}

export async function assertKnowledgeWorkspacePermission(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  action: KnowledgeWorkspaceAction,
): Promise<void> {
  await requireMembership(database, actorUserId, workspaceId, action);
}

async function requireActiveInteractiveUser(database: Database, userId: string): Promise<void> {
  const rows = await database
    .select({ active: appUsers.active, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || !row.active || row.role === "service") {
    throw new KnowledgeWorkspaceNotFoundError();
  }
}

export async function createKnowledgeWorkspace(
  database: Database,
  actorUserId: string,
  untrustedInput: unknown,
): Promise<{ id: string }> {
  const input = CreateKnowledgeWorkspaceInputSchema.parse(untrustedInput);
  await requireActiveInteractiveUser(database, actorUserId);
  const id = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.insert(knowledgeAnalysisWorkspaces).values({
      description: input.description,
      id,
      name: input.name,
      ownerUserId: actorUserId,
    });
    await transaction.insert(knowledgeAnalysisWorkspaceMembers).values({
      grantedByUserId: actorUserId,
      role: "owner",
      userId: actorUserId,
      workspaceId: id,
    });
  });
  return { id };
}

export async function listKnowledgeWorkspaces(
  database: Database,
  actorUserId: string,
): Promise<
  Array<{
    description: string;
    id: string;
    name: string;
    role: KnowledgeWorkspaceRole;
    status: "active" | "archived";
    updatedAt: Date;
  }>
> {
  await requireActiveInteractiveUser(database, actorUserId);
  return database
    .select({
      description: knowledgeAnalysisWorkspaces.description,
      id: knowledgeAnalysisWorkspaces.id,
      name: knowledgeAnalysisWorkspaces.name,
      role: knowledgeAnalysisWorkspaceMembers.role,
      status: knowledgeAnalysisWorkspaces.status,
      updatedAt: knowledgeAnalysisWorkspaces.updatedAt,
    })
    .from(knowledgeAnalysisWorkspaceMembers)
    .innerJoin(
      knowledgeAnalysisWorkspaces,
      eq(knowledgeAnalysisWorkspaces.id, knowledgeAnalysisWorkspaceMembers.workspaceId),
    )
    .where(eq(knowledgeAnalysisWorkspaceMembers.userId, actorUserId))
    .orderBy(desc(knowledgeAnalysisWorkspaces.updatedAt));
}

export async function readKnowledgeWorkspace(
  database: Database,
  actorUserId: string,
  workspaceId: string,
): Promise<{
  conversations: Array<typeof knowledgeAnalysisConversations.$inferSelect>;
  members: Array<{
    displayName: string;
    email: string;
    role: KnowledgeWorkspaceRole;
    userId: string;
  }>;
  role: KnowledgeWorkspaceRole;
  sources: Array<typeof knowledgeAnalysisSources.$inferSelect>;
  workspace: typeof knowledgeAnalysisWorkspaces.$inferSelect;
}> {
  const membership = await requireMembership(database, actorUserId, workspaceId, "read");
  const workspaceRows = await database
    .select()
    .from(knowledgeAnalysisWorkspaces)
    .where(eq(knowledgeAnalysisWorkspaces.id, workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (workspace === undefined) throw new KnowledgeWorkspaceNotFoundError();
  const [members, sources, conversations] = await Promise.all([
    database
      .select({
        displayName: appUsers.displayName,
        email: appUsers.email,
        role: knowledgeAnalysisWorkspaceMembers.role,
        userId: appUsers.id,
      })
      .from(knowledgeAnalysisWorkspaceMembers)
      .innerJoin(appUsers, eq(appUsers.id, knowledgeAnalysisWorkspaceMembers.userId))
      .where(eq(knowledgeAnalysisWorkspaceMembers.workspaceId, workspaceId)),
    database
      .select()
      .from(knowledgeAnalysisSources)
      .where(eq(knowledgeAnalysisSources.workspaceId, workspaceId))
      .orderBy(desc(knowledgeAnalysisSources.createdAt)),
    database
      .select()
      .from(knowledgeAnalysisConversations)
      .where(eq(knowledgeAnalysisConversations.workspaceId, workspaceId))
      .orderBy(desc(knowledgeAnalysisConversations.updatedAt)),
  ]);
  return { conversations, members, role: membership.role, sources, workspace };
}

export async function updateKnowledgeWorkspace(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  untrustedInput: unknown,
): Promise<void> {
  const input = UpdateKnowledgeWorkspaceInputSchema.parse(untrustedInput);
  await requireMembership(database, actorUserId, workspaceId, "manage_workspace");
  const updated = await database
    .update(knowledgeAnalysisWorkspaces)
    .set({
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.name === undefined ? {} : { name: input.name }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeAnalysisWorkspaces.id, workspaceId),
        eq(knowledgeAnalysisWorkspaces.status, "active"),
        eq(knowledgeAnalysisWorkspaces.updatedAt, new Date(input.expectedUpdatedAt)),
      ),
    )
    .returning({ id: knowledgeAnalysisWorkspaces.id });
  if (updated.length !== 1) throw new KnowledgeWorkspaceConflictError("Workspace changed.");
}

export async function archiveKnowledgeWorkspace(
  database: Database,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  await requireMembership(database, actorUserId, workspaceId, "manage_workspace");
  const now = new Date();
  const updated = await database
    .update(knowledgeAnalysisWorkspaces)
    .set({ archivedAt: now, status: "archived", updatedAt: now })
    .where(
      and(
        eq(knowledgeAnalysisWorkspaces.id, workspaceId),
        eq(knowledgeAnalysisWorkspaces.status, "active"),
      ),
    )
    .returning({ id: knowledgeAnalysisWorkspaces.id });
  if (updated.length !== 1) throw new KnowledgeWorkspaceConflictError("Workspace is archived.");
}

export async function setKnowledgeWorkspaceMember(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  untrustedInput: unknown,
): Promise<void> {
  const input = SetKnowledgeWorkspaceMemberInputSchema.parse(untrustedInput);
  await requireMembership(database, actorUserId, workspaceId, "manage_members");
  const targetRows = await database
    .select({ active: appUsers.active, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.id, input.userId))
    .limit(1);
  const target = targetRows[0];
  if (target === undefined || !target.active || target.role === "service") {
    throw new KnowledgeWorkspaceNotFoundError();
  }
  const role = target.role === "auditor" ? "viewer" : input.role;
  await database
    .insert(knowledgeAnalysisWorkspaceMembers)
    .values({ grantedByUserId: actorUserId, role, userId: input.userId, workspaceId })
    .onConflictDoUpdate({
      set: { grantedByUserId: actorUserId, role, updatedAt: new Date() },
      target: [
        knowledgeAnalysisWorkspaceMembers.workspaceId,
        knowledgeAnalysisWorkspaceMembers.userId,
      ],
    });
}

export async function revokeKnowledgeWorkspaceMember(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
): Promise<void> {
  await requireMembership(database, actorUserId, workspaceId, "manage_members");
  const removed = await database
    .delete(knowledgeAnalysisWorkspaceMembers)
    .where(
      and(
        eq(knowledgeAnalysisWorkspaceMembers.workspaceId, workspaceId),
        eq(knowledgeAnalysisWorkspaceMembers.userId, targetUserId),
        or(
          eq(knowledgeAnalysisWorkspaceMembers.role, "editor"),
          eq(knowledgeAnalysisWorkspaceMembers.role, "viewer"),
        ),
      ),
    )
    .returning({ userId: knowledgeAnalysisWorkspaceMembers.userId });
  if (removed.length !== 1) throw new KnowledgeWorkspaceNotFoundError();
}

export async function addKnowledgeWorkspaceSources(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  untrustedInput: unknown,
): Promise<{ created: string[]; existing: string[] }> {
  const input = AddKnowledgeWorkspaceSourcesInputSchema.parse(untrustedInput);
  await requireMembership(database, actorUserId, workspaceId, "add_sources");
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::text, 0))`,
    );
    const existingRows = await transaction
      .select({
        sourceId: knowledgeAnalysisSources.sourceId,
        sourceType: knowledgeAnalysisSources.sourceType,
      })
      .from(knowledgeAnalysisSources)
      .where(
        and(
          eq(knowledgeAnalysisSources.workspaceId, workspaceId),
          isNull(knowledgeAnalysisSources.removedAt),
          inArray(
            knowledgeAnalysisSources.sourceId,
            input.sources.map((source) => source.sourceId),
          ),
        ),
      );
    const existingKeys = new Set(existingRows.map((row) => `${row.sourceType}:${row.sourceId}`));
    const activeCountRows = await transaction
      .select({ count: sql<number>`count(*)::integer` })
      .from(knowledgeAnalysisSources)
      .where(
        and(
          eq(knowledgeAnalysisSources.workspaceId, workspaceId),
          isNull(knowledgeAnalysisSources.removedAt),
        ),
      );
    const newCount = input.sources.filter(
      (source) => !existingKeys.has(`${source.sourceType}:${source.sourceId}`),
    ).length;
    if ((activeCountRows[0]?.count ?? 0) + newCount > KNOWLEDGE_ANALYSIS_MAX_SOURCES) {
      throw new KnowledgeWorkspaceConflictError(
        `工作区最多可保存 ${String(KNOWLEDGE_ANALYSIS_MAX_SOURCES)} 项背景资料。`,
      );
    }
    const created: string[] = [];
    const existing: string[] = [];
    for (const source of input.sources) {
      const key = `${source.sourceType}:${source.sourceId}`;
      if (existingKeys.has(key)) {
        existing.push(key);
        continue;
      }
      await transaction.insert(knowledgeAnalysisSources).values({
        addedByUserId: actorUserId,
        caseId: source.sourceType === "case" ? source.sourceId : null,
        contentHash: source.contentHash,
        knowledgeBatchId: source.batchId,
        lectureId: source.sourceType === "lecture" ? source.sourceId : null,
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        workspaceId,
      });
      created.push(key);
    }
    await transaction
      .update(knowledgeAnalysisWorkspaces)
      .set({ updatedAt: new Date() })
      .where(eq(knowledgeAnalysisWorkspaces.id, workspaceId));
    return { created, existing };
  });
}

export async function removeKnowledgeWorkspaceSource(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  untrustedSourceId: string,
): Promise<void> {
  const sourceId = KnowledgeAnalysisSourceIdSchema.parse(untrustedSourceId);
  await requireMembership(database, actorUserId, workspaceId, "add_sources");
  const updated = await database
    .update(knowledgeAnalysisSources)
    .set({ removedAt: new Date(), removedByUserId: actorUserId })
    .where(
      and(
        eq(knowledgeAnalysisSources.id, sourceId),
        eq(knowledgeAnalysisSources.workspaceId, workspaceId),
        isNull(knowledgeAnalysisSources.removedAt),
      ),
    )
    .returning({ id: knowledgeAnalysisSources.id });
  if (updated.length !== 1) throw new KnowledgeWorkspaceNotFoundError();
}

export async function createKnowledgeConversation(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  untrustedInput: unknown,
): Promise<{ id: string }> {
  const input = CreateKnowledgeConversationInputSchema.parse(untrustedInput);
  await requireMembership(database, actorUserId, workspaceId, "create_conversation");
  const id = randomUUID();
  await database.insert(knowledgeAnalysisConversations).values({
    createdByUserId: actorUserId,
    id,
    title: input.title,
    workspaceId,
  });
  return { id };
}

async function latestReferencesForSources(
  database: Database,
  sources: Array<{ sourceId: string; sourceType: "lecture" | "case" }>,
): Promise<Map<string, KnowledgeSourceReference>> {
  const batchRows = await database
    .select({ id: knowledgeImportBatches.id })
    .from(knowledgeImportBatches)
    .where(eq(knowledgeImportBatches.status, "published"))
    .orderBy(desc(knowledgeImportBatches.publishedAt))
    .limit(1);
  const batchId = batchRows[0]?.id;
  const output = new Map<string, KnowledgeSourceReference>();
  if (batchId === undefined) return output;
  const lectureIds = sources
    .filter((source) => source.sourceType === "lecture")
    .map((source) => source.sourceId);
  const caseIds = sources
    .filter((source) => source.sourceType === "case")
    .map((source) => source.sourceId);
  if (lectureIds.length > 0) {
    const rows = await database
      .select({ hash: sourceDocuments.contentHash, id: knowledgeLectureVersions.lectureId })
      .from(knowledgeLectureVersions)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeLectureVersions.sourceDocumentId))
      .where(
        and(
          eq(knowledgeLectureVersions.batchId, batchId),
          inArray(knowledgeLectureVersions.lectureId, lectureIds),
        ),
      );
    for (const row of rows)
      output.set(`lecture:${row.id}`, {
        batchId,
        contentHash: row.hash,
        sourceId: row.id,
        sourceType: "lecture",
      });
  }
  if (caseIds.length > 0) {
    const rows = await database
      .select({ hash: sourceDocuments.contentHash, id: knowledgeCaseVersions.caseId })
      .from(knowledgeCaseVersions)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeCaseVersions.sourceDocumentId))
      .where(
        and(
          eq(knowledgeCaseVersions.batchId, batchId),
          inArray(knowledgeCaseVersions.caseId, caseIds),
        ),
      );
    for (const row of rows)
      output.set(`case:${row.id}`, {
        batchId,
        contentHash: row.hash,
        sourceId: row.id,
        sourceType: "case",
      });
  }
  return output;
}

export async function listKnowledgeSourceCatalog(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  sourceType: "lecture" | "case",
): Promise<KnowledgeSourceCatalogItem[]> {
  await requireMembership(database, actorUserId, workspaceId, "add_sources");
  const batchRows = await database
    .select({ id: knowledgeImportBatches.id })
    .from(knowledgeImportBatches)
    .where(eq(knowledgeImportBatches.status, "published"))
    .orderBy(desc(knowledgeImportBatches.publishedAt))
    .limit(1);
  const batchId = batchRows[0]?.id;
  if (batchId === undefined) return [];

  const existingRows = await database
    .select({ sourceId: knowledgeAnalysisSources.sourceId })
    .from(knowledgeAnalysisSources)
    .where(
      and(
        eq(knowledgeAnalysisSources.workspaceId, workspaceId),
        eq(knowledgeAnalysisSources.sourceType, sourceType),
        isNull(knowledgeAnalysisSources.removedAt),
      ),
    );
  const existingIds = new Set(existingRows.map((row) => row.sourceId));

  if (sourceType === "lecture") {
    const rows = await database
      .select({
        sourceId: knowledgeLectureVersions.lectureId,
        summary: knowledgeLectureVersions.summary,
        title: knowledgeLectureVersions.title,
      })
      .from(knowledgeLectureVersions)
      .where(eq(knowledgeLectureVersions.batchId, batchId))
      .orderBy(asc(knowledgeLectureVersions.title), asc(knowledgeLectureVersions.lectureId));
    return rows.map((row) => ({
      alreadyAdded: existingIds.has(row.sourceId),
      sourceId: row.sourceId,
      sourceType,
      summary: row.summary,
      title: row.title,
    }));
  }

  const rows = await database
    .select({
      sourceId: knowledgeCaseVersions.caseId,
      summary: knowledgeCaseVersions.profileSummary,
      title: knowledgeCaseVersions.academicLabel,
    })
    .from(knowledgeCaseVersions)
    .where(eq(knowledgeCaseVersions.batchId, batchId))
    .orderBy(asc(knowledgeCaseVersions.academicLabel), asc(knowledgeCaseVersions.caseId));
  return rows.map((row) => ({
    alreadyAdded: existingIds.has(row.sourceId),
    sourceId: row.sourceId,
    sourceType,
    summary: row.summary || "该案例暂无摘要。",
    title: row.title || "匿名案例",
  }));
}

export async function resolveCurrentKnowledgeSourceReferences(
  database: Database,
  sources: Array<{ sourceId: string; sourceType: "lecture" | "case" }>,
): Promise<KnowledgeSourceReference[]> {
  const references = await latestReferencesForSources(database, sources);
  return sources.map((source) => {
    const reference = references.get(`${source.sourceType}:${source.sourceId}`);
    if (reference === undefined) throw new KnowledgeWorkspaceNotFoundError();
    return reference;
  });
}

export async function resolveCurrentKnowledgeSourceReference(
  database: Database,
  sourceType: "lecture" | "case",
  sourceId: string,
): Promise<KnowledgeSourceReference> {
  const reference = (
    await resolveCurrentKnowledgeSourceReferences(database, [{ sourceId, sourceType }])
  )[0];
  if (reference === undefined) throw new KnowledgeWorkspaceNotFoundError();
  return reference;
}

export async function listKnowledgeWorkspaceShareCandidates(
  database: Database,
  actorUserId: string,
  workspaceId: string,
): Promise<
  Array<{ displayName: string; email: string; id: string; role: "admin" | "advisor" | "auditor" }>
> {
  await requireMembership(database, actorUserId, workspaceId, "manage_members");
  const rows = await database
    .select({
      displayName: appUsers.displayName,
      email: appUsers.email,
      id: appUsers.id,
      role: appUsers.role,
    })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.active, true),
        or(eq(appUsers.role, "admin"), eq(appUsers.role, "advisor"), eq(appUsers.role, "auditor")),
      ),
    )
    .orderBy(appUsers.displayName);
  return rows.flatMap((row) => (row.role === "service" ? [] : [{ ...row, role: row.role }]));
}

export async function listKnowledgeWorkspaceSourceUpdates(
  database: Database,
  actorUserId: string,
  workspaceId: string,
): Promise<Array<{ currentSourceId: string; latest: KnowledgeSourceReference }>> {
  await requireMembership(database, actorUserId, workspaceId, "read");
  const sources = await database
    .select({
      id: knowledgeAnalysisSources.id,
      batchId: knowledgeAnalysisSources.knowledgeBatchId,
      contentHash: knowledgeAnalysisSources.contentHash,
      sourceId: knowledgeAnalysisSources.sourceId,
      sourceType: knowledgeAnalysisSources.sourceType,
    })
    .from(knowledgeAnalysisSources)
    .where(
      and(
        eq(knowledgeAnalysisSources.workspaceId, workspaceId),
        isNull(knowledgeAnalysisSources.removedAt),
      ),
    );
  const latest = await latestReferencesForSources(database, sources);
  return sources.flatMap((source) => {
    const reference = latest.get(`${source.sourceType}:${source.sourceId}`);
    return reference !== undefined &&
      (reference.batchId !== source.batchId || reference.contentHash !== source.contentHash)
      ? [{ currentSourceId: source.id, latest: reference }]
      : [];
  });
}

export async function updateKnowledgeWorkspaceSourceVersion(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  currentSourceId: string,
  latestReference: KnowledgeSourceReference,
): Promise<{ id: string }> {
  const currentId = KnowledgeAnalysisSourceIdSchema.parse(currentSourceId);
  await requireMembership(database, actorUserId, workspaceId, "add_sources");
  return database.transaction(async (transaction) => {
    const currentRows = await transaction
      .select()
      .from(knowledgeAnalysisSources)
      .where(
        and(
          eq(knowledgeAnalysisSources.id, currentId),
          eq(knowledgeAnalysisSources.workspaceId, workspaceId),
          isNull(knowledgeAnalysisSources.removedAt),
        ),
      )
      .limit(1);
    const current = currentRows[0];
    if (
      current === undefined ||
      current.sourceType !== latestReference.sourceType ||
      current.sourceId !== latestReference.sourceId
    ) {
      throw new KnowledgeWorkspaceNotFoundError();
    }
    const now = new Date();
    await transaction
      .update(knowledgeAnalysisSources)
      .set({ removedAt: now, removedByUserId: actorUserId })
      .where(eq(knowledgeAnalysisSources.id, current.id));
    const id = randomUUID();
    await transaction.insert(knowledgeAnalysisSources).values({
      addedByUserId: actorUserId,
      caseId: latestReference.sourceType === "case" ? latestReference.sourceId : null,
      contentHash: latestReference.contentHash,
      id,
      knowledgeBatchId: latestReference.batchId,
      lectureId: latestReference.sourceType === "lecture" ? latestReference.sourceId : null,
      sourceId: latestReference.sourceId,
      sourceType: latestReference.sourceType,
      supersedesSourceId: current.id,
      workspaceId,
    });
    return { id };
  });
}
