import { StoredManualPlanSchema, type StoredManualPlan } from "./plan-contracts.js";

export interface PlanMarkdownCourse {
  code: string;
  courseVersionId: string;
  title: string;
}

export interface PlanMarkdownOverride {
  approvedByDisplayName: string;
  reason: string;
  scopeKey: string;
  violationKey: string;
}

export interface PlanMarkdownInput {
  approvedByDisplayName: string;
  courses: readonly PlanMarkdownCourse[];
  overrides: readonly PlanMarkdownOverride[];
  plan: StoredManualPlan;
  profileClaims: Readonly<Record<string, string>>;
  studentPublicCode: string;
}

function markdownText(value: string): string {
  return value
    .replace(/\r?\n/gu, " ")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_[\]])/gu, "\\$1")
    .trim();
}

function inline(value: string): string {
  return markdownText(value).replace(/\|/gu, "\\|");
}

function codeText(value: string): string {
  return markdownText(value);
}

function bulletLines(values: readonly string[]): string[] {
  return values.length === 0 ? ["- 无"] : values.map((value) => `- ${markdownText(value)}`);
}

function formatDateTime(value: Date | null): string {
  if (value === null) return "未批准";
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/u, " UTC");
}

function routeDiagram(
  routes: StoredManualPlan["content"]["routes"],
  courseLabel: (courseVersionId: string) => string,
): string[] {
  return routes.map((route) => {
    const phases = route.phases.map(
      (phase) =>
        `[${codeText(phase.label)}: ${phase.courseVersionIds.map(courseLabel).map(codeText).join(" + ")}]`,
    );
    return `${codeText(route.name)}: ${phases.join(" -> ")}`;
  });
}

export function renderManualPlanMarkdown(untrustedInput: PlanMarkdownInput): string {
  const plan = StoredManualPlanSchema.parse(untrustedInput.plan);
  const coursesByVersion = new Map(
    untrustedInput.courses.map((course) => [course.courseVersionId, course]),
  );
  const courseLabel = (courseVersionId: string): string => {
    const course = coursesByVersion.get(courseVersionId);
    if (course === undefined) return `未知课程版本 ${courseVersionId}`;
    return `${course.code} ${course.title}`;
  };
  const approvedOverrides = new Map(
    untrustedInput.overrides.map((override) => [
      `${override.scopeKey}:${override.violationKey}`,
      override,
    ]),
  );
  const lines: string[] = [
    `# ${markdownText(plan.content.title)}`,
    "",
    `- 学生编号：${markdownText(untrustedInput.studentPublicCode)}`,
    `- 规划版本：v${String(plan.version)}`,
    `- 规划周期：${plan.content.period.startDate} 至 ${plan.content.period.endDate}`,
    `- 状态：${plan.status === "approved" ? "已批准" : plan.status}`,
    `- 批准人：${markdownText(untrustedInput.approvedByDisplayName)}`,
    `- 批准时间：${formatDateTime(plan.approvedAt)}`,
    `- 生成日期：${plan.approvedAt?.toISOString().slice(0, 10) ?? "未批准"}`,
    `- 复查日期：${plan.reviewDueDate}`,
    `- 输入快照：${plan.inputSnapshotHash}`,
    "",
    "## 一、规划目标",
    "",
    markdownText(plan.content.goal),
    "",
    "## 二、基于证据的课堂画像",
    "",
    markdownText(plan.content.classroomProfile.statement),
    "",
    ...plan.content.classroomProfile.supportingClaimIds.map(
      (claimId) =>
        `- ${markdownText(untrustedInput.profileClaims[claimId] ?? `画像结论 ${claimId}`)}`,
    ),
    "",
    "## 三、近期课程安排",
    "",
    "| 顺序 | 课程 | 时间 | 推荐理由 | 预期成果 | 风险 |",
    "|---:|---|---|---|---|---|",
    ...plan.content.shortTermItems.map((item) =>
      [
        String(item.order),
        inline(courseLabel(item.courseVersionId)),
        `${item.period.startDate} 至 ${item.period.endDate}`,
        inline(item.reason),
        inline(item.expectedOutcome),
        inline(item.risks.length === 0 ? "无特别风险" : item.risks.join("；")),
      ]
        .join(" | ")
        .replace(/^/u, "| ")
        .replace(/$/u, " |"),
    ),
    "",
    "## 四、两条中性发展路线",
    "",
  ];

  for (const route of plan.content.routes) {
    lines.push(`### ${markdownText(route.name)}`, "", markdownText(route.summary), "");
    lines.push("| 阶段 | 时间 | 课程 |", "|---|---|---|");
    for (const phase of route.phases) {
      lines.push(
        `| ${inline(phase.label)} | ${phase.period.startDate} 至 ${phase.period.endDate} | ${inline(
          phase.courseVersionIds.map(courseLabel).join("；"),
        )} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "### 并行路径图",
    "",
    "```text",
    ...routeDiagram(plan.content.routes, courseLabel),
    "```",
    "",
    "### 路线对比",
    "",
    "| 对比维度 | 路线 A | 路线 B |",
    "|---|---|---|",
    ...plan.content.routeComparison.map(
      (item) => `| ${inline(item.dimension)} | ${inline(item.routeA)} | ${inline(item.routeB)} |`,
    ),
    "",
    "### 重合与差距",
    "",
    "共同基础：",
    "",
    ...bulletLines(plan.content.overlapAndGaps.overlap),
    "",
    "路线 A 需要补足：",
    "",
    ...bulletLines(plan.content.overlapAndGaps.routeAGaps),
    "",
    "路线 B 需要补足：",
    "",
    ...bulletLines(plan.content.overlapAndGaps.routeBGaps),
    "",
    "## 五、决策时间线",
    "",
    "| 观察期 | 决策问题 | 可观察信号 |",
    "|---|---|---|",
    ...plan.content.decisionTimeline.map(
      (decision) =>
        `| ${decision.period.startDate} 至 ${decision.period.endDate} | ${inline(
          decision.decisionQuestion,
        )} | ${inline(decision.observableSignals.join("；"))} |`,
    ),
    "",
    "## 六、总体风险与限制",
    "",
    ...bulletLines(plan.content.risks),
    "",
    "## 七、规则检查",
    "",
    "| 检查范围 | 类型 | 级别 | 结果 | 说明 |",
    "|---|---|---|---|---|",
  );

  for (const scope of plan.evaluation.scopes) {
    if (scope.result.violations.length === 0) {
      lines.push(`| ${inline(scope.label)} | - | - | 通过 | 未发现规则问题 |`);
      continue;
    }
    for (const violation of scope.result.violations) {
      const override = approvedOverrides.get(`${scope.scopeKey}:${violation.violationKey}`);
      const result =
        violation.severity === "warning"
          ? "提醒"
          : override === undefined
            ? "未覆盖"
            : `人工覆盖（${inline(override.approvedByDisplayName)}）`;
      const note =
        override === undefined
          ? violation.message
          : `${violation.message}；覆盖原因：${override.reason}`;
      lines.push(
        `| ${inline(scope.label)} | ${violation.ruleType} | ${violation.severity} | ${result} | ${inline(note)} |`,
      );
    }
  }

  lines.push(
    "",
    "> 本规划由顾问依据已批准学生画像、课程版本和规则快照人工制定。课程或规则发生变化时，应重新复查；本文件未使用模型自动决定课程。",
    "",
  );
  return lines.join("\n");
}
