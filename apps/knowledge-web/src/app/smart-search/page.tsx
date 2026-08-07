import type { JSX } from "react";

import { SmartSearchForm } from "../../components/smart-search-form";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";

export default async function SmartSearchPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ page?: string; run?: string }> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const { page, run } = await searchParams;
  const initialPage = /^\d+$/u.test(page ?? "") ? Math.max(1, Number(page)) : 1;
  return (
    <main className="app-shell">
      <p className="eyebrow">内部知识系统 · {principal.displayName}</p>
      <h1>智能搜索</h1>
      <p className="page-lead">
        系统会识别主题搜索、完整目录、精确计数或分析任务。目录与数量由系统确定性查询，主题搜索才会让
        DeepSeek 在候选集合中筛选与解释。
      </p>
      <div className="notice">
        <strong>边界：</strong>
        智能搜索不会创造资料或引用，也不会索引受隐私门禁保护的逐字稿正文。模型或 Worker
        不可用时，普通关键词搜索仍可使用。
      </div>
      <SmartSearchForm initialPage={initialPage} initialRunId={run ?? null} />
    </main>
  );
}
