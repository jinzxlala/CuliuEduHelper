import { describe, expect, it } from "vitest";

import {
  selectableWorkspaceSourceIds,
  uniqueWorkspaceSources,
  workspaceSourceKey,
} from "./workspace-source-selection";

describe("bulk workspace source selection", () => {
  it("keeps lecture and case identities separate and removes repeated results", () => {
    const sources = uniqueWorkspaceSources([
      { sourceId: "shared-id", sourceType: "lecture" },
      { sourceId: "shared-id", sourceType: "case" },
      { sourceId: "shared-id", sourceType: "lecture" },
    ]);

    expect(sources).toEqual([
      { sourceId: "shared-id", sourceType: "lecture" },
      { sourceId: "shared-id", sourceType: "case" },
    ]);
    expect(sources.map(workspaceSourceKey)).toEqual(["lecture:shared-id", "case:shared-id"]);
  });

  it("selects all eligible catalog results but skips sources already in the workspace", () => {
    expect(
      selectableWorkspaceSourceIds([
        { alreadyAdded: false, sourceId: "lecture-1" },
        { alreadyAdded: true, sourceId: "lecture-2" },
        { alreadyAdded: false, sourceId: "lecture-1" },
        { alreadyAdded: false, sourceId: "lecture-3" },
      ]),
    ).toEqual(["lecture-1", "lecture-3"]);
  });
});
