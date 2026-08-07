"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type JSX, type SyntheticEvent } from "react";

import { AddToWorkspaceButton } from "./add-to-workspace-button";
import { BulkWorkspaceAdd, WorkspaceSelectionCheckbox } from "./bulk-workspace-add";

interface SmartResultReference {
  matchedTerms: string[];
  rationale: string;
  sourceId: string;
  sourceType: "lecture" | "case";
}

interface SmartSearchRun {
  createdAt: string;
  progressStage: string;
  prompt: string;
  queryPlan: { rounds?: Array<{ interpretation?: string }> } | null;
  resultReferences: SmartResultReference[];
  safeErrorSummary: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: string | null;
}

interface SmartSearchHistoryItem {
  createdAt: string;
  id: string;
  prompt: string;
  resultCount: number;
  status: SmartSearchRun["status"];
}

const stageLabels: Record<string, string> = {
  failed: "失败",
  planning: "正在理解需求并规划查询",
  queued: "等待 Worker 领取任务",
  reranking: "正在基于候选资料筛选与排序",
  retrieving: "正在执行关键词与混合检索",
  succeeded: "完成",
};

const historyStatusLabels: Record<SmartSearchRun["status"], string> = {
  failed: "失败",
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
};

export function SmartSearchForm({
  initialRunId,
}: Readonly<{ initialRunId: string | null }>): JSX.Element {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [run, setRun] = useState<SmartSearchRun | null>(null);
  const [history, setHistory] = useState<SmartSearchHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshHistory = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/smart-search", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取搜索历史。");
    setHistory((await response.json()) as SmartSearchHistoryItem[]);
  }, []);

  const loadRun = useCallback(async (id: string): Promise<void> => {
    const response = await fetch(`/api/smart-search?id=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("无法读取这次搜索结果。");
    const loaded = (await response.json()) as SmartSearchRun;
    setRun(loaded);
    setPrompt(loaded.prompt);
  }, []);

  useEffect(() => {
    void refreshHistory().catch(() => {
      setError("暂时无法读取搜索历史。");
    });
  }, [refreshHistory]);

  useEffect(() => {
    if (runId === null) {
      setRun(null);
      return;
    }
    void loadRun(runId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "无法读取这次搜索结果。");
    });
  }, [loadRun, runId]);

  useEffect(() => {
    if (runId === null || run?.status === "succeeded" || run?.status === "failed") return;
    const timer = window.setInterval(() => {
      void loadRun(runId)
        .then(async () => refreshHistory())
        .catch(() => {
          setError("暂时无法读取任务状态，请稍后刷新。");
        });
    }, 1_200);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadRun, refreshHistory, run?.status, runId]);

  function selectHistory(id: string): void {
    setError(null);
    setRunId(id);
    router.push(`/smart-search?run=${encodeURIComponent(id)}`);
  }

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
      if (!response.ok || payload.runId === undefined)
        throw new Error(payload.message ?? "智能搜索暂时不可用。");
      setRunId(payload.runId);
      router.push(`/smart-search?run=${encodeURIComponent(payload.runId)}`);
      setRun({
        createdAt: new Date().toISOString(),
        progressStage: "queued",
        prompt,
        queryPlan: null,
        resultReferences: [],
        safeErrorSummary: null,
        status: "queued",
        summary: null,
      });
      await refreshHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "智能搜索暂时不可用。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="smart-search-layout">
      <aside className="smart-search-history" aria-label="智能搜索历史">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">最近记录</p>
            <h2>搜索历史</h2>
          </div>
          <span>{history.length}</span>
        </div>
        {history.length === 0 ? (
          <p className="muted-copy">完成一次智能搜索后会保存在这里。</p>
        ) : (
          <ol>
            {history.map((item) => (
              <li key={item.id}>
                <button
                  aria-current={runId === item.id ? "true" : undefined}
                  onClick={() => {
                    selectHistory(item.id);
                  }}
                  type="button"
                >
                  <strong>{item.prompt}</strong>
                  <span>
                    {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                    {historyStatusLabels[item.status]}
                    {item.status === "succeeded" ? ` · ${String(item.resultCount)} 条` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
      <div className="smart-search-main">
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
            <button
              className="primary-button"
              disabled={submitting || prompt.trim() === ""}
              type="submit"
            >
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
            <BulkWorkspaceAdd sources={run.resultReferences}>
              <div className="smart-result-grid">
                {run.resultReferences.map((result) => (
                  <article
                    className="smart-result-card"
                    key={`${result.sourceType}:${result.sourceId}`}
                  >
                    <div className="selectable-result-heading">
                      <p className="eyebrow">
                        {result.sourceType === "lecture" ? "讲座" : "匿名案例"}
                      </p>
                      <WorkspaceSelectionCheckbox
                        sourceId={result.sourceId}
                        sourceType={result.sourceType}
                      />
                    </div>
                    <h3>{result.sourceId}</h3>
                    <p>{result.rationale}</p>
                    {result.matchedTerms.length === 0 ? null : (
                      <p>匹配词：{result.matchedTerms.join("、")}</p>
                    )}
                    <div className="smart-result-actions">
                      <Link
                        className="secondary-button button-link compact-button"
                        href={
                          result.sourceType === "lecture"
                            ? `/knowledge/lectures/${result.sourceId}`
                            : `/knowledge/cases/${result.sourceId}`
                        }
                      >
                        查看来源
                      </Link>
                      <AddToWorkspaceButton
                        sourceId={result.sourceId}
                        sourceType={result.sourceType}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </BulkWorkspaceAdd>
          </section>
        )}
      </div>
    </div>
  );
}
