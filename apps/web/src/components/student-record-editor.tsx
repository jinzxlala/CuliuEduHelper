"use client";

import { useRouter } from "next/navigation";
import { type JSX, type SyntheticEvent, useState } from "react";

interface EvidenceLocatorOption {
  evidenceFileName: string;
  id: string;
  label: string;
}

interface VersionOption {
  id: string;
  label: string;
}

interface FactVersionOption extends VersionOption {
  fieldKey: string;
}

interface StudentRecordEditorProps {
  evidenceLocators: EvidenceLocatorOption[];
  evidenceVersions: VersionOption[];
  factVersions: FactVersionOption[];
  studentId: string;
}

type SubmissionState = { kind: "error" | "success"; message: string } | null;

function buildLocator(type: string, value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (type === "record_field") {
    if (trimmed === "") throw new Error("请输入记录字段或整份材料说明。");
    return { locator: { field: trimmed }, locatorType: type };
  }
  if (type === "page" || type === "paragraph") {
    const number = Number(trimmed);
    if (!Number.isInteger(number) || number < 1) throw new Error("页码或段落必须是正整数。");
    return {
      locator: type === "page" ? { page: number } : { paragraph: number },
      locatorType: type,
    };
  }
  const match = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/u.exec(trimmed);
  if (type === "timestamp" && match !== null) {
    const startMs = Math.round(Number(match[1]) * 1_000);
    const endMs = Math.round(Number(match[2]) * 1_000);
    if (endMs > startMs) return { locator: { endMs, startMs }, locatorType: type };
  }
  throw new Error("时间戳请按“开始秒数-结束秒数”填写，例如 12.5-18.2。");
}

async function errorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  return payload?.message ?? `操作失败（${String(response.status)}）`;
}

function formText(data: FormData, key: string): string {
  const value = data.get(key);
  if (typeof value !== "string") throw new Error(`表单字段 ${key} 无效。`);
  return value;
}

