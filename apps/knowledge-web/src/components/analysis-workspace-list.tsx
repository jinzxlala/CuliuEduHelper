"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type JSX, type SyntheticEvent } from "react";

interface WorkspaceSummary {
  description: string;
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "archived";
  updatedAt: string;
}

export function AnalysisWorkspaceList({
  workspaces,
}: Readonly<{ workspaces: WorkspaceSummary[] }>): JSX.Element {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis/workspaces", {
        body: JSON.stringify({ description, name }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { id?: string };
      if (!response.ok || payload.id === undefined) throw new Error("无法创建工作区。");
      router.push(`/analysis/${payload.id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建工作区。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="workspace-create-form" onSubmit={(event) => void create(event)}>
        <h2>新建分析工作区</h2>
        <label>
          名称
          <input
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
            value={name}
          />
        </label>
        <label>
          说明
          <textarea
            maxLength={2000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            rows={3}
            value={description}
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? "正在创建……" : "创建工作区"}
        </button>
        {error === null ? null : <p className="error-text">{error}</p>}
      </form>
      <section className="workspace-card-grid">
        {workspaces.map((workspace) => (
          <article className="workspace-card" key={workspace.id}>
            <p className="eyebrow">
              {workspace.role} · {workspace.status === "active" ? "进行中" : "已归档"}
            </p>
            <h2>
              <Link href={`/analysis/${workspace.id}`}>{workspace.name}</Link>
            </h2>
            <p>{workspace.description || "尚未填写说明。"}</p>
            <small>最近更新：{new Date(workspace.updatedAt).toLocaleString("zh-CN")}</small>
          </article>
        ))}
      </section>
    </>
  );
}
