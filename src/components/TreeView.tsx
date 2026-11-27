import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChildEntry } from "../api";
import { useI18n } from "../i18n";

interface TreeRow {
  key: string;
  depth: number;
  entry: ChildEntry;
  expandable: boolean;
}

interface TreeViewProps {
  childrenOf: (path: string) => ChildEntry[] | undefined;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (entry: ChildEntry) => void;
}

function isExpandable(entry: ChildEntry): boolean {
  switch (entry.kind) {
    case "Category":
    case "Img":
      return true;
    case "Node":
      return entry.has_children;
  }
}

function nodeTone(entry: ChildEntry): string {
  if (entry.kind === "Category") return "category";
  if (entry.kind === "Img") return "image";
  if (entry.type_tag === 18 || entry.type_tag === 19) return "canvas";
  if ([3, 5, 6, 8, 9, 14].includes(entry.type_tag)) return "numeric";
  if (entry.type_tag === 11 || entry.type_tag === 12) return "text";
  return "node";
}

export function TreeView({
  childrenOf,
  expanded,
  selected,
  onToggle,
  onSelect,
}: TreeViewProps) {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const output: TreeRow[] = [];
    const walk = (path: string, depth: number) => {
      const children = childrenOf(path);
      if (!children) return;
      for (const entry of children) {
        const expandable = isExpandable(entry);
        output.push({ key: entry.path, depth, entry, expandable });
        if (expandable && expanded.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    };
    walk("", 0);
    return output;
  }, [childrenOf, expanded]);

  const selectedIndex = useMemo(
    () => rows.findIndex((row) => row.entry.path === selected),
    [rows, selected],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 36,
  });

  useEffect(() => {
    if (selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [selectedIndex, virtualizer]);

  const selectIndex = (index: number) => {
    const boundedIndex = Math.max(0, Math.min(rows.length - 1, index));
    const next = rows[boundedIndex];
    if (!next) return;
    onSelect(next.entry);
    virtualizer.scrollToIndex(boundedIndex, { align: "auto" });
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const row = rows[currentIndex];

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        selectIndex(currentIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        selectIndex(currentIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        selectIndex(0);
        break;
      case "End":
        event.preventDefault();
        selectIndex(rows.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (row.expandable && !expanded.has(row.entry.path)) {
          onToggle(row.entry.path);
        } else if (rows[currentIndex + 1]?.depth > row.depth) {
          selectIndex(currentIndex + 1);
        }
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (row.expandable && expanded.has(row.entry.path)) {
          onToggle(row.entry.path);
          break;
        }
        const parentPath = row.entry.path.split("/").slice(0, -1).join("/");
        const parentIndex = rows.findIndex((candidate) => candidate.entry.path === parentPath);
        if (parentIndex >= 0) selectIndex(parentIndex);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        onSelect(row.entry);
        break;
    }
  };

  if (rows.length === 0) {
    return <div className="tree-loading">{t("browse.tree.building")}</div>;
  }

  return (
    <div
      ref={parentRef}
      className="tree-list"
      role="tree"
      tabIndex={0}
      aria-label={t("browse.tree.label")}
      onKeyDown={onTreeKeyDown}
    >
      <div
        className="tree-virtual-spacer"
        role="none"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const { entry } = row;
          const isSelected = selected === entry.path;
          const isExpanded = expanded.has(entry.path);
          const rowStyle = {
            "--tree-depth": row.depth,
            "--tree-guide-width": `${row.depth * 16}px`,
            height: virtualRow.size,
            transform: `translateY(${virtualRow.start}px)`,
          } as CSSProperties;

          return (
            <div
              key={row.key}
              className={`tree-row${isSelected ? " is-selected" : ""}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={row.expandable ? isExpanded : undefined}
              style={rowStyle}
            >
              {row.depth > 0 ? <span className="tree-branch-guides" aria-hidden="true" /> : null}
              <button
                className="tree-disclosure"
                type="button"
                disabled={!row.expandable}
                aria-label={
                  row.expandable
                    ? isExpanded
                      ? t("browse.tree.collapse", { name: entry.name })
                      : t("browse.tree.expand", { name: entry.name })
                    : t("browse.tree.noChildren", { name: entry.name })
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(entry);
                  if (row.expandable) onToggle(entry.path);
                }}
              >
                {row.expandable ? (isExpanded ? "−" : "+") : ""}
              </button>
              <button
                className="tree-node-button"
                type="button"
                title={entry.path}
                onClick={() => onSelect(entry)}
                onDoubleClick={() => {
                  if (row.expandable) onToggle(entry.path);
                }}
              >
                <span className={`tree-node-dot type-${nodeTone(entry)}`} aria-hidden="true" />
                <span className="tree-node-name">{entry.name}</span>
                {entry.kind === "Category" ? (
                  <span className="tree-node-count">{entry.img_count.toLocaleString()}</span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
