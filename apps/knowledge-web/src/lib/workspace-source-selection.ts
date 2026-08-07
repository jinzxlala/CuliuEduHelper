export interface WorkspaceSourceChoice {
  sourceId: string;
  sourceType: "lecture" | "case";
}

export function workspaceSourceKey(source: WorkspaceSourceChoice): string {
  return `${source.sourceType}:${source.sourceId}`;
}

export function uniqueWorkspaceSources(
  sources: readonly WorkspaceSourceChoice[],
): WorkspaceSourceChoice[] {
  return [
    ...new Map(
      sources.map((source) => [
        workspaceSourceKey(source),
        { sourceId: source.sourceId, sourceType: source.sourceType },
      ]),
    ).values(),
  ];
}

export function selectableWorkspaceSourceIds(
  items: readonly { alreadyAdded: boolean; sourceId: string }[],
): string[] {
  return [...new Set(items.filter((item) => !item.alreadyAdded).map((item) => item.sourceId))];
}
