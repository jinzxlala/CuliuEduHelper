import type {
  CaseDocument,
  LectureDocument,
  SearchHit,
  SearchPage,
  TranscriptSegmentDocument,
} from "@culiu/search";
import Link from "next/link";
import type { JSX } from "react";

import { HighlightedText } from "../../components/highlighted-text";
import { AddToWorkspaceButton } from "../../components/add-to-workspace-button";
import { SignOutButton } from "../../components/sign-out-button";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";
import { getKnowledgeSearchService } from "../../lib/knowledge-search";
import { runKnowledgeSearch } from "../../lib/knowledge-search-runner";
import {
  SEARCH_PAGE_SIZE,
  buildSearchHref,
  formatTimestamp,
  parseSearchPageState,
  type RawSearchParams,
  type SearchPageState,
  type SearchTarget,
} from "../../lib/search-page-state";

export const dynamic = "force-dynamic";

const targetLabels: Record<SearchTarget, string> = {
  lectures: "讲座报告",
  cases: "匿名案例",
  transcripts: "逐字稿证据",
};

const confidenceLabels: Record<string, string> = {
  high: "高",
  low: "低",
  medium: "中",
  unknown: "待确认",
};

function formattedText(hit: { formatted: object }, field: string, fallback: string): string {
  const candidate = (hit.formatted as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : fallback;
}

function displayDate(date: string | null): string {
  return date === null ? "日期待确认" : date;
}

function ChipList({ items }: Readonly<{ items: readonly string[] }>): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className="chip-list" aria-label="标签">
      {items.slice(0, 6).map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function LectureResult({ hit }: Readonly<{ hit: SearchHit<LectureDocument> }>): JSX.Element {
  const lecture = hit.document;
  return (
    <article className="result-card">
      <div className="result-meta">
        <span>{displayDate(lecture.date)}</span>
        <span>{lecture.organization ?? "机构待确认"}</span>
      </div>
      <h2>
        <Link href={`/knowledge/lectures/${encodeURIComponent(lecture.lecture_id)}`}>
          <HighlightedText value={formattedText(hit, "title", lecture.title)} />
        </Link>
      </h2>
      <p className="result-summary">
        <HighlightedText
          maxCharacters={300}
          value={formattedText(hit, "summary", lecture.summary || "本讲座暂无摘要。")}
        />
      </p>
      <ChipList items={[...lecture.schools, ...lecture.majors]} />
      <div className="result-footer">
        <code>{lecture.source_path}</code>
        <AddToWorkspaceButton sourceId={lecture.lecture_id} sourceType="lecture" />
        <Link href={`/knowledge/lectures/${encodeURIComponent(lecture.lecture_id)}`}>查看证据</Link>
      </div>
    </article>
  );
}

function CaseResult({ hit }: Readonly<{ hit: SearchHit<CaseDocument> }>): JSX.Element {
  const item = hit.document;
  const title = [item.case_type, item.academic_label].filter(Boolean).join(" · ");
  const formattedTitle = formattedText(hit, "academic_label", title || item.case_id);
  return (
    <article className="result-card">
      <div className="result-meta">
        <span>{item.case_type}</span>
        <span>可信度：{confidenceLabels[item.confidence]}</span>
      </div>
      <h2>
        <Link href={`/knowledge/cases/${encodeURIComponent(item.case_id)}`}>
          <HighlightedText value={formattedTitle || title || item.case_id} />
        </Link>
      </h2>
      <p className="result-summary">
        <HighlightedText
          maxCharacters={300}
          value={formattedText(
            hit,
            "profile_summary",
            item.profile_summary || item.background || "本案例暂无背景摘要。",
          )}
        />
      </p>
      <ChipList
        items={[
          ...item.schools,
          ...(item.major === null ? [] : [item.major]),
          ...item.research_methods,
          ...item.core_strengths,
          ...item.ai_domains,
        ]}
      />
      <div className="result-footer">
        <span>来源讲座：{item.lecture_id}</span>
        <AddToWorkspaceButton sourceId={item.case_id} sourceType="case" />
        <Link href={`/knowledge/cases/${encodeURIComponent(item.case_id)}`}>查看证据边界</Link>
      </div>
    </article>
  );
}

function TranscriptResult({
  hit,
}: Readonly<{ hit: SearchHit<TranscriptSegmentDocument> }>): JSX.Element {
  const item = hit.document;
  return (
    <article className="result-card">
      <div className="result-meta">
        <span>{item.section ?? "未标章节"}</span>
        <span>
          {formatTimestamp(item.start_seconds)}—{formatTimestamp(item.end_seconds)}
        </span>
      </div>
      <h2>
        <Link href={`/knowledge/transcripts/${encodeURIComponent(item.segment_id)}`}>
          逐字稿片段 · {item.lecture_id}
        </Link>
      </h2>
      <p className="result-summary">
        <HighlightedText maxCharacters={360} value={formattedText(hit, "text", item.text)} />
      </p>
      <div className="result-footer">
        <code>{item.source_path}</code>
        <Link href={`/knowledge/transcripts/${encodeURIComponent(item.segment_id)}`}>
          查看上下文
        </Link>
      </div>
    </article>
  );
}

interface FacetOption {
  count: number;
  value: string;
}

function facetOptions(
  page: { facetDistribution: Record<string, Record<string, number>> } | undefined,
  field: string,
  selected: readonly string[],
): FacetOption[] {
  const counts = page?.facetDistribution[field] ?? {};
  return [...new Set([...Object.keys(counts), ...selected])]
    .map((value) => ({ count: counts[value] ?? 0, value }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "zh"));
}

function FacetGroup({
  label,
  name,
  options,
  selected,
}: Readonly<{
  label: string;
  name: string;
  options: FacetOption[];
  selected: readonly string[];
}>): JSX.Element | null {
  if (options.length === 0) return null;
  return (
    <fieldset className="facet-group">
      <legend>{label}</legend>
      <div className="facet-options">
        {options.slice(0, 14).map((option) => (
          <label key={option.value}>
            <input
              defaultChecked={selected.includes(option.value)}
              name={name}
              type="checkbox"
              value={option.value}
            />
            <span>{option.value}</span>
            <small>{option.count}</small>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Filters({
  page,
  state,
}: Readonly<{
  page:
    | SearchPage<LectureDocument>
    | SearchPage<CaseDocument>
    | SearchPage<TranscriptSegmentDocument>
    | undefined;
  state: SearchPageState;
}>): JSX.Element {
  const clearState = parseSearchPageState({
    match: state.matchMode === "all" ? "all" : undefined,
    q: state.query,
    type: state.target === "lectures" ? undefined : state.target,
  });
  return (
    <aside className="filter-panel" aria-label="搜索筛选">
      <div className="filter-heading">
        <h2>筛选</h2>
        <Link href={buildSearchHref(clearState, {})}>清空</Link>
      </div>
      <form action="/search" method="get">
        {state.target === "lectures" ? null : (
          <input name="type" type="hidden" value={state.target} />
        )}
        {state.query === "" ? null : <input name="q" type="hidden" value={state.query} />}
        {state.matchMode === "all" ? <input name="match" type="hidden" value="all" /> : null}
        {state.target === "lectures" ? (
          <>
            <label className="field-label">
              日期从
              <input defaultValue={state.dateFrom} name="from" type="date" />
            </label>
            <label className="field-label">
              日期到
              <input defaultValue={state.dateTo} name="to" type="date" />
            </label>
            <label className="field-label">
              排序
              <select defaultValue={state.sort ?? ""} name="sort">
                <option value="">相关度</option>
                <option value="date:desc">日期：新到旧</option>
                <option value="date:asc">日期：旧到新</option>
                <option value="title:asc">标题：升序</option>
              </select>
            </label>
            <FacetGroup
              label="机构"
              name="organization"
              options={facetOptions(page, "organization", state.organizations)}
              selected={state.organizations}
            />
            <FacetGroup
              label="学校"
              name="school"
              options={facetOptions(page, "schools", state.schools)}
              selected={state.schools}
            />
            <FacetGroup
              label="专业"
              name="major"
              options={facetOptions(page, "majors", state.majors)}
              selected={state.majors}
            />
          </>
        ) : null}
        {state.target === "cases" ? (
          <>
            <FacetGroup
              label="来源讲座"
              name="lecture"
              options={facetOptions(page, "lecture_id", state.lectureIds)}
              selected={state.lectureIds}
            />
            <FacetGroup
              label="案例性质"
              name="caseType"
              options={facetOptions(page, "case_type", state.caseTypes)}
              selected={state.caseTypes}
            />
            <FacetGroup
              label="课程体系"
              name="curriculum"
              options={facetOptions(page, "curriculum_system", state.curriculumSystems)}
              selected={state.curriculumSystems}
            />
            <FacetGroup
              label="学校"
              name="school"
              options={facetOptions(page, "schools", state.schools)}
              selected={state.schools}
            />
            <FacetGroup
              label="专业"
              name="major"
              options={facetOptions(page, "major", state.majors)}
              selected={state.majors}
            />
            <FacetGroup
              label="AI 深度"
              name="aiDepth"
              options={facetOptions(page, "ai_depth", state.aiDepth)}
              selected={state.aiDepth}
            />
            <FacetGroup
              label="证据可信度"
              name="confidence"
              options={facetOptions(page, "confidence", state.confidence)}
              selected={state.confidence}
            />
          </>
        ) : null}
        {state.target === "transcripts" ? (
          <>
            <FacetGroup
              label="讲座"
              name="lecture"
              options={facetOptions(page, "lecture_id", state.lectureIds)}
              selected={state.lectureIds}
            />
            <FacetGroup
              label="章节"
              name="section"
              options={facetOptions(page, "section", state.sections)}
              selected={state.sections}
            />
          </>
        ) : null}
        <button className="primary-button full-width" type="submit">
          应用筛选
        </button>
      </form>
    </aside>
  );
}

function Pagination({
  state,
  total,
}: Readonly<{ state: SearchPageState; total: number }>): JSX.Element | null {
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="搜索结果分页">
      {state.page > 1 ? (
        <Link href={buildSearchHref(state, { page: state.page - 1 })}>上一页</Link>
      ) : (
        <span aria-disabled="true">上一页</span>
      )}
      <strong>
        第 {state.page} / {totalPages} 页
      </strong>
      {state.page < totalPages ? (
        <Link href={buildSearchHref(state, { page: state.page + 1 })}>下一页</Link>
      ) : (
        <span aria-disabled="true">下一页</span>
      )}
    </nav>
  );
}

export default async function SearchPage({
  searchParams,
}: Readonly<{ searchParams: Promise<RawSearchParams> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const state = parseSearchPageState(await searchParams);
  let result: Awaited<ReturnType<typeof runKnowledgeSearch>> | undefined;
  let unavailable = false;
  try {
    result = await runKnowledgeSearch(getKnowledgeSearchService(), state);
  } catch {
    unavailable = true;
  }
  const page = result?.lectures ?? result?.cases ?? result?.transcripts;

  return (
    <main className="app-shell">
      <header className="account-toolbar">
        <span>内部知识工作台</span>
        <div className="account-actions">
          <Link href="/students">已授权学生</Link>
          <span>{principal.displayName}</span>
          <SignOutButton />
        </div>
      </header>

      <section className="search-hero">
        <p className="eyebrow">Evidence-first search</p>
        <h1>从讲座、案例和原始证据中查找信息</h1>
        <form action="/search" className="search-form" method="get" role="search">
          {state.target === "lectures" ? null : (
            <input name="type" type="hidden" value={state.target} />
          )}
          <div className="search-query-row">
            <label className="sr-only" htmlFor="knowledge-query">
              搜索关键词
            </label>
            <input
              defaultValue={state.query}
              id="knowledge-query"
              maxLength={500}
              name="q"
              placeholder="例如：人工智能、跨学科研究、申请失败原因"
              type="search"
            />
            <button className="primary-button" type="submit">
              搜索
            </button>
          </div>
          <fieldset className="search-match-mode">
            <legend>搜索行为</legend>
            <label>
              <input
                defaultChecked={state.matchMode === "relaxed"}
                name="match"
                type="radio"
                value="relaxed"
              />
              宽松匹配
            </label>
            <label>
              <input
                defaultChecked={state.matchMode === "all"}
                name="match"
                type="radio"
                value="all"
              />
              保留全部关键词
            </label>
          </fieldset>
        </form>
      </section>

      <nav className="search-tabs" aria-label="搜索范围">
        {(Object.keys(targetLabels) as SearchTarget[]).map((target) => (
          <Link
            aria-current={state.target === target ? "page" : undefined}
            className={state.target === target ? "active" : ""}
            href={buildSearchHref(state, { target })}
            key={target}
          >
            {targetLabels[target]}
          </Link>
        ))}
      </nav>

      {state.target === "transcripts" ? (
        <div className="boundary-notice">
          逐字稿仍受隐私审核门禁保护；当前正式索引为空，系统不会用分析稿或虚构内容替代原始时间戳证据。
        </div>
      ) : null}

      {unavailable ? (
        <section className="error-panel" role="alert">
          <h2>搜索服务暂时不可用</h2>
          <p>请确认 Docker Desktop 与本地 Meilisearch 已启动，然后刷新页面。</p>
        </section>
      ) : (
        <div className="search-layout">
          <Filters page={page} state={state} />
          <section className="results" aria-live="polite">
            <div className="results-heading">
              <div>
                <p className="eyebrow">{targetLabels[state.target]}</p>
                <h2>{page?.estimatedTotalHits ?? 0} 条结果</h2>
              </div>
              <span>{page?.processingTimeMs ?? 0} ms</span>
            </div>

            {page?.hits.length === 0 ? (
              <div className="empty-state">
                <h2>没有找到匹配内容</h2>
                <p>可以减少筛选条件，或换一个更具体的关键词。</p>
              </div>
            ) : null}
            {result?.lectures?.hits.map((hit) => (
              <LectureResult hit={hit} key={hit.document.lecture_id} />
            ))}
            {result?.cases?.hits.map((hit) => (
              <CaseResult hit={hit} key={hit.document.case_id} />
            ))}
            {result?.transcripts?.hits.map((hit) => (
              <TranscriptResult hit={hit} key={hit.document.segment_id} />
            ))}
            <Pagination state={state} total={page?.estimatedTotalHits ?? 0} />
          </section>
        </div>
      )}
    </main>
  );
}
