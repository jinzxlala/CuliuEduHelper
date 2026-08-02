"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type JSX } from "react";

interface Item {
  claimIds: string[];
  courseVersionId: string;
  expectedOutcome: string;
  knowledgeLink: string;
  offeringVersionIds: string[];
  rationale: string;
  risk: string;
}
interface Recommendation {
  createdAt: string;
  id: string;
  output: { alternative: Item; recommendations: Item[] };
  status: string;
}

export function CourseRecommendations({ studentId }: { studentId: string }): JSX.Element {
  const [items, setItems] = useState<Recommendation[]>([]);
  const [message, setMessage] = useState("");
  const endpoint = `/api/students/${studentId}/recommendations`;
  const refresh = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (response.ok) setItems((await response.json()) as Recommendation[]);
  }, [endpoint]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function generate(): Promise<void> {
    setMessage("已提交规则筛选与推荐任务……");
    const response = await fetch(endpoint, { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) {
      setMessage(body.message ?? "无法生成推荐，请确认画像和课程目录状态。");
      return;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refresh();
    }
    setMessage("任务仍在后台处理；稍后刷新可查看结果。");
  }

  async function decide(id: string, decision: "accepted" | "rejected"): Promise<void> {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ decision, recommendationId: id }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    setMessage(response.ok ? "审核状态已更新。" : "审核失败，请刷新后重试。");
    await refresh();
  }

  return (
    <section className="editor-panel">
      <h2>画像驱动课程推荐</h2>
      <p>
        系统先执行先修、重复课程和互斥等硬规则，再让 DeepSeek 只在合格课程和班级中生成解释草稿。
      </p>
      <button onClick={() => void generate()} type="button">
        根据当前批准画像生成推荐草稿
      </button>
      {message && <p className="status-note">{message}</p>}
      {items.map((record) => (
        <article className="fact-card" key={record.id}>
          <p>
            <strong>{record.status}</strong> · {new Date(record.createdAt).toLocaleString("zh-CN")}
          </p>
          {record.output.recommendations.map((item) => (
            <div key={item.courseVersionId}>
              <h3>课程版本 {item.courseVersionId}</h3>
              <p>{item.rationale}</p>
              <p>知识衔接：{item.knowledgeLink}</p>
              <p>预期成果：{item.expectedOutcome}</p>
              <p>风险：{item.risk}</p>
              <p>
                {item.offeringVersionIds.length === 0
                  ? "当前无可选班级"
                  : `可选班级：${item.offeringVersionIds.join("、")}`}
              </p>
            </div>
          ))}
          <h3>替代路径</h3>
          <p>{record.output.alternative.rationale}</p>
          {record.status === "draft" && (
            <div className="button-row">
              <button onClick={() => void decide(record.id, "accepted")} type="button">
                接受并用于规划
              </button>
              <button
                className="secondary"
                onClick={() => void decide(record.id, "rejected")}
                type="button"
              >
                拒绝
              </button>
            </div>
          )}
          {record.status === "accepted" && (
            <Link href={`/students/${studentId}/planning?recommendation=${record.id}`}>
              进入人工课程规划工作台
            </Link>
          )}
        </article>
      ))}
    </section>
  );
}
