"use client";

import { useState } from "react";

import {
  createShare,
  listShares,
  revokeShare,
  shareErrorMessage,
  shareExpiry,
  shareLink,
  sharesForAlbum,
  shareTimeLabel,
  type ShareListItem,
} from "../../lib/share-client.js";

export function ShareLinkResult({
  link,
  copied,
  onCopy,
}: {
  link: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section className="gallery-confirm" aria-label="分享链接">
      <h2>分享链接</h2>
      <p>链接只在这次创建后显示。刷新页面后不能再次查看。</p>
      <p className="gallery-share-link">{link}</p>
      <div>
        <button type="button" onClick={onCopy}>
          {copied ? "已复制" : "复制链接"}
        </button>
      </div>
    </section>
  );
}

export function ShareList({
  albumName,
  shares,
  pendingId,
  onRevoke,
}: {
  albumName: string;
  shares: ShareListItem[];
  pendingId: string | null;
  onRevoke: (shareId: string) => void;
}) {
  if (shares.length === 0) return <p>还没有分享链接。</p>;
  return (
    <div className="gallery-share-list">
      {shares.map((share) => (
        <article key={share.shareId}>
          <h3>{albumName}</h3>
          <p>创建 {shareTimeLabel(share.createdAt)}</p>
          <p>到期 {shareTimeLabel(share.expiresAt)}</p>
          <p>
            {share.revokedAt
              ? `已停止 ${shareTimeLabel(share.revokedAt)}`
              : "未停止"}
          </p>
          {share.revokedAt ? null : (
            <button
              type="button"
              className="gallery-quiet-button"
              disabled={pendingId === share.shareId}
              onClick={() => onRevoke(share.shareId)}
            >
              停止访问
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function ShareRevokeConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="gallery-confirm" aria-label="停止分享">
      <h2>停止该分享链接访问</h2>
      <p>停止后，这个链接将无法继续打开。</p>
      <div>
        <button type="button" onClick={onConfirm}>
          停止该分享链接访问
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}

export function SharePanel({
  albumId,
  albumName,
  familyId,
}: {
  albumId: string;
  albumName: string;
  familyId: string;
}) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [days, setDays] = useState<7 | 30>(7);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function openPanel() {
    setOpen(true);
    setLink(null);
    setCopied(false);
    setPendingRevoke(null);
    setMessage("");
    try {
      const page = await listShares(familyId);
      setShares(sharesForAlbum(page.shares, albumId));
    } catch (error) {
      setMessage(shareErrorMessage(error));
    }
  }

  function closePanel() {
    setOpen(false);
    setLink(null);
    setCopied(false);
    setPendingRevoke(null);
  }

  async function create() {
    setBusy(true);
    setMessage("");
    setCopied(false);
    try {
      const created = await createShare(albumId, shareExpiry(days));
      setLink(shareLink(window.location.origin, created.token));
      const page = await listShares(familyId);
      setShares(sharesForAlbum(page.shares, albumId));
    } catch (error) {
      setMessage(shareErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRevoke() {
    if (!pendingRevoke) return;
    setBusy(true);
    setMessage("");
    try {
      const revoked = await revokeShare(pendingRevoke);
      setShares((current) =>
        current.map((share) =>
          share.shareId === revoked.shareId
            ? { ...share, revokedAt: revoked.revokedAt }
            : share,
        ),
      );
      setPendingRevoke(null);
    } catch (error) {
      setMessage(shareErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setMessage("暂时无法复制。");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="gallery-quiet-button"
        onClick={() => void openPanel()}
      >
        分享
      </button>
    );
  }

  return (
    <section className="gallery-share" aria-label="分享">
      <div className="gallery-title-row">
        <h2>分享</h2>
        <button
          type="button"
          className="gallery-quiet-button"
          onClick={closePanel}
        >
          关闭
        </button>
      </div>
      {link ? (
        <ShareLinkResult
          link={link}
          copied={copied}
          onCopy={() => void copyLink()}
        />
      ) : null}
      <label>
        到期时间
        <select
          value={days}
          onChange={(event) => setDays(event.target.value === "30" ? 30 : 7)}
        >
          <option value="7">7 天后</option>
          <option value="30">30 天后</option>
        </select>
      </label>
      <button
        type="button"
        className="gallery-text-button"
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? "正在创建" : "创建分享"}
      </button>
      {pendingRevoke ? (
        <ShareRevokeConfirm
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : (
        <ShareList
          albumName={albumName}
          shares={shares}
          pendingId={busy ? pendingRevoke : null}
          onRevoke={setPendingRevoke}
        />
      )}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
