// 更新日誌彈窗：直接解析根目錄的 CHANGELOG.md（build 時以 ?raw 打包進來），
// 內容維護只需改 CHANGELOG.md 一個地方。條目照原文顯示，只有彈窗外框跟隨介面語言。

import { useEffect } from "react";
import changelogRaw from "../../CHANGELOG.md?raw";
import { useI18n } from "../i18n";

interface ChangelogEntry {
  title: string;
  items: string[];
}

function parseChangelog(raw: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      // 「未發布」段落不顯示給使用者。
      if (title.includes("未發布")) {
        current = null;
        continue;
      }
      current = { title, items: [] };
      entries.push(current);
    } else if (current && line.startsWith("- ")) {
      current.items.push(line.slice(2).trim());
    } else if (current && current.items.length > 0 && /^\s+\S/.test(line)) {
      // 縮排的續行併回上一個條目。
      current.items[current.items.length - 1] += ` ${line.trim()}`;
    }
  }
  return entries;
}

const ENTRIES = parseChangelog(changelogRaw);

/** 處理行內 **粗體** 標記。 */
function renderInline(text: string) {
  return text.split(/(\*\*.+?\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

interface ChangelogDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ChangelogDialog({ open, onClose }: ChangelogDialogProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="changelog-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("browse.changelog.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="changelog-dialog-header">
          <h2>{t("browse.changelog.title")}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </header>
        <div className="changelog-dialog-content">
          {ENTRIES.map((entry) => (
            <section className="changelog-entry" key={entry.title}>
              <h3>{entry.title}</h3>
              <ul>
                {entry.items.map((item, index) => (
                  <li key={index}>{renderInline(item)}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
