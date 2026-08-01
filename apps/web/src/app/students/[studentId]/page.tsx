import { AuthorizationDeniedError, createStudentAuthorizationContext } from "@culiu/authorization";
import { StudentRecordNotFoundError, readStudentRecord } from "@culiu/student-records";
import { readStudentProfiles } from "@culiu/student-profiles";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { z } from "zod";

import { EvidenceInvalidateButton } from "../../../components/evidence-invalidate-button";
import { StudentRecordEditor } from "../../../components/student-record-editor";
import { ProfileDraftPanel } from "../../../components/profile-draft-panel";
import { requireActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";

export const dynamic = "force-dynamic";

const accessLabels = {
  internal: "内部",
  restricted: "严格受限",
  sensitive: "敏感",
} as const;

const confirmationLabels = {
  confirmed: "已确认",
  rejected: "已否决",
  superseded: "已被修订",
  unconfirmed: "待确认",
} as const;

function displayValue(value: Record<string, unknown>): string {
  if (typeof value.text === "string") return value.text;
  return JSON.stringify(value);
}

export default async function StudentDetailPage({
  params,
}: Readonly<{ params: Promise<{ studentId: string }> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const studentId = z.uuid().safeParse((await params).studentId);
  if (!studentId.success) notFound();

  const database = getDatabaseClient().database;
  let student;
  let profiles;
  try {
    const context = await createStudentAuthorizationContext(database, principal, {
      action: "student:read",
      accessLevel: "internal",
      studentId: studentId.data,
    });
    student = await readStudentRecord(database, context);
    const profileContext = await createStudentAuthorizationContext(database, principal, {
      action: "student:read",
      accessLevel: "internal",
      studentId: studentId.data,
    });
    profiles = await readStudentProfiles(database, profileContext);
  } catch (error) {
    if (error instanceof AuthorizationDeniedError || error instanceof StudentRecordNotFoundError) {
      notFound();
    }
    throw error;
  }

  const currentFacts = student.facts.filter((fact) => fact.current);
  const historicalFacts = student.facts.filter((fact) => !fact.current);
  const currentEvidence = student.evidence.filter((evidence) => evidence.current);

  return (
    <main className="detail-shell student-record-shell">
      <header className="detail-nav">
        <Link href="/students">← 返回已授权学生</Link>
        <span>学生档案 · 受保护</span>
      </header>
      <article className="detail-card">
        <p className="eyebrow">Student record</p>
        <h1>{student.publicCode}</h1>
        <div className="boundary-card">
          <h2>数据边界</h2>
          <p>
            本页只处理当前学生域内的事实与本人证据。证据文件按内容哈希不可变保存；知识库案例不会被写成学生事实。
          </p>
        </div>

        <StudentRecordEditor
          evidenceLocators={currentEvidence.flatMap((evidence) =>
            evidence.locators.map((locator) => ({
              evidenceFileName: evidence.originalFileName,
              id: locator.id,
              label: `${locator.locatorType} · ${JSON.stringify(locator.locator)}`,
            })),
          )}
          evidenceVersions={currentEvidence.map((evidence) => ({
            id: evidence.id,
            label: `${evidence.originalFileName} · v${String(evidence.version)}`,
          }))}
          factVersions={currentFacts.map((fact) => ({
            fieldKey: fact.fieldKey,
            id: fact.id,
            label: `${fact.fieldKey} · ${displayValue(fact.value)}`,
          }))}
          studentId={student.id}
        />

        <ProfileDraftPanel initialData={profiles} studentId={student.id} />

        <section className="detail-section record-section">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">Current facts</p>
              <h2>当前事实</h2>
            </div>
            <span>{currentFacts.length} 条</span>
          </div>
          {currentFacts.length === 0 ? (
            <p>暂无当前事实。可在上方录入第一条结构化事实。</p>
          ) : (
            <div className="record-list">
              {currentFacts.map((fact) => (
                <article className="record-item" key={fact.id}>
                  <div className="record-item-heading">
                    <h3>{fact.fieldKey}</h3>
                    <span className="privacy-badge">{accessLabels[fact.accessLevel]}</span>
                  </div>
                  <p>{displayValue(fact.value)}</p>
                  <small>
                    {fact.sourceType} · {confirmationLabels[fact.confirmationStatus]} · 证据引用{" "}
                    {fact.evidenceLinks.length} 条
                  </small>
                  {fact.evidenceLinks.some(
                    (link) => link.effectiveValidationStatus === "invalid",
                  ) ? (
                    <p className="record-warning">此事实包含已失效证据，后续画像必须阻断或复查。</p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="detail-section record-section">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">Student evidence</p>
              <h2>学生本人证据</h2>
            </div>
            <span>{student.evidence.length} 个版本</span>
          </div>
          {student.evidence.length === 0 ? (
            <p>暂无证据文件。</p>
          ) : (
            <div className="record-list">
              {student.evidence.map((evidence) => (
                <article className="record-item" key={evidence.id}>
                  <div className="record-item-heading">
                    <h3>{evidence.originalFileName}</h3>
                    <span className="privacy-badge">{accessLabels[evidence.accessLevel]}</span>
                  </div>
                  <p>
                    v{evidence.version} · {evidence.mimeType} ·{" "}
                    {evidence.byteCount.toLocaleString("zh-CN")} bytes
                  </p>
                  <small>
                    SHA-256 {evidence.contentHash.slice(0, 12)}… · 定位 {evidence.locators.length}{" "}
                    条
                  </small>
                  {evidence.invalidation === null ? (
                    <div className="record-actions">
                      {evidence.byteCount > 0 && evidence.originalFileName !== "unknown" ? (
                        <>
                          <a href={`/api/students/${student.id}/evidence/${evidence.id}`}>
                            下载受保护文件
                          </a>
                          {evidence.current ? (
                            <EvidenceInvalidateButton
                              evidenceId={evidence.id}
                              studentId={student.id}
                            />
                          ) : null}
                        </>
                      ) : (
                        <small>结构化脱敏夹具，无对应文件内容</small>
                      )}
                    </div>
                  ) : (
                    <p className="record-warning">已失效：{evidence.invalidation.reason}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {historicalFacts.length > 0 ? (
          <details className="history-panel">
            <summary>查看事实历史版本（{historicalFacts.length}）</summary>
            <div className="record-list">
              {historicalFacts.map((fact) => (
                <article className="record-item" key={fact.id}>
                  <h3>{fact.fieldKey}</h3>
                  <p>{displayValue(fact.value)}</p>
                  <small>{confirmationLabels[fact.confirmationStatus]}</small>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </article>
    </main>
  );
}
