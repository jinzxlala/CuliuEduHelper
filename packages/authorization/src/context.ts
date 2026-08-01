import { createHash } from "node:crypto";

import {
  AccessLevelSchema,
  AuthorizationContextSchema,
  type AccessLevel,
  type AuthorizationContext,
  accessLevelRank,
} from "./contracts.js";
import { AuthorizationDeniedError } from "./errors.js";

interface AuthorizationContextHashInput {
  actorUserId: string;
  allowedActions: readonly string[];
  createdAt: Date;
  expiresAt: Date;
  id: string;
  maxAccessLevel: AccessLevel;
  studentId: string | null;
}

export function calculateAuthorizationContextHash(input: AuthorizationContextHashInput): string {
  const canonical = JSON.stringify({
    actorUserId: input.actorUserId,
    allowedActions: [...input.allowedActions].sort(),
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    id: input.id,
    maxAccessLevel: input.maxAccessLevel,
    studentId: input.studentId,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function assertAuthorizationContext(
  rawContext: AuthorizationContext,
  requirement: {
    action: string;
    actorUserId?: string;
    accessLevel: AccessLevel;
    now?: Date;
    studentId: string | null;
  },
): AuthorizationContext {
  const context = AuthorizationContextSchema.parse(rawContext);
  const expectedHash = calculateAuthorizationContextHash(context);
  const now = requirement.now ?? new Date();
  const requestedAccessLevel = AccessLevelSchema.parse(requirement.accessLevel);

  if (
    context.contextHash !== expectedHash ||
    context.expiresAt <= now ||
    context.studentId !== requirement.studentId ||
    (requirement.actorUserId !== undefined && context.actorUserId !== requirement.actorUserId) ||
    !context.allowedActions.includes(requirement.action) ||
    accessLevelRank[context.maxAccessLevel] < accessLevelRank[requestedAccessLevel]
  ) {
    throw new AuthorizationDeniedError();
  }

  return context;
}
