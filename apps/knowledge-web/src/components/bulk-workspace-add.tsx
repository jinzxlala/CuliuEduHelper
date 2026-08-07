"use client";

import { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from "react";

import {
  uniqueWorkspaceSources,
  workspaceSourceKey,
  type WorkspaceSourceChoice,
} from "../lib/workspace-source-selection";

interface WorkspaceOption {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "archived";
}

interface SelectionContextValue {
  active: boolean;
  selected: ReadonlySet<string>;
  toggle: (source: WorkspaceSourceChoice, checked: boolean) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function WorkspaceSelectionCheckbox({
  sourceId,
  sourceType,
}: Readonly<WorkspaceSourceChoice>): JSX.Element | null {
  const context = useContext(SelectionContext);
  if (context === null || !context.active) return null;
  const source = { sourceId, sourceType };
  const key = workspaceSourceKey(source);
  return (
    <label className="workspace-result-checkbox">
      <input
        aria-label={`选中${sourceType === "lecture" ? "讲座" : "案例"} ${sourceId}`}
        checked={context.selected.has(key)}
        onChange={(event) => {
          context.toggle(source, event.target.checked);
        }}
        type="checkbox"
      />
      <span>选中</span>
    </label>
  );
}

export function BulkWorkspaceAdd({
  children,
  sources,
}: Readonly<{ children: ReactNode; sources: readonly WorkspaceSourceChoice[] }>): JSX.Element {
  const available = useMemo(() => uniqueWorkspaceSources(sources), [sources]);
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadWorkspaces(): Promise<void> {
    if (workspaces !== null) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/analysis/workspaces", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取工作区。请稍后重试。");
      const editable = ((await response.json()) as WorkspaceOption[]).filter(
        (item) => item.status === "active" && item.role !== "viewer",
      );
      setWorkspaces(editable);
      setWorkspaceId(editable[0]?.id ?? "");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "无法读取工作区。");
    } finally {
      setBusy(false);
    }
  }

  function toggle(source: WorkspaceSourceChoice, checked: boolean): void {
    const key = workspaceSourceKey(source);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function addSelected(): Promise<void> {
    if (workspaceId === "" || selected.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const selectedSources = available.filter((source) =>
        selected.has(workspaceSourceKey(source)),
      );
      const response = await fetch(`/api/analysis/workspaces/${workspaceId}/sources`, {
        body: JSON.stringify({ sources: selectedSources }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        created?: string[];
        existing?: string[];
        message?: string;
      };
      if (!response.ok) throw new Error(payload.message ?? "无法批量加入工作区。");
      const createdCount = payload.created?.length ?? 0;
      const existingCount = payload.existing?.length ?? 0;
      setMessage(
        existingCount === 0
          ? `已加入 ${String(createdCount)} 项资料。`
          : `已加入 ${String(createdCount)} 项；${String(existingCount)} 项原已在工作区，未重复添加。`,
      );
      setSelected(new Set());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "批量添加失败。");
    } finally {
      setBusy(false);
    }
  }

  const context = useMemo<SelectionContextValue>(
    () => ({ active, selected, toggle }),
    [active, selected],
  );

  return (
    <SelectionContext.Provider value={context}>
      <div className={active ? "bulk-workspace-area is-selecting" : "bulk-workspace-area"}>
        <div className="bulk-workspace-toolbar">
          <div>
            <button
              aria-pressed={active}
              className={
                active ? "primary-button compact-button" : "secondary-button compact-button"
              }
              onClick={() => {
                const next = !active;
                setActive(next);
                setMessage(null);
                if (next) void loadWorkspaces();
                else setSelected(new Set());
              }}
              type="button"
            >
              {active ? "退出选中模式" : "批量选择"}
            </button>
            {active ? <strong>已选 {selected.size} 项</strong> : null}
          </div>
          {active ? (
            <div className="bulk-workspace-actions">
              <button
                className="text-button"
                disabled={available.length === 0}
                onClick={() => {
                  setSelected(new Set(available.map(workspaceSourceKey)));
                }}
                type="button"
              >
                全选当前结果
              </button>
              <button
                className="text-button"
                disabled={selected.size === 0}
                onClick={() => {
                  setSelected(new Set());
                }}
                type="button"
              >
                清空选择
              </button>
              {workspaces?.length === 0 ? (
                <span className="muted-copy">请先创建可编辑的工作区。</span>
              ) : (
                <>
                  <select
                    aria-label="选择要加入的分析工作区"
                    disabled={busy || workspaces === null}
                    onChange={(event) => {
                      setWorkspaceId(event.target.value);
                    }}
                    value={workspaceId}
                  >
                    {(workspaces ?? []).map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary-button compact-button"
                    disabled={busy || workspaceId === "" || selected.size === 0}
                    onClick={() => void addSelected()}
                    type="button"
                  >
                    {busy ? "处理中……" : "统一添加到工作区"}
                  </button>
                </>
              )}
            </div>
          ) : null}
          {message === null ? null : <p className="bulk-workspace-message">{message}</p>}
        </div>
        {children}
      </div>
    </SelectionContext.Provider>
  );
}
