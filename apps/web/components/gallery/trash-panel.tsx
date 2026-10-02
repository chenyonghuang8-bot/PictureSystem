"use client";
import { useEffect, useRef, useState } from "react";
import { type trashPageSchema } from "@family-album/contracts";
import type { z } from "zod";
import { GalleryClientError } from "../../lib/gallery-client.js";
import {
  newAttempt,
  readTrash,
  readPurge,
  sendLifecycle,
  reauthenticate,
  requireLifecycleActor,
  unknownOutcome,
  lifecycleMessage,
  purgeMessage,
  type LifecycleAttempt,
  type TrashItem,
  type PurgeStatus,
} from "../../lib/trash-client.js";
import { LifecycleDialog } from "./lifecycle-dialog.js";

type Card = {
  attempt: LifecycleAttempt;
  accepted: boolean;
  status: PurgeStatus | null;
  message: string;
};
type Choice = {
  item: TrashItem;
  action: "restore" | "permanent-delete";
  reauth: boolean;
};
const eligibilityLabels = {
  NOT_ALLOWED: "当前不可永久删除",
  RETENTION_PENDING: "保留期未结束，可在所示时间之后刷新",
  REAUTH_REQUIRED: "验证身份后永久删除",
  READY: "永久删除",
};
export function TrashPanel({
  familyId,
  userId,
  initial,
}: {
  familyId: string;
  userId: string;
  initial: z.infer<typeof trashPageSchema>;
}) {
  const [items, setItems] = useState(initial.items),
    [cursor, setCursor] = useState(initial.nextCursor);
  const [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [signedOut, setSignedOut] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null),
    [cards, setCards] = useState<Card[]>([]),
    [uncertain, setUncertain] = useState<LifecycleAttempt[]>([]);
  const lock = useRef(false),
    readLock = useRef(false),
    alive = useRef(true),
    invalidIdentity = useRef(false);
  const loadedPages = useRef(1);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function clearIdentity() {
    invalidIdentity.current = true;
    if (!alive.current) return;
    setItems([]);
    setCursor(null);
    setCards([]);
    setUncertain([]);
    setChoice(null);
    setSignedOut(true);
    setNotice("请重新登录或返回当前家庭；旧操作不会自动重发。");
  }
  async function checkIdentity() {
    if (invalidIdentity.current)
      throw new GalleryClientError("UNAUTHENTICATED");
    try {
      await requireLifecycleActor(userId, familyId);
    } catch (error) {
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        clearIdentity();
      throw error;
    }
  }
  async function refresh(more = false, targetId?: string) {
    if (readLock.current || invalidIdentity.current) return null;
    readLock.current = true;
    setLoading(true);
    try {
      await checkIdentity();
      const maximumPages = targetId ? loadedPages.current : 1;
      const page = await readTrash(
        familyId,
        more ? (cursor ?? undefined) : undefined,
      );
      let visited = 1;
      while (
        !more &&
        targetId &&
        !page.items.some((i) => i.mediaId === targetId) &&
        page.nextCursor &&
        visited < maximumPages
      ) {
        const next = await readTrash(familyId, page.nextCursor);
        page.items = Array.from(
          new Map(
            [...page.items, ...next.items].map((i) => [i.mediaId, i]),
          ).values(),
        );
        page.nextCursor = next.nextCursor;
        visited++;
      }
      loadedPages.current = more ? loadedPages.current + 1 : visited;
      if (!alive.current || invalidIdentity.current) return null;
      setItems((current) =>
        more
          ? Array.from(
              new Map(
                [...current, ...page.items].map((i) => [i.mediaId, i]),
              ).values(),
            )
          : page.items,
      );
      setCursor(page.nextCursor);
      // A positive observation permits a fresh explicit confirmation. Absence is
      // never proof of success, and no pending POST is replayed.
      setUncertain((current) =>
        current.filter((a) => !page.items.some((i) => i.mediaId === a.mediaId)),
      );
      return page;
    } catch (error) {
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        clearIdentity();
      else if (alive.current)
        setNotice("状态读取失败，保留最后已知内容；可刷新状态。");
      return null;
    } finally {
      readLock.current = false;
      if (alive.current) setLoading(false);
    }
  }
  // Revalidate the page actor when returning to it. No mutation or task polling
  // is performed by effects. Component keys reset memory on family/actor change.
  useEffect(() => {
    const verify = () => {
      if (!document.hidden)
        void checkIdentity().catch((error) => {
          if (
            error instanceof GalleryClientError &&
            error.code === "UNAUTHENTICATED"
          )
            clearIdentity();
        });
    };
    document.addEventListener("visibilitychange", verify);
    verify();
    return () => document.removeEventListener("visibilitychange", verify);
  }, [familyId, userId]);
  async function ask(item: TrashItem, action: Choice["action"]) {
    if (choice || lock.current || readLock.current || invalidIdentity.current)
      return;
    setChoice(null);
    const page = await refresh(false, item.mediaId);
    if (!alive.current || invalidIdentity.current) return;
    const current = page?.items.find((i) => i.mediaId === item.mediaId);
    if (!current) {
      setNotice("当前页未找到目标，状态或权限可能已变化；不能据此确认删除。");
      return;
    }
    if (action === "restore" && !current.capabilities.canRestore) return;
    if (
      action === "permanent-delete" &&
      !["READY", "REAUTH_REQUIRED"].includes(
        current.capabilities.permanentDeleteEligibility,
      )
    )
      return;
    setChoice({
      item: current,
      action,
      reauth:
        action === "permanent-delete" &&
        current.capabilities.permanentDeleteEligibility === "REAUTH_REQUIRED",
    });
  }
  async function auth(password: string) {
    if (lock.current || !choice) return;
    lock.current = true;
    setBusy(true);
    const target = choice.item.mediaId;
    try {
      await checkIdentity();
      if (!alive.current || invalidIdentity.current) return;
      await reauthenticate(password);
      await checkIdentity();
      if (!alive.current || invalidIdentity.current) return;
      setChoice(null);
      const page = await refresh(false, target);
      if (!alive.current || invalidIdentity.current) return;
      const current = page?.items.find((i) => i.mediaId === target);
      if (current?.capabilities.permanentDeleteEligibility === "READY")
        setChoice({ item: current, action: "permanent-delete", reauth: false });
      else setNotice("状态或权限已变化，未提交永久删除请求。");
    } catch (error) {
      setChoice(null);
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        clearIdentity();
      else setNotice("身份验证未确认，请刷新后主动重新验证。");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function confirm() {
    if (lock.current || !choice || choice.reauth) return;
    lock.current = true;
    setBusy(true);
    const selected = choice;
    let attempt: LifecycleAttempt | null = null;
    try {
      await checkIdentity();
      if (!alive.current || invalidIdentity.current) return;
      const submitted = newAttempt(
        familyId,
        selected.item.mediaId,
        selected.item.lifecycleRevision,
        selected.action,
      );
      attempt = submitted;
      await sendLifecycle(submitted);
      await checkIdentity();
      if (!alive.current || invalidIdentity.current) return;
      setChoice(null);
      setItems((current) =>
        current.filter((i) => i.mediaId !== submitted.mediaId),
      );
      if (submitted.action === "permanent-delete")
        setCards((current) => [
          ...current,
          {
            attempt: submitted,
            accepted: true,
            status: null,
            message: "永久删除请求已接受，等待后台处理。",
          },
        ]);
      else setNotice("已恢复。");
      await refresh();
    } catch (error) {
      if (attempt && alive.current && !invalidIdentity.current) {
        try {
          await checkIdentity();
        } catch {
          /* No POST replay; mismatch clears identity. */
        }
      }
      if (!alive.current || invalidIdentity.current) return;
      setChoice(null);
      setNotice(lifecycleMessage(error));
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      ) {
        clearIdentity();
        return;
      }
      if (!attempt) {
        setNotice(
          "未能验证当前身份，旧确认已取消；未发送媒体操作。请刷新后重新确认。",
        );
        return;
      }
      const unresolved = attempt;
      if (unknownOutcome(error)) {
        if (attempt.action === "permanent-delete")
          setCards((current) => [
            ...current,
            {
              attempt: unresolved,
              accepted: false,
              status: null,
              message: "结果尚不能确认，请刷新状态；不要重复提交。",
            },
          ]);
        setUncertain((current) => [...current, unresolved]);
      } else await refresh();
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function status(card: Card) {
    if (
      readLock.current ||
      invalidIdentity.current ||
      card.status?.executionState === "DONE" ||
      card.status?.executionState === "BLOCKED"
    )
      return;
    readLock.current = true;
    setLoading(true);
    try {
      await checkIdentity();
      const row = await readPurge(familyId, card.attempt.operationId);
      if (!alive.current || invalidIdentity.current) return;
      setCards((current) =>
        current.map((c) =>
          c.attempt.operationId === card.attempt.operationId
            ? { ...c, accepted: true, status: row, message: purgeMessage(row) }
            : c,
        ),
      );
      setItems((current) =>
        current.filter((i) => i.mediaId !== card.attempt.mediaId),
      );
      setUncertain((current) =>
        current.filter((a) => a.mediaId !== card.attempt.mediaId),
      );
    } catch (error) {
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        clearIdentity();
      else if (alive.current)
        setCards((current) =>
          current.map((c) =>
            c.attempt.operationId === card.attempt.operationId
              ? {
                  ...c,
                  message:
                    "无法确认最新状态；列表缺席或状态 404 不证明操作完成。",
                }
              : c,
          ),
        );
    } finally {
      readLock.current = false;
      if (alive.current) setLoading(false);
    }
  }
  return (
    <div className="trash-panel" aria-busy={loading || busy}>
      <p>媒体默认保留 30 天。这里仅展示类型和日期，不显示照片预览。</p>
      <button
        type="button"
        disabled={loading || busy || signedOut || !!choice}
        onClick={() => void refresh()}
      >
        刷新状态
      </button>
      <p role="status" aria-live="polite">
        {notice}
      </p>
      {!signedOut && items.length === 0 ? <p>回收站为空。</p> : null}
      <ul className="trash-list">
        {items.map((item) => {
          const disabled =
            busy ||
            loading ||
            !!choice ||
            uncertain.some((a) => a.mediaId === item.mediaId) ||
            cards.some((c) => c.accepted && c.attempt.mediaId === item.mediaId);
          const eligibility = item.capabilities.permanentDeleteEligibility;
          return (
            <li key={item.mediaId}>
              <span className="trash-type" aria-hidden="true">
                {item.mediaType === "VIDEO" ? "▷" : "▧"}
              </span>
              <div>
                <h2>
                  {item.mediaType === "VIDEO" ? "视频" : "媒体"} ·{" "}
                  {item.mediaId.slice(-8)}
                </h2>
                <p>拍摄／时间线日期：{item.timelineKey}</p>
                <p>移入时间：{item.trashedAt}</p>
                <p>保留至：{item.purgeAfter}</p>
                <button
                  type="button"
                  disabled={disabled || !item.capabilities.canRestore}
                  onClick={() => void ask(item, "restore")}
                >
                  恢复
                </button>
                <button
                  type="button"
                  disabled={
                    disabled ||
                    !["READY", "REAUTH_REQUIRED"].includes(eligibility)
                  }
                  onClick={() => void ask(item, "permanent-delete")}
                >
                  {eligibilityLabels[eligibility]}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {cursor ? (
        <button
          type="button"
          disabled={loading || busy || signedOut || !!choice}
          onClick={() => void refresh(true)}
        >
          加载更多
        </button>
      ) : null}
      {uncertain.length ? (
        <p>部分操作尚未确认。只能刷新读取状态，不会自动重复提交。</p>
      ) : null}
      {cards.map((card) => (
        <section
          className="trash-status"
          key={card.attempt.operationId}
          aria-label="永久删除请求状态"
        >
          <h2>本次永久删除请求</h2>
          <p role="status">{card.message}</p>
          <button
            type="button"
            disabled={
              loading ||
              busy ||
              signedOut ||
              card.status?.executionState === "DONE" ||
              card.status?.executionState === "BLOCKED"
            }
            onClick={() => void status(card)}
          >
            读取请求状态
          </button>
          <p>离开或刷新页面后不保留此状态卡，后台任务继续。</p>
        </section>
      ))}
      {choice ? (
        <LifecycleDialog
          title={choice.action === "restore" ? "恢复媒体" : "永久删除确认"}
          busy={busy}
          onCancel={() => setChoice(null)}
        >
          <p>
            媒体 {choice.item.mediaId} · 当前版本{" "}
            {choice.item.lifecycleRevision}
          </p>
          {choice.reauth ? (
            <PasswordStep
              busy={busy}
              onSubmit={(password) => void auth(password)}
            />
          ) : (
            <>
              <p>
                {choice.action === "restore"
                  ? "恢复后可按当前权限浏览保留的相册关系。"
                  : "请求接受后无法恢复；由后台处理，完成时间不确定。不会立即释放空间，也不承诺安全擦除。"}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {choice.action === "restore" ? "确认恢复" : "确认请求永久删除"}
              </button>
            </>
          )}
        </LifecycleDialog>
      ) : null}
    </div>
  );
}
function PasswordStep({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = password;
        setPassword("");
        onSubmit(value);
      }}
    >
      <label>
        验证当前密码
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button type="submit" disabled={busy || !password}>
        验证身份
      </button>
    </form>
  );
}
