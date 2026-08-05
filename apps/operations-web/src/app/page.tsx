import Link from "next/link";
import type { JSX } from "react";

export default function HomePage(): JSX.Element {
  return (
    <main className="home-shell">
      <section className="home-hero">
        <div>
          <p className="eyebrow">Internal operations · Authorized access</p>
          <h1>醋溜教育教务系统</h1>
          <p className="home-lead">
            集中维护学生档案、画像、课程规划和排课信息。学生资料按授权范围访问，模型建议必须经过人工审核后才能成为正式记录。
          </p>
          <div className="home-actions">
            <Link className="primary-button button-link" href="/login">
              教务账号登录
            </Link>
            <Link className="secondary-button button-link" href="/students">
              进入学生档案
            </Link>
            <Link className="secondary-button button-link" href="/scheduling">
              进入课程排课
            </Link>
          </div>
        </div>
        <div className="home-visual" aria-hidden="true">
          <span>01</span>
          <p>学生档案与画像</p>
          <span>02</span>
          <p>课程规划与排课</p>
        </div>
      </section>
      <section className="principle-grid" aria-label="教务系统当前能力">
        <article>
          <span>01</span>
          <h2>学生档案</h2>
          <p>批量导入基础信息，按学生授权维护事实、证据和历史版本。</p>
        </article>
        <article>
          <span>02</span>
          <h2>画像与规划</h2>
          <p>由人工审核模型草稿，并基于已批准画像生成课程建议。</p>
        </article>
        <article>
          <span>03</span>
          <h2>课程与排课</h2>
          <p>维护课程模板、教师、地点与候选课表，再生成可审核的排课结果。</p>
        </article>
      </section>
    </main>
  );
}
