import type { JSX } from "react";

import { SmartSearchForm } from "../../components/smart-search-form";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";

export default async function SmartSearchPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  return (
    <main className="app-shell">
      <p className="eyebrow">内部知识系统 · {principal.displayName}</p>
      <h1>智能搜索</h1>
      <p className="page-lead">
        系统会先把你的需求转换为受限检索计划，再从当前讲座与匿名案例中召回候选，并让 DeepSeek
        只在候选集合中筛选与解释。
      </p>
      <div className="notice">
        <strong>边界：</strong>
        智能搜索不会创造资料或引用，也不会索引受隐私门禁保护的逐字稿正文。模型或 Worker
        不可用时，普通关键词搜索仍可使用。
      </div>
      <SmartSearchForm />
    </main>
  );
}
