"use client";

import { useRouter } from "next/navigation";
import { useState, type JSX } from "react";

export function AnalysisNewConversationButton({
  workspaceId,
}: Readonly<{ workspaceId: string }>): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/analysis/workspaces/${workspaceId}/conversations`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { id?: string; message?: string };
      if (!response.ok || payload.id === undefined)
        throw new Error(payload.message ?? "无法创建新对话。");
      router.push(`/analysis/${workspaceId}/conversations/${payload.id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建新对话。");
      setBusy(false);
    }
  }

  return (
    <span className="inline-action-with-message">
      <button
        className="primary-button"
        disabled={busy}
        onClick={() => void create()}
        type="button"
      >
        {busy ? "正在创建……" : "新建对话"}
      </button>
      {error === null ? null : <small className="error-text">{error}</small>}
    </span>
  );
}
