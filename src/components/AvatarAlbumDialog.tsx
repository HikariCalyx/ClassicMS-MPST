import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { AvatarLook } from "./avatarAlbum";

interface AvatarAlbumDialogProps {
  mode: "save" | "gallery";
  looks: AvatarLook[];
  thumbnail: string | null;
  defaultName: string;
  busy: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (name: string) => void;
  onApply: (look: AvatarLook) => void;
  onRename: (look: AvatarLook, name: string) => Promise<boolean>;
  onDelete: (look: AvatarLook) => Promise<boolean>;
  onStartSave: () => void;
}

export function AvatarAlbumDialog({
  mode,
  looks,
  thumbnail,
  defaultName,
  busy,
  loading,
  error,
  onClose,
  onSave,
  onApply,
  onRename,
  onDelete,
  onStartSave,
}: AvatarAlbumDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(defaultName);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (mode === "save") {
      setName(defaultName);
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [mode, defaultName]);

  const startRename = (look: AvatarLook) => {
    setDeletingId(null);
    setEditingId(look.id);
    setEditingName(look.name);
  };

  return (
    <dialog
      ref={dialogRef}
      className="avatar-album-dialog"
      aria-labelledby="avatar-album-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="changelog-dialog-header">
        <h2 id="avatar-album-title">
          {mode === "save"
            ? t("avatar.album.saveTitle")
            : t("avatar.album.galleryTitle", { count: looks.length })}
        </h2>
        <button type="button" className="icon-button" aria-label={t("avatar.album.close")} disabled={busy} onClick={onClose}>
          ✕
        </button>
      </header>

      {mode === "save" ? (
        <form
          className="avatar-album-save"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) onSave(name.trim());
          }}
        >
          <div className="avatar-album-save-preview">
            {thumbnail ? <img src={thumbnail} alt={t("avatar.album.previewAlt")} /> : null}
          </div>
          <div className="avatar-album-save-fields">
            <label htmlFor="avatar-album-name">{t("avatar.album.nameLabel")}</label>
            <input
              ref={nameRef}
              id="avatar-album-name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("avatar.album.namePlaceholder")}
            />
            <p>{t("avatar.album.saveHint")}</p>
            <div className="avatar-album-save-actions">
              <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
              <button type="submit" className="is-primary" disabled={busy || !name.trim()}>
                {busy ? t("common.saving") : t("avatar.album.save")}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <div className="avatar-album-toolbar">
            <p>{t("avatar.album.applyHint")}</p>
            <button type="button" disabled={busy || loading} onClick={onStartSave}>{t("avatar.album.saveCurrent")}</button>
          </div>
          <div className="avatar-album-body">
            {loading ? (
              <div className="avatar-album-empty" role="status">{t("avatar.album.loading")}</div>
            ) : looks.length === 0 ? (
              <div className="avatar-album-empty">
                <span aria-hidden="true">▧</span>
                <strong>{t("avatar.album.emptyTitle")}</strong>
                <p>{t("avatar.album.emptyHint")}</p>
              </div>
            ) : (
              <div className="avatar-album-grid">
                {looks.map((look) => (
                  <div className="avatar-album-card" key={look.id}>
                    <button type="button" className="avatar-album-card-select" disabled={busy} onClick={() => onApply(look)}>
                      <span className="avatar-album-card-image"><img src={look.thumbnail} alt="" /></span>
                      <span className="avatar-album-card-name">{look.name}</span>
                      <span className="avatar-album-card-hint">{t("avatar.album.clickToApply")}</span>
                    </button>
                    {editingId === look.id ? (
                      <form
                        className="avatar-album-card-edit"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (editingName.trim() && !busy) {
                            void onRename(look, editingName.trim()).then((saved) => {
                              if (saved) setEditingId(null);
                            });
                          }
                        }}
                      >
                        <input
                          aria-label={t("avatar.album.nameLabel")}
                          value={editingName}
                          maxLength={40}
                          autoFocus
                          onChange={(event) => setEditingName(event.target.value)}
                        />
                        <button type="submit" disabled={busy || !editingName.trim()}>{t("common.confirm")}</button>
                        <button type="button" onClick={() => setEditingId(null)}>{t("common.cancel")}</button>
                      </form>
                    ) : deletingId === look.id ? (
                      <div className="avatar-album-card-confirm">
                        <span>{t("avatar.album.confirmDelete")}</span>
                        <button type="button" disabled={busy} onClick={() => {
                          void onDelete(look).then((deleted) => {
                            if (deleted) setDeletingId(null);
                          });
                        }}>{t("common.delete")}</button>
                        <button type="button" disabled={busy} onClick={() => setDeletingId(null)}>{t("common.cancel")}</button>
                      </div>
                    ) : (
                      <div className="avatar-album-card-actions">
                        <button type="button" disabled={busy} onClick={() => startRename(look)}>{t("common.rename")}</button>
                        <button type="button" disabled={busy} onClick={() => { setEditingId(null); setDeletingId(look.id); }}>{t("common.delete")}</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {error ? <p className="avatar-album-error" role="alert">{error}</p> : null}
      <p className="avatar-album-note">{t("avatar.album.storageNote")}</p>
    </dialog>
  );
}
