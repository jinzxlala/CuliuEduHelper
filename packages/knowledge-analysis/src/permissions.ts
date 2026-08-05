import { KnowledgeWorkspaceRoleSchema, type KnowledgeWorkspaceRole } from "./contracts.js";

export const KnowledgeWorkspaceActionSchema = {
  addSources: "add_sources",
  createConversation: "create_conversation",
  createReport: "create_report",
  downloadReport: "download_report",
  manageMembers: "manage_members",
  manageWorkspace: "manage_workspace",
  read: "read",
  sendMessage: "send_message",
} as const;

export type KnowledgeWorkspaceAction =
  (typeof KnowledgeWorkspaceActionSchema)[keyof typeof KnowledgeWorkspaceActionSchema];

const allowedActions: Readonly<
  Record<KnowledgeWorkspaceRole, readonly KnowledgeWorkspaceAction[]>
> = {
  editor: [
    "read",
    "add_sources",
    "create_conversation",
    "send_message",
    "create_report",
    "download_report",
  ],
  owner: [
    "read",
    "add_sources",
    "create_conversation",
    "send_message",
    "create_report",
    "download_report",
    "manage_members",
    "manage_workspace",
  ],
  viewer: ["read", "download_report"],
};

export function canPerformKnowledgeWorkspaceAction(
  untrustedRole: KnowledgeWorkspaceRole,
  action: KnowledgeWorkspaceAction,
): boolean {
  const role = KnowledgeWorkspaceRoleSchema.parse(untrustedRole);
  return allowedActions[role].includes(action);
}
