"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";

import { selectableWorkspaceSourceIds } from "../lib/workspace-source-selection";

interface CatalogItem {
  alreadyAdded: boolean;
  sourceId: string;
  sourceType: "lecture" | "case";
  summary: string;
  title: string;
}

type SourceType = CatalogItem["sourceType"];

const tabLabels: Record<SourceType, string> = {
  case: "案例",
  lecture: "讲座",
};

export function AnalysisSourcePicker({
  workspaceId,
  workspaceName,
}: Readonly<{ workspaceId: string; workspaceName: string }>): JSX.Element {
  const [sourceType, setSourceType] = useState<SourceType>("lecture");
  const [catalogs, setCatalogs] = useState<Partial<Record<SourceType, CatalogItem[]>>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (type: SourceType): Promise<void> => {
      if (catalogs[type] !== undefined) return;
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/analysis/workspaces/${workspaceId}/sources?type=${type}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as { items?: CatalogItem[]; message?: string };
        if (!response.ok || payload.items === undefined)
          throw new Error(payload.message ?? "无法读取知识资料目录。");
        setCatalogs((current) => ({ ...current, [type]: payload.items }));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法读取知识资料目录。");
      } finally {
        setBusy(false);
      }
    },
    [catalogs, workspaceId],
  );

  useEffect(() => {
    void load(sourceType);
  }, [load, sourceType]);

  const items = catalogs[sourceType] ?? [];
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (normalized === "") return items;
    return items.filter((item) =>
      `${item.title}\n${item.summary}\n${item.sourceId}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized),
    );
  }, [items, query]);
  const selectable = visible.filter((item) => !item.alreadyAdded);

  function changeTab(type: SourceType): void {
    setSourceType(type);
    setSelected(new Set());
    setQuery("");
    setMessage(null);
  }

  async function add(): Promise<void> {
    const sources = items
      .filter((item) => selected.has(item.sourceId) && !item.alreadyAdded)
      .map((item) => ({ sourceId: item.sourceId, sourceType: item.sourceType }));
    if (sources.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/analysis/workspaces/${workspaceId}/sources`, {
        body: JSON.stringify({ sources }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        created?: string[];
        existing?: string[];
        message?: string;
      };
      if (!response.ok) throw new Error(payload.message ?? "无法加入所选资料。");
      const createdIds = new Set(
        (payload.created ?? []).map((key) => key.slice(key.indexOf(":") + 1)),
      );
      const existingIds = new Set(
        (payload.existing ?? []).map((key) => key.slice(key.indexOf(":") + 1)),
      );
      setCatalogs((current) => ({
        ...current,
        [sourceType]: (current[sourceType] ?? []).map((item) =>
          createdIds.has(item.sourceId) || existingIds.has(item.sourceId)
            ? { ...item, alreadyAdded: true }
            : item,
        ),
      }));
      setSelected(new Set());
      setMessage(
        existingIds.size === 0
          ? `已加入 ${String(createdIds.size)} 项资料。`
          : `已加入 ${String(createdIds.size)} 项；${String(existingIds.size)} 项已存在，未重复添加。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加入所选资料。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="source-picker-panel">
      <div className="source-picker-header">
        <div>
          <p className="eyebrow">引入背景资料</p>
          <h1>{workspaceName}</h1>
          <p>资料会冻结到当前知识版本；已在工作区中的项目不会重复加入。</p>
        </div>
        <Link className="secondary-button button-link" href={`/analysis/${workspaceId}`}>
          返回工作区
        </Link>
      </div>

      <div className="source-picker-tabs" role="tablist" aria-label="资料类型">
        {(Object.keys(tabLabels) as SourceType[]).map((type) => (
          <button
            aria-selected={sourceType === type}
            className={sourceType === type ? "active" : ""}
            key={type}
            onClick={() => {
              changeTab(type);
            }}
            role="tab"
            type="button"
          >
            {tabLabels[type]}
            {catalogs[type] === undefined ? "" : `（${String(catalogs[type].length)}）`}
          </button>
        ))}
      </div>

      <div className="source-picker-tools">
        <label>
          <span className="sr-only">筛选当前资料</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={`搜索${tabLabels[sourceType]}标题或摘要`}
            type="search"
            value={query}
          />
        </label>
        <div>
          <button
            className="secondary-button compact-button"
            disabled={selectable.length === 0}
            onClick={() => {
              setSelected(new Set(selectableWorkspaceSourceIds(selectable)));
            }}
            type="button"
          >
            全选{query.trim() === "" ? `全部${tabLabels[sourceType]}` : "筛选结果"}
          </button>
          <button
            className="text-button"
            disabled={selected.size === 0}
            onClick={() => {
              setSelected(new Set());
            }}
            type="button"
          >
            清空选择
          </button>
          <button
            className="primary-button compact-button"
            disabled={busy || selected.size === 0}
            onClick={() => void add()}
            type="button"
          >
            {busy ? "正在添加……" : `添加所选（${String(selected.size)}）`}
          </button>
        </div>
      </div>

      {error === null ? null : <p className="notice error-notice">{error}</p>}
      {message === null ? null : <p className="notice success-notice">{message}</p>}
      {busy && items.length === 0 ? <p className="notice">正在读取资料目录……</p> : null}
      {!busy && visible.length === 0 ? (
        <div className="empty-state">
          <p>当前没有符合条件的{tabLabels[sourceType]}。</p>
        </div>
      ) : (
        <ul className="source-picker-list">
          {visible.map((item) => (
            <li className={item.alreadyAdded ? "is-added" : ""} key={item.sourceId}>
              <label>
                <input
                  checked={selected.has(item.sourceId)}
                  disabled={item.alreadyAdded}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.sourceId);
                      else next.delete(item.sourceId);
                      return next;
                    });
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.summary || "暂无摘要。"}</small>
                </span>
              </label>
              {item.alreadyAdded ? (
                <span className="source-added-badge">已在工作区</span>
              ) : (
                <Link
                  href={
                    item.sourceType === "lecture"
                      ? `/knowledge/lectures/${item.sourceId}`
                      : `/knowledge/cases/${item.sourceId}`
                  }
                  target="_blank"
                >
                  查看详情 ↗
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
