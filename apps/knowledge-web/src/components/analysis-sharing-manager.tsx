"use client";

import { useRouter } from "next/navigation";
import { useState, type JSX, type SyntheticEvent } from "react";

interface Member {
  displayName: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  userId: string;
}
interface Candidate {
  displayName: string;
  email: string;
  id: string;
  role: "admin" | "advisor" | "auditor";
}

export function AnalysisSharingManager({
  candidates,
  members,
  role,
  status,
  workspaceId,
}: Readonly<{
  candidates: Candidate[];
  members: Member[];
  role: "owner" | "editor" | "viewer";
  status: "active" | "archived";
  workspaceId: string;
}>): JSX.Element {
  const router = useRouter();
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedRole, setSelectedRole] = useState<"editor" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(method: "PUT" | "DELETE", bodyOrQuery: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/analysis/workspaces/${workspaceId}/members${
          method === "DELETE" ? `?userId=${encodeURIComponent(String(bodyOrQuery))}` : ""
        }`,
        {
          ...(method === "PUT"
            ? { body: JSON.stringify(bodyOrQuery), headers: { "Content-Type": "application/json" } }
            : {}),
          method,
        },
      );
      const payload = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "操作失败。");
      setSelectedUser("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function share(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await request("PUT", { role: selectedRole, userId: selectedUser });
  }

  const available = candidates.filter(
    (candidate) => !members.some((member) => member.userId === candidate.id),
  );
  return (
    <section className="analysis-panel sharing-manager">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">内部协作</p>
          <h2>共享成员</h2>
        </div>
        <span>{members.length}</span>
      </div>
      <p className="muted-copy">只可共享给系统内已有账号；查看者不能修改资料或发起模型任务。</p>
      <ul className="analysis-member-list">
        {members.map((member) => (
          <li key={member.userId}>
            <span>
              <strong>{member.displayName}</strong>
              <small>{member.email}</small>
            </span>
            <span className="role-badge">{member.role}</span>
            {role === "owner" && member.role !== "owner" ? (
              <button
                className="secondary-button compact-button"
                disabled={busy}
                onClick={() => void request("DELETE", member.userId)}
                type="button"
              >
                撤销共享
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {role === "owner" && status === "active" ? (
        <form className="share-form" onSubmit={(event) => void share(event)}>
          <label>
            内部账号
            <select
              onChange={(event) => {
                setSelectedUser(event.target.value);
              }}
              required
              value={selectedUser}
            >
              <option value="">请选择</option>
              {available.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName} · {candidate.email} ({candidate.role})
                </option>
              ))}
            </select>
          </label>
          <label>
            权限
            <select
              onChange={(event) => {
                setSelectedRole(event.target.value as "editor" | "viewer");
              }}
              value={selectedRole}
            >
              <option value="viewer">只读查看</option>
              <option value="editor">可编辑</option>
            </select>
          </label>
          <button className="primary-button" disabled={busy || selectedUser === ""} type="submit">
            {busy ? "正在保存……" : "添加共享"}
          </button>
        </form>
      ) : null}
      {error === null ? null : <p className="error-text">{error}</p>}
    </section>
  );
}
