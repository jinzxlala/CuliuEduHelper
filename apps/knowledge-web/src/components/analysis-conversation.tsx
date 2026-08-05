"use client";

import Link from "next/link";
import { useEffect, useState, type JSX, type SyntheticEvent } from "react";

interface Citation {
  claim: string;
  source: { sourceId: string; sourceType: "lecture" | "case" };
}
interface Message {
  citations: Citation[];
  contentMarkdown: string;
  id: string;
  role: "user" | "assistant";
  sequence: number;
}
interface Run {
  id: string;
  safeErrorSummary: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
}
interface ConversationState {
  messages: Message[];
  runs: Run[];
}

export function AnalysisConversation({
  initial,
  role,
  workspaceId,
  conversationId,
}: Readonly<{
  initial: ConversationState;
  role: "owner" | "editor" | "viewer";
  workspaceId: string;
  conversationId: string;
}>): JSX.Element {
  const [state, setState] = useState(initial);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = state.runs.some((run) => run.status === "queued" || run.status === "running");
  const latestRun = state.runs[0];
  const endpoint = `/api/analysis/workspaces/${workspaceId}/conversations/${conversationId}/messages`;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void fetch(endpoint, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("无法读取对话状态。");
          return (await response.json()) as ConversationState;
        })
        .then(setState)
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "状态读取失败。");
        });
    }, 1_200);
    return () => {
      window.clearInterval(timer);
    };
  }, [active, endpoint]);

  async function send(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await fetch(endpoint, {
      body: JSON.stringify({ content }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      const payload = (await response.json()) as { message?: string };
      setError(payload.message ?? "无法发送消息。");
      return;
    }
    setContent("");
    const refreshed = await fetch(endpoint, { cache: "no-store" });
    if (refreshed.ok) setState((await refreshed.json()) as ConversationState);
  }

  return (
    <>
      <section className="conversation-thread">
        {state.messages.map((message) => (
          <article className={`conversation-message ${message.role}`} key={message.id}>
            <p className="eyebrow">{message.role === "user" ? "使用者" : "DeepSeek 分析"}</p>
            <div className="markdown-safe-text">{message.contentMarkdown}</div>
            {message.citations.length === 0 ? null : (
              <ul className="citation-list">
                {message.citations.map((citation, index) => (
                  <li key={`${message.id}:${String(index)}`}>
                    {citation.claim} ·{" "}
                    <Link
                      href={
                        citation.source.sourceType === "lecture"
                          ? `/knowledge/lectures/${citation.source.sourceId}`
                          : `/knowledge/cases/${citation.source.sourceId}`
                      }
                    >
                      {citation.source.sourceId}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
        {active ? (
          <div className="notice">分析任务正在运行；当前对话在完成前不会接受下一条消息。</div>
        ) : null}
        {latestRun?.status === "failed" && latestRun.safeErrorSummary ? (
          <p className="error-text">{latestRun.safeErrorSummary}</p>
        ) : null}
      </section>
      {role === "viewer" ? (
        <div className="notice">你当前拥有只读权限。</div>
      ) : (
        <form className="conversation-composer" onSubmit={(event) => void send(event)}>
          <label htmlFor="analysis-message">继续分析</label>
          <textarea
            id="analysis-message"
            maxLength={20000}
            onChange={(event) => {
              setContent(event.target.value);
            }}
            placeholder="提出问题、比较要求或希望核实的判断……"
            required
            rows={5}
            value={content}
          />
          <button disabled={active || content.trim() === ""} type="submit">
            发送并分析
          </button>
          {error === null ? null : <p className="error-text">{error}</p>}
        </form>
      )}
    </>
  );
}
