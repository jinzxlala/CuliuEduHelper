"use client";

import { useRouter } from "next/navigation";
import { type JSX, useState } from "react";

export function EvidenceInvalidateButton({
  evidenceId,
  studentId,
}: Readonly<{ evidenceId: string; studentId: string }>): JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function invalidate(): Promise<void> {
    const reason = window.prompt("请输入失效原因。原文件不会被覆盖或删除：");
    if (reason === null || reason.trim() === "") return;
    setPending(true);
    try {
      const response = await fetch(`/api/students/${studentId}/evidence/${evidenceId}/invalidate`, {
        body: JSON.stringify({ reason }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) window.alert(`失效操作失败（${String(response.status)}）`);
      else router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      className="link-button danger-link"
      disabled={pending}
      onClick={() => void invalidate()}
    >
      {pending ? "处理中…" : "标记失效"}
    </button>
  );
}
