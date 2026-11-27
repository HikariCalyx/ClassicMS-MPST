import { useEffect, useRef, useState } from "react";
import { exportFile, openExternal, pickExportPath, type ExportFormat } from "../api";
import { useI18n } from "../i18n";

const DISCORD_INVITE_URL = "https://discord.gg/BnnAympQZW";

interface ExportMenuProps {
  canExportPng: boolean;
  nodeName: string | null;
  path: string | null;
  /** 匯出結果（已依介面語言組好的訊息），App 以 toast 顯示。 */
  onMessage: (message: string, tone?: "success" | "error") => void;
  onShowChangelog: () => void;
}

// 匯出選項以副檔名為代碼；標籤與說明在渲染時依介面語言取
// browse.export.<副檔名>Label / browse.export.<副檔名>Description。
const EXPORT_OPTIONS: readonly ExportFormat[] = ["json", "png", "xml"];

function safeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || "export";
}

/**
 * 匯出節點數的 {count} 參數：1,000 以上傳千分位字串（與原本 toLocaleString 的顯示一致）；
 * 以下傳數字，英文才會在 1 個節點時改用單數。
 */
function nodeCountParam(nodes: number): number | string {
  return nodes < 1000 ? nodes : nodes.toLocaleString();
}

export function ExportMenu({ canExportPng, nodeName, path, onMessage, onShowChangelog }: ExportMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const formatLabel = (extension: ExportFormat) => t(`browse.export.${extension}Label`);

  const runExport = async (extension: ExportFormat) => {
    if (!path || exporting) return;
    setOpen(false);
    try {
      const outputPath = await pickExportPath({
        title: t("browse.export.dialogTitle", { label: formatLabel(extension) }),
        defaultName: `${safeFileName(nodeName ?? path.split("/").at(-1) ?? "export")}.${extension}`,
        label: formatLabel(extension),
        extension,
      });
      if (!outputPath) return;
      setExporting(extension);
      const result = await exportFile(path, extension, outputPath);
      onMessage(
        t("browse.export.done", {
          label: formatLabel(extension),
          count: nodeCountParam(result.nodes),
          path: result.out_path,
        }),
        "success",
      );
    } catch (error) {
      onMessage(t("common.exportFailed", { error: String(error) }), "error");
    } finally {
      setExporting(null);
    }
  };

  return (
    <nav className="app-menu-bar" aria-label={t("browse.menu.label")}>
      <div className={`app-menu-group${open ? " is-open" : ""}`} ref={menuRef}>
        <button
          className="app-menu-trigger"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {t("browse.export.menu")}
        </button>
        {open ? (
          <div className="app-menu-dropdown" role="menu">
            {EXPORT_OPTIONS.map((extension) => (
              <button
                className="app-menu-item"
                type="button"
                role="menuitem"
                key={extension}
                disabled={!path || exporting !== null || (extension === "png" && !canExportPng)}
                onClick={() => void runExport(extension)}
              >
                <span className={`export-format-icon is-${extension}`} aria-hidden="true">
                  {extension.toUpperCase()}
                </span>
                <span>
                  <strong>
                    {exporting === extension
                      ? t("common.exporting")
                      : t("browse.export.as", { label: formatLabel(extension) })}
                  </strong>
                  <small>{t(`browse.export.${extension}Description`)}</small>
                </span>
              </button>
            ))}
            {!path ? <p className="app-menu-hint">{t("browse.export.needNode")}</p> : null}
          </div>
        ) : null}
      </div>
      <button
        className="app-menu-trigger"
        type="button"
        onClick={() => void openExternal(DISCORD_INVITE_URL)}
      >
        {t("browse.menu.discord")}
      </button>
      <button className="app-menu-trigger" type="button" onClick={onShowChangelog}>
        {t("browse.menu.changelog")}
      </button>
    </nav>
  );
}
