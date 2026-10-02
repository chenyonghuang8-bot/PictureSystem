"use client";
import { useEffect, useRef, useState } from "react";
import {
  galleryMediaDetailSchema,
  type GalleryMediaDetail,
} from "@family-album/contracts";
import {
  browserGalleryGet,
  GalleryClientError,
} from "../../lib/gallery-client.js";
import { mediaDetailPath } from "../../lib/gallery-paths.js";
import {
  newAttempt,
  sendLifecycle,
  lifecycleMessage,
  unknownOutcome,
  requireLifecycleActor,
  type LifecycleAttempt,
} from "../../lib/trash-client.js";
import { LifecycleDialog } from "./lifecycle-dialog.js";
export function TrashAction({
  familyId,
  userId,
  target,
  detail,
  onTrashed,
  onUnavailable,
  onLeave,
  onBlock,
}: {
  userId: string;
  familyId: string;
  target: { albumId: string; mediaId: string };
  detail: GalleryMediaDetail;
  onTrashed: () => void;
  onUnavailable: () => void;
  onLeave: () => void;
  onBlock: (blocked: boolean) => void;
}) {
  const [confirmation, setConfirmation] = useState<GalleryMediaDetail | null>(
      null,
    ),
    [message, setMessage] = useState(""),
    [pending, setPending] = useState(false),
    [attempt, setAttempt] = useState<LifecycleAttempt | null>(null);
  const lock = useRef(false),
    alive = useRef(true),
    invalidIdentity = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBlock(pending || !!attempt || !!confirmation);
  }, [pending, attempt, confirmation, onBlock]);
  useEffect(() => () => onBlock(false), [onBlock]);
  async function guard() {
    if (invalidIdentity.current)
      throw new GalleryClientError("UNAUTHENTICATED");
    try {
      await requireLifecycleActor(userId, familyId);
    } catch (error) {
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      ) {
        invalidIdentity.current = true;
        if (alive.current) {
          setConfirmation(null);
          setAttempt(null);
          onUnavailable();
        }
      }
      throw error;
    }
  }
  async function read(confirm: boolean) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    onBlock(true);
    try {
      await guard();
      if (!alive.current || invalidIdentity.current) return;
      const row = await browserGalleryGet(
        mediaDetailPath(target.albumId, target.mediaId),
        galleryMediaDetailSchema,
      );
      await guard();
      if (!alive.current || invalidIdentity.current) return;
      if (row.mediaId !== target.mediaId)
        throw new GalleryClientError("UNAVAILABLE");
      setAttempt(null);
      setMessage(
        confirm ? "" : "目前可见；这不能证明此前操作的结果。请重新打开确认。",
      );
      setConfirmation(confirm && row.capabilities.canTrash ? row : null);
      if (confirm && !row.capabilities.canTrash)
        setMessage("当前不能移入回收站。");
    } catch (error) {
      if (!alive.current || invalidIdentity.current) return;
      setConfirmation(null);
      setMessage(lifecycleMessage(error));
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        onUnavailable();
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
      // The effect retains the block while a confirmation or unknown attempt exists.
    }
  }
  async function submit() {
    if (lock.current || !confirmation || attempt) return;
    lock.current = true;
    setPending(true);
    onBlock(true);
    const selected = confirmation;
    let submitted = false;
    try {
      await guard();
      if (!alive.current || invalidIdentity.current) return;
      const next = newAttempt(
        familyId,
        target.mediaId,
        selected.lifecycleRevision,
        "trash",
        target.albumId,
      );
      setAttempt(next);
      submitted = true;
      await sendLifecycle(next);
      await guard();
      if (!alive.current || invalidIdentity.current) return;
      setConfirmation(null);
      onTrashed();
    } catch (error) {
      if (submitted && alive.current && !invalidIdentity.current) {
        try {
          await guard();
        } catch {
          /* An observed mismatch invalidates late failures too. */
        }
      }
      if (!alive.current || invalidIdentity.current) return;
      setConfirmation(null);
      setMessage(
        submitted
          ? lifecycleMessage(error)
          : "未能验证当前身份，旧确认已取消；未发送媒体操作。请刷新后重新确认。",
      );
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        onUnavailable();
      else if (!unknownOutcome(error)) {
        setAttempt(null);
        try {
          const current = await browserGalleryGet(
            mediaDetailPath(target.albumId, target.mediaId),
            galleryMediaDetailSchema,
          );
          if (
            alive.current &&
            current.mediaId === target.mediaId &&
            !current.capabilities.canTrash
          )
            setMessage("权限或状态已变化，当前不能移入回收站。");
        } catch (readError) {
          if (
            alive.current &&
            readError instanceof GalleryClientError &&
            readError.code === "UNAUTHENTICATED"
          )
            onUnavailable();
        }
      }
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
      // The effect retains the block while a confirmation or unknown attempt exists.
    }
  }
  return (
    <section className="gallery-confirm">
      <button
        type="button"
        disabled={pending || !!attempt || !detail.capabilities.canTrash}
        onClick={() => void read(true)}
      >
        移入回收站
      </button>
      {message ? <p role="status">{message}</p> : null}
      {attempt ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void read(false)}
        >
          只读刷新媒体状态
        </button>
      ) : null}
      {attempt && !pending ? (
        <button type="button" onClick={onLeave}>
          离开查看器（不重发）
        </button>
      ) : null}
      {confirmation ? (
        <LifecycleDialog
          title="移入回收站确认"
          busy={pending}
          onCancel={() => setConfirmation(null)}
        >
          <p>
            该媒体会从所有相册和普通浏览中隐藏，默认保留 30
            天。期间可按当前权限恢复。
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit()}
          >
            确认移入回收站
          </button>
        </LifecycleDialog>
      ) : null}
    </section>
  );
}
