import Link from "next/link";
import type { JSX } from "react";

export default function KnowledgeNotFound(): JSX.Element {
  return (
    <main className="detail-shell">
      <section className="empty-state detail-empty">
        <p className="eyebrow">Evidence not found</p>
        <h1>没有找到这条知识证据</h1>
        <p>它可能已被重新索引，或链接中的标识无效。</p>
        <Link className="primary-button button-link" href="/search">
          返回知识搜索
        </Link>
      </section>
    </main>
  );
}
