import type { JSX } from "react";

export default function HomePage(): JSX.Element {
  return (
    <main>
      <section className="status-card">
        <p className="eyebrow">MVP Engineering Baseline</p>
        <h1>醋溜教育智能助手</h1>
        <p>
          Node.js／TypeScript单仓库已经就绪。当前页面仅用于验证Web应用骨架；知识搜索、学生画像和课程规划将按
          <code>dev_plan.md</code>逐个模块实现。
        </p>
      </section>
    </main>
  );
}
