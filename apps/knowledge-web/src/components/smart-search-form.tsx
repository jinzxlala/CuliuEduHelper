"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type JSX, type SyntheticEvent } from "react";

import { AddToWorkspaceButton } from "./add-to-workspace-button";
import { BulkWorkspaceAdd, WorkspaceSelectionCheckbox } from "./bulk-workspace-add";

type SmartSearchIntent = "semantic_search" | "catalog_browse" | "count" | "analysis_required";

interface SmartResultReference {
  displaySummary?: string;
  displayTitle?: string;
  matchedTerms: string[];
  rationale: string;
  sourceDate?: string | null;
  sourceId: string;
  sourceType: "lecture" | "case";
}

interface SmartSearchRun {
  appliedConditions: string[];
  caseCount: number | null;
  createdAt: string;
  exactTotal: number | null;
  intent: SmartSearchIntent | null;
  lectureCount: number | null;
  legacyResult: boolean;
  limitations: string[];
  page: number;
  pageSize: number;
  progressStage: string;
  prompt: string;
  queryPlan: { rounds?: Array<{ interpretation?: string }> } | null;
  resultReferences: SmartResultReference[];
  safeErrorStage: string | null;
  safeErrorSummary: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: string | null;
  totalPages: number;
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
  planning: "正在理解需求并识别搜索意图",
  queued: "等待 Worker 领取任务",
  reranking: "正在基于候选资料筛选与排序",
  retrieving: "正在执行知识库检索与确定性计数",
  succeeded: "完成",
};

const intentLabels: Record<SmartSearchIntent, string> = {
  analysis_required: "需要进入分析工作区",
  catalog_browse: "完整目录浏览",
  count: "精确数量查询",
  semantic_search: "主题相关性搜索",
};

const historyStatusLabels: Record<SmartSearchRun["status"], string> = {
  failed: "失败",
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
};