export function StudentRecordEditor({
  evidenceLocators,
  evidenceVersions,
  factVersions,
  studentId,
}: Readonly<StudentRecordEditorProps>): JSX.Element {
  const router = useRouter();
  const [factState, setFactState] = useState<SubmissionState>(null);
  const [evidenceState, setEvidenceState] = useState<SubmissionState>(null);
  const [pending, setPending] = useState(false);
  const [revisionFieldKey, setRevisionFieldKey] = useState("");

  async function submitFact(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setFactState(null);
    try {
      const locatorIds = data.getAll("evidenceLocatorId").map((value) => {
        if (typeof value !== "string") throw new Error("证据定位字段无效。");
        return value;
      });
      const sourceType = formText(data, "sourceType");
      const supersedesFactId = formText(data, "supersedesFactId");
      const response = await fetch(`/api/students/${studentId}/facts`, {
        body: JSON.stringify({
          accessLevel: formText(data, "accessLevel"),
          confirmationStatus: formText(data, "confirmationStatus"),
          evidenceLinks: locatorIds.map((evidenceLocatorId) => ({
            evidenceLocatorId,
            relation: "supports",
          })),
          fieldKey: formText(data, "fieldKey"),
          sourceType,
          ...(supersedesFactId === "" ? {} : { supersedesFactId }),
          value: { text: formText(data, "value") },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      form.reset();
      setRevisionFieldKey("");
      setFactState({ kind: "success", message: "事实版本已保存并记录审计。" });
      router.refresh();
    } catch (error) {
      setFactState({
        kind: "error",
        message: error instanceof Error ? error.message : "事实保存失败。",
      });
    } finally {
      setPending(false);
    }
  }

  async function submitEvidence(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setEvidenceState(null);
    try {
      const locator = buildLocator(formText(data, "locatorType"), formText(data, "locatorValue"));
      data.delete("locatorType");
      data.delete("locatorValue");
      data.set("locators", JSON.stringify([locator]));
      const response = await fetch(`/api/students/${studentId}/evidence`, {
        body: data,
        method: "POST",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      form.reset();
      setEvidenceState({ kind: "success", message: "证据已按内容哈希保存。" });
      router.refresh();
    } catch (error) {
      setEvidenceState({
        kind: "error",
        message: error instanceof Error ? error.message : "证据上传失败。",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="record-editor" aria-label="学生档案编辑">
      <div className="editor-panel">
        <p className="eyebrow">Immutable evidence</p>
        <h2>添加学生本人证据</h2>
        <form onSubmit={(event) => void submitEvidence(event)}>
          <label>
            证据文件（最大 20 MB）
            <input name="file" required type="file" />
          </label>
          <div className="form-grid-two">
            <label>
              访问等级
              <select defaultValue="sensitive" name="accessLevel">
                <option value="internal">内部</option>
                <option value="sensitive">敏感</option>
                <option value="restricted">严格受限</option>
              </select>
            </label>
            <label>
              修订已有证据（可选）
              <select defaultValue="" name="supersedesEvidenceId">
                <option value="">新证据</option>
                {evidenceVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-grid-two">
            <label>
              具体定位类型
              <select defaultValue="record_field" name="locatorType">
                <option value="record_field">记录字段</option>
                <option value="page">页码</option>
                <option value="paragraph">段落</option>
                <option value="timestamp">时间戳</option>
              </select>
            </label>
            <label>
              定位值
              <input name="locatorValue" placeholder="例如：第2学期GPA / 3 / 12.5-18.2" required />
            </label>
          </div>
          <button disabled={pending} type="submit">
            {pending ? "处理中…" : "保存证据"}
          </button>
          {evidenceState === null ? null : (
            <p className={`form-message ${evidenceState.kind}`}>{evidenceState.message}</p>
          )}
        </form>
      </div>

      <div className="editor-panel">
        <p className="eyebrow">Versioned facts</p>
        <h2>录入或修订事实</h2>
        <form onSubmit={(event) => void submitFact(event)}>
          <label>
            修订已有事实（可选）
            <select
              defaultValue=""
              name="supersedesFactId"
              onChange={(event) => {
                const selected = factVersions.find((fact) => fact.id === event.target.value);
                setRevisionFieldKey(selected?.fieldKey ?? "");
              }}
            >
              <option value="">新事实</option>
              {factVersions.map((fact) => (
                <option key={fact.id} value={fact.id}>
                  {fact.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            稳定字段键
            <input
              key={revisionFieldKey}
              defaultValue={revisionFieldKey}
              name="fieldKey"
              pattern="[a-z][a-z0-9_.-]*"
              placeholder="例如：academic.gpa"
              required
            />
          </label>
          <label>
            事实内容
            <textarea name="value" placeholder="仅填写已知内容，不用案例补全缺失信息" required />
          </label>
          <div className="form-grid-two">
            <label>
              来源性质
              <select defaultValue="advisor" name="sourceType">
                <option value="advisor">顾问观察</option>
                <option value="student">学生自述</option>
                <option value="parent">家长自述</option>
                <option value="evidence">外部文件证据</option>
              </select>
            </label>
            <label>
              确认状态
              <select defaultValue="unconfirmed" name="confirmationStatus">
                <option value="unconfirmed">待确认</option>
                <option value="confirmed">顾问已确认</option>
              </select>
            </label>
            <label>
              访问等级
              <select defaultValue="sensitive" name="accessLevel">
                <option value="internal">内部</option>
                <option value="sensitive">敏感</option>
                <option value="restricted">严格受限</option>
              </select>
            </label>
          </div>
          {evidenceLocators.length > 0 ? (
            <fieldset>
              <legend>绑定学生本人证据定位（可多选）</legend>
              <div className="locator-options">
                {evidenceLocators.map((locator) => (
                  <label key={locator.id}>
                    <input name="evidenceLocatorId" type="checkbox" value={locator.id} />
                    <span>
                      {locator.evidenceFileName} · {locator.label}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <button disabled={pending} type="submit">
            {pending ? "处理中…" : "保存事实版本"}
          </button>
          {factState === null ? null : (
            <p className={`form-message ${factState.kind}`}>{factState.message}</p>
          )}
        </form>
      </div>
    </section>
  );
}
