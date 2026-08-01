import Link from "next/link";
import type { JSX } from "react";

export default function HomePage(): JSX.Element {
  return (
    <main className="home-shell">
      <section className="home-hero">
        <div>
          <p className="eyebrow">Internal MVP · Evidence first</p>
          <h1>醋溜教育智能助手</h1>
          <p className="home-lead">
            先从可追溯的讲座报告与匿名案例中找到依据，再由顾问完成判断。搜索不依赖大模型，原始证据与业务结论保持分离。
          </p>
          <div className="home-actions">
            <Link className="primary-button button-link" href="/login">
              内部账号登录
            </Link>
            <Link className="secondary-button button-link" href="/search">
              进入知识搜索
            </Link>
          </div>
        </div>
        <div className="home-visual" aria-hidden="true">
          <span>48</span>
          <p>场讲座报告</p>
          <span>169</span>
          <p>张匿名案例卡</p>
        </div>
      </section>
      <section className="principle-grid" aria-label="MVP 当前能力">
        <article>
          <span>01</span>
          <h2>中文知识检索</h2>
          <p>按讲座、案例或逐字稿分别搜索，支持业务筛选、排序与分页。</p>
        </article>
        <article>
          <span>02</span>
          <h2>证据可追溯</h2>
          <p>结果可进入详情，查看来源讲座、逻辑路径和明确的证据边界。</p>
        </article>
        <article>
          <span>03</span>
          <h2>隐私门禁</h2>
          <p>逐字稿未获批准时保持为空，不以分析稿或推测内容冒充原始证据。</p>
        </article>
      </section>
    </main>
  );
}
