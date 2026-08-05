"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type JSX, type SyntheticEvent } from "react";

interface Member {
  displayName: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  userId: string;
}
interface Source {
  contentHash: string;
  createdAt: string;
  id: string;
  knowledgeBatchId: string;
  removedAt: string | null;
  sourceId: string;
  sourceType: "lecture" | "case";
}
interface Conversation {
  id: string;
  status: "active" | "archived";
  title: string;
  updatedAt: string;
}
interface Candidate {
  displayName: string;
  email: string;
  id: string;
  role: "admin" | "advisor" | "auditor";
}

export function AnalysisWorkspaceDetail(
  props: Readonly<{
    candidates: Candidate[];
    conversations: Conversation[];
    members: Member[];
    role: "owner" | "editor" | "viewer";
    sources: Source[];
    status: "active" | "archived";
    workspaceId: string;
  }>,
): JSX.Element {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedRole, setSelectedRole] = useState<"editor" | "viewer">("viewer");
  const editable = props.status === "active" && props.role !== "viewer";

  async function request(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(path, {
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
      method,
    });
    const payload = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(payload.message ?? "操作失败。");
    router.refresh();
    return payload;
  }

  async function createConversation(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const payload = (await request(
        `/api/analysis/workspaces/${props.workspaceId}/conversations`,
        "POST",
        { title: conversationTitle },
      )) as { id: string };
      router.push(`/analysis/${props.workspaceId}/conversations/${payload.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    }
  }

  async function share(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await request(`/api/analysis/workspaces/${props.workspaceId}/members`, "PUT", {
        role: selectedRole,
        userId: selectedUser,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    }
  }

  return (
    <>
      {error === null ? null : <p className="error-text">{error}</p>}
      <div className="analysis-dashboard-grid">
        <section className="analysis-panel">
          <h2>
            背景资料{" "}
            <span>{props.sources.filter((source) => source.removedAt === null).length}/100</span>
          </h2>
          {props.sources.length === 0 ? (
            <p>尚未加入资料。可从关键词搜索或智能搜索结果加入。</p>
          ) : (
            <ul className="analysis-item-list">
              {props.sources.map((source) => (
                <li className={source.removedAt === null ? "" : "archived-item"} key={source.id}>
                  <div>
                    <strong>{source.sourceType === "lecture" ? "讲座" : "案例"}</strong>
                    <code>{source.sourceId}</code>
                  </div>
                  <small>版本 {source.contentHash.slice(0, 10)}…</small>
                  {source.removedAt === null && editable ? (
                    <button
                      onClick={() =>
                        void request(
                          `/api/analysis/workspaces/${props.workspaceId}/sources?sourceRecordId=${source.id}`,
                          "DELETE",
                        ).catch((cause: unknown) => {
                          setError(cause instanceof Error ? cause.message : "操作失败。");
                        })
                      }
                      type="button"
                    >
                      移出工作区
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="analysis-panel">
          <h2>
            对话 <span>{props.conversations.length}/50</span>
          </h2>
          {editable ? (
            <form onSubmit={(event) => void createConversation(event)}>
              <label>
                新对话名称
                <input
                  maxLength={200}
                  onChange={(event) => {
                    setConversationTitle(event.target.value);
                  }}
                  required
                  value={conversationTitle}
                />
              </label>
              <button type="submit">创建并进入对话</button>
            </form>
          ) : null}
          <ul className="analysis-item-list">
            {props.conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link href={`/analysis/${props.workspaceId}/conversations/${conversation.id}`}>
                  {conversation.title}
                </Link>
                <small>{conversation.status}</small>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="analysis-panel">
        <h2>共享成员</h2>
        <ul className="analysis-member-list">
          {props.members.map((member) => (
            <li key={member.userId}>
              <span>
                {member.displayName} · {member.email}
              </span>
              <strong>{member.role}</strong>
              {props.role === "owner" && member.role !== "owner" ? (
                <button
                  onClick={() =>
                    void request(
                      `/api/analysis/workspaces/${props.workspaceId}/members?userId=${member.userId}`,
                      "DELETE",
                    ).catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : "操作失败。");
                    })
                  }
                  type="button"
                >
                  撤销共享
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {props.role === "owner" && props.status === "active" ? (
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
                {props.candidates
                  .filter(
                    (candidate) => !props.members.some((member) => member.userId === candidate.id),
                  )
                  .map((candidate) => (
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
            <button type="submit">共享</button>
          </form>
        ) : null}
      </section>
      {props.role === "owner" && props.status === "active" ? (
        <button
          className="danger-action"
          onClick={() =>
            void request(`/api/analysis/workspaces/${props.workspaceId}`, "PATCH", {
              action: "archive",
            }).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "操作失败。");
            })
          }
          type="button"
        >
          归档工作区
        </button>
      ) : null}
    </>
  );
}
