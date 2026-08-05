import { describe, expect, it } from "vitest";

import { canPerformKnowledgeWorkspaceAction } from "./permissions.js";

describe("knowledge workspace permissions", () => {
  it("keeps membership management owner-only", () => {
    expect(canPerformKnowledgeWorkspaceAction("owner", "manage_members")).toBe(true);
    expect(canPerformKnowledgeWorkspaceAction("editor", "manage_members")).toBe(false);
    expect(canPerformKnowledgeWorkspaceAction("viewer", "manage_members")).toBe(false);
  });

  it("allows editors to analyze but keeps viewers read-only", () => {
    expect(canPerformKnowledgeWorkspaceAction("editor", "send_message")).toBe(true);
    expect(canPerformKnowledgeWorkspaceAction("editor", "create_report")).toBe(true);
    expect(canPerformKnowledgeWorkspaceAction("viewer", "send_message")).toBe(false);
    expect(canPerformKnowledgeWorkspaceAction("viewer", "download_report")).toBe(true);
  });
});
