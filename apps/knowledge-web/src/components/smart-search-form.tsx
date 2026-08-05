"use client";

import Link from "next/link";
import { useEffect, useState, type JSX, type SyntheticEvent } from "react";

import { AddToWorkspaceButton } from "./add-to-workspace-button";

interface SmartResultReference {
  matchedTerms: string[];
  rationale: string;
  sourceId: string;
  sourceType: "lecture" | "case";
}

interface SmartSearchRun {
  progressStage: string;
  queryPlan: { rounds?: Array<{ interpretation?: string }> } | null;
  resultReferences: SmartResultReference[];
  safeErrorSummary: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: string | null;
}

const stageLabels: Record<string, string> = {
  failed: "失败",
  planning: "正在理解需求并规划查询",
  queued: "等待 Worker 领取任务",
  reranking: "正在基于候选资料筛选与排序",
  retrieving: "正在执行关键词与混合检索",
  succeeded: "完成",
};

export function SmartSearchForm(): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<SmartSearchRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (runId === null || run?.status === "succeeded" || run?.status === "failed") return;
    const timer = window.setInterval(() => {
      void fetch(`/api/smart-search?id=${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("status_failed");
          return (await response.json()) as SmartSearchRun;
        })
        .then(setRun)
        .catch(() => {
          setError("暂时无法读取任务状态，请稍后刷新。");
        });
    }, 1_200);
    return () => {
      window.clearInterval(timer);
    };
  }, [run?.status, runId]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setRun(null);
    try {
      const response = await fetch("/api/smart-search", {
        body: JSON.stringify({ prompt }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; runId?: string };
      if (!response.ok || payload.runId === undefined) {
        throw new Error(payload.message ?? "智能搜索暂时不可用。");
      }
      setRunId(payload.runId);
      setRun({
        progressStage: "queued",
        queryPlan: null,
        resultReferences: [],
        safeErrorSummary: null,
        status: "queued",
        summary: null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "智能搜索暂时不可用。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form className="smart-search-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="smart-search-prompt">用自然语言说明你想找什么</label>
        <textarea
          id="smart-search-prompt"
          maxLength={1000}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
          placeholder="例如：寻找适合人工智能与经济学交叉方向学生参考的案例，优先有具体项目路径和证据边界。"
          required
          rows={5}
          value={prompt}
        />
        <div className="form-toolbar">
          <span>{prompt.length}/1000</span>
          <button disabled={submitting || prompt.trim() === ""} type="submit">
            {submitting ? "正在提交……" : "开始智能搜索"}
          </button>
        </div>
      </form>
      {error === null ? null : (
        <div className="notice error-notice">
          <p>{error}</p>
          <Link href="/search">改用普通关键词搜索</Link>
        </div>
      )}
      {run === null ? null : (
        <section aria-live="polite" className="smart-search-status">
          <p className="eyebrow">任务状态</p>
          <h2>{stageLabels[run.progressStage] ?? run.progressStage}</h2>
          {run.queryPlan?.rounds?.map((round, index) =>
            round.interpretation === undefined ? null : <p key={index}>{round.interpretation}</p>,
          )}
          {run.safeErrorSummary === null ? null : (
            <p className="error-text">{run.safeErrorSummary}</p>
          )}
          {run.summary === null ? null : <p className="smart-search-summary">{run.summary}</p>}
          <div className="smart-result-grid">
            {run.resultReferences.map((result) => (
              <article
                className="smart-result-card"
                key={`${result.sourceType}:${result.sourceId}`}
              >
                <p className="eyebrow">{result.sourceType === "lecture" ? "讲座" : "匿名案例"}</p>
                <h3>{result.sourceId}</h3>
                <p>{result.rationale}</p>
                {result.matchedTerms.length === 0 ? null : (
                  <p>匹配词：{result.matchedTerms.join("、")}</p>
                )}
                <Link
                  href={
                    result.sourceType === "lecture"
                      ? `/knowledge/lectures/${result.sourceId}`
                      : `/knowledge/cases/${result.sourceId}`
                  }
                >
                  查看来源
                </Link>
                <AddToWorkspaceButton sourceId={result.sourceId} sourceType={result.sourceType} />
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