export function SmartSearchForm({
  initialPage,
  initialRunId,
}: Readonly<{ initialPage: number; initialRunId: string | null }>): JSX.Element {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [page, setPage] = useState(initialPage);
  const [run, setRun] = useState<SmartSearchRun | null>(null);
  const [history, setHistory] = useState<SmartSearchHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshHistory = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/smart-search", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取搜索历史。");
    setHistory((await response.json()) as SmartSearchHistoryItem[]);
  }, []);

  const loadRun = useCallback(async (id: string, selectedPage: number): Promise<void> => {
    const response = await fetch(
      `/api/smart-search?id=${encodeURIComponent(id)}&page=${String(selectedPage)}&pageSize=20`,
      { cache: "no-store" },
    );
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
    void loadRun(runId, page).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "无法读取这次搜索结果。");
    });
  }, [loadRun, page, runId]);

  useEffect(() => {
    if (runId === null || run?.status === "succeeded" || run?.status === "failed") return;
    const timer = window.setInterval(() => {
      void loadRun(runId, page)
        .then(async () => refreshHistory())
        .catch(() => {
          setError("暂时无法读取任务状态，请稍后刷新。");
        });
    }, 1_200);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadRun, page, refreshHistory, run?.status, runId]);

  function navigate(id: string, selectedPage: number): void {
    setRunId(id);
    setPage(selectedPage);
    router.push(
      `/smart-search?run=${encodeURIComponent(id)}${selectedPage === 1 ? "" : `&page=${String(selectedPage)}`}`,
    );
  }

  function selectHistory(id: string): void {
    setError(null);
    navigate(id, 1);
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
      if (!response.ok || payload.runId === undefined) {
        throw new Error(payload.message ?? "智能搜索暂时不可用。");
      }
      navigate(payload.runId, 1);
      setRun({
        appliedConditions: [],
        caseCount: null,
        createdAt: new Date().toISOString(),
        exactTotal: null,
        intent: null,
        lectureCount: null,
        legacyResult: false,
        limitations: [],
        page: 1,
        pageSize: 20,
        progressStage: "queued",
        prompt,
        queryPlan: null,
        resultReferences: [],
        safeErrorStage: null,
        safeErrorSummary: null,
        status: "queued",
        summary: null,
        totalPages: 1,
      });
      await refreshHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "智能搜索暂时不可用。");
    } finally {
      setSubmitting(false);
    }
  }

  const firstResult = run === null ? 0 : (run.page - 1) * run.pageSize + 1;
  const lastResult = run === null ? 0 : firstResult + run.resultReferences.length - 1;

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
            placeholder="例如：帮我检索所有2025年内的讲座和学生案例。"
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
            {run.intent === null ? null : (
              <p className="intent-badge">{intentLabels[run.intent]}</p>
            )}
            {run.queryPlan?.rounds?.map((round, index) =>
              round.interpretation === undefined ? null : <p key={index}>{round.interpretation}</p>,
            )}
            {run.safeErrorSummary === null ? null : (
              <p className="error-text">
                {run.safeErrorStage === null ? "" : `失败阶段：${run.safeErrorStage}。`}
                {run.safeErrorSummary}
              </p>
            )}
            {run.summary === null ? null : <p className="smart-search-summary">{run.summary}</p>}
            {run.exactTotal === null ? null : (
              <div className="smart-search-counts">
                <strong>精确总数 {run.exactTotal}</strong>
                <span>讲座 {run.lectureCount ?? 0}</span>
                <span>案例 {run.caseCount ?? 0}</span>
              </div>
            )}
            {run.appliedConditions.length === 0 ? null : (
              <details className="smart-search-conditions">
                <summary>查看实际搜索条件</summary>
                <ul>
                  {run.appliedConditions.map((condition) => (
                    <li key={condition}>{condition}</li>
                  ))}
                </ul>
              </details>
            )}
            {run.limitations.length === 0 ? null : (
              <ul className="smart-search-limitations">
                {run.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            )}
            {run.legacyResult ? (
              <p className="notice">旧版搜索，仅保留当时前 20 条结果，未补造精确总数。</p>
            ) : null}
            {run.intent === "analysis_required" ? (
              <div className="analysis-handoff">
                <h3>请在分析工作区继续</h3>
                <p>比例、趋势、比较和原因需要冻结资料版本后再进行确定性统计与模型分析。</p>
                <Link className="primary-button button-link" href="/analysis">
                  选择或新建分析工作区
                </Link>
              </div>
            ) : null}
            {run.resultReferences.length === 0 ? null : (
              <BulkWorkspaceAdd
                key={`${runId ?? "none"}:${String(run.page)}`}
                sources={run.resultReferences}
              >
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
                      <h3>{result.displayTitle ?? result.sourceId}</h3>
                      {result.sourceDate === undefined || result.sourceDate === null ? null : (
                        <p className="result-source-date">
                          {result.sourceType === "lecture" ? "讲座日期" : "来源讲座日期"}：
                          {result.sourceDate}
                        </p>
                      )}
                      {result.displaySummary === undefined ||
                      result.displaySummary === "" ? null : (
                        <p>{result.displaySummary}</p>
                      )}
                      <p className="result-rationale">{result.rationale}</p>
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
            )}
            {run.totalPages <= 1 ? null : (
              <nav aria-label="智能搜索结果分页" className="smart-search-pagination">
                <button
                  className="secondary-button compact-button"
                  disabled={run.page <= 1}
                  onClick={() => {
                    if (runId !== null) navigate(runId, run.page - 1);
                  }}
                  type="button"
                >
                  上一页
                </button>
                <span>
                  第 {run.page}/{run.totalPages} 页 · 当前显示 {firstResult}—{lastResult}
                </span>
                <button
                  className="secondary-button compact-button"
                  disabled={run.page >= run.totalPages}
                  onClick={() => {
                    if (runId !== null) navigate(runId, run.page + 1);
                  }}
                  type="button"
                >
                  下一页
                </button>
              </nav>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
