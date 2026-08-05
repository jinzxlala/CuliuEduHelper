"use client";

import { useState, type JSX } from "react";

interface WorkspaceOption {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "archived";
}

export function AddToWorkspaceButton({
  sourceId,
  sourceType,
}: Readonly<{ sourceId: string; sourceType: "lecture" | "case" }>): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/analysis/workspaces", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取工作区。");
      const items = (await response.json()) as WorkspaceOption[];
      const editable = items.filter((item) => item.status === "active" && item.role !== "viewer");
      setWorkspaces(editable);
      setWorkspaceId(editable[0]?.id ?? "");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    if (workspaceId === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/analysis/workspaces/${workspaceId}/sources`, {
        body: JSON.stringify({ sources: [{ sourceId, sourceType }] }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        created?: string[];
        existing?: string[];
        message?: string;
      };
      if (!response.ok) throw new Error(payload.message ?? "无法加入工作区。");
      setMessage((payload.existing?.length ?? 0) > 0 ? "该版本已在工作区中。" : "已加入工作区。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }

  if (workspaces === null)
    return (
      <span className="workspace-add-control">
        <button disabled={busy} onClick={() => void load()} type="button">
          添加到工作区
        </button>
        {message === null ? null : <small>{message}</small>}
      </span>
    );
  return (
    <span className="workspace-add-control">
      {workspaces.length === 0 ? (
        <small>请先创建可编辑的分析工作区。</small>
      ) : (
        <>
          <select
            aria-label="选择分析工作区"
            onChange={(event) => {
              setWorkspaceId(event.target.value);
            }}
            value={workspaceId}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={() => void add()} type="button">
            加入
          </button>
        </>
      )}
      {message === null ? null : <small>{message}</small>}
    </span>
  );
}
