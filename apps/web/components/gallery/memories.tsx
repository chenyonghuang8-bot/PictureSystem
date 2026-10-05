"use client";

import {
  memoriesPageSchema,
  memoriesPreviewSchema,
  type MemoriesItem,
  type MemoriesKind,
  type MemoriesContext,
} from "@family-album/contracts";
import { flushSync } from "react-dom";
import { useEffect, useState } from "react";
import { browserGalleryGet } from "../../lib/gallery-client.js";
import {
  MemoriesSession,
  type MemoriesState,
} from "../../lib/memories-session.js";
import { PhotoGrid } from "./photo-grid.js";
import { Viewer } from "./viewer.js";

export function memoriesPath(
  familyId: string,
  kind?: MemoriesKind,
  cursor?: string,
) {
  const base = `/api/v1/families/${familyId}/memories`;
  if (!kind) return base + "/preview";
  const query = new URLSearchParams({ kind, limit: "48" });
  if (cursor) query.set("cursor", cursor);
  return base + "?" + query;
}
const title = (kind: MemoriesKind) =>
  kind === "ON_THIS_DAY" ? "往年今日" : "一年前的这周";
function period(context: MemoriesContext, kind: MemoriesKind) {
  return kind === "ON_THIS_DAY"
    ? `${context.anchorDate.slice(5).replace("-", "月")}日 · 往年`
    : `${context.weekStart} 至 ${new Date(Date.parse(context.weekEnd + "T00:00:00Z") - 86400000).toISOString().slice(0, 10)}`;
}
export function Memories(props: {
  userId: string;
  familyId: string;
  kind?: MemoriesKind;
}) {
  return (
    <MemoriesBody
      key={`${props.userId}:${props.familyId}:${props.kind ?? "preview"}`}
      {...props}
    />
  );
}
function MemoriesBody({
  userId,
  familyId,
  kind,
}: {
  userId: string;
  familyId: string;
  kind?: MemoriesKind;
}) {
  const [state, setState] = useState<MemoriesState>({
    data: null,
    loading: true,
    error: null,
  });
  const [viewer, setViewer] = useState<{
    items: MemoriesItem[];
    index: number;
  } | null>(null);
  const [session, setSession] = useState<MemoriesSession | null>(null);
  useEffect(() => {
    const controller = new MemoriesSession(
      async (cursor, signal) => {
        const path = memoriesPath(familyId, kind, cursor);
        return kind
          ? browserGalleryGet(path, memoriesPageSchema, signal)
          : browserGalleryGet(path, memoriesPreviewSchema, signal);
      },
      (next) => {
        setState(next);
        if (!next.data) setViewer(null);
      },
    );
    setSession(controller);
    controller.activate();
    const visible = () =>
      flushSync(() => {
        if (document.visibilityState === "visible") controller.activate();
        else controller.suspend();
      });
    const resume = (event: Event) => {
      // The initial non-BFCache pageshow belongs to the already-started activation.
      if (
        event.type === "pageshow" &&
        !(event as PageTransitionEvent).persisted
      )
        return;
      flushSync(() => controller.activate());
    };
    const leave = () => flushSync(() => controller.suspend());
    const authLost = () => {
      controller.suspend();
      setState({ data: null, loading: false, error: "auth" });
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", leave);
    window.addEventListener("popstate", resume);
    window.addEventListener("family-auth-lost", authLost);
    return () => {
      controller.suspend();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("popstate", resume);
      window.removeEventListener("family-auth-lost", authLost);
    };
  }, [userId, familyId, kind]);
  const data = state.data;
  const groups = data
    ? "cards" in data
      ? data.cards
      : [
          {
            kind: data.kind,
            media: data.media,
            hasMore: Boolean(data.nextCursor),
          },
        ]
    : [];
  return (
    <section
      className={kind ? "memories-page" : "memories-home"}
      aria-label={kind ? title(kind) : "家庭回忆"}
    >
      {state.loading && !data ? <p role="status">正在查看回忆…</p> : null}
      {state.error ? (
        <p role="alert">
          {state.error === "auth"
            ? "请重新登录查看回忆。"
            : "暂时无法查看回忆。"}{" "}
          <button type="button" onClick={() => session?.activate()}>
            重试
          </button>
        </p>
      ) : null}
      {groups.map((group) => (
        <section
          className="memories-card"
          key={group.kind}
          aria-label={title(group.kind)}
        >
          <header>
            <h2>{title(group.kind)}</h2>
            {data ? <p>{period(data.context, group.kind)}</p> : null}
            {!kind ? (
              <a href={`/memories?kind=${group.kind}`}>查看全部</a>
            ) : null}
          </header>
          {group.media.length ? (
            <>
              <PhotoGrid
                items={group.media}
                onOpen={(id) =>
                  setViewer({
                    items: group.media,
                    index: group.media.findIndex((item) => item.mediaId === id),
                  })
                }
              />
              <div className="memories-dates">
                {group.media.map((item) => (
                  <span key={item.mediaId}>
                    {item.dateBasis === "UPLOAD_UTC" ? "上传日期" : "拍摄日期"}{" "}
                    {item.timelineDate}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="gallery-aside-note">这段时光还没有可查看的照片。</p>
          )}
          {kind && group.hasMore ? (
            <button
              type="button"
              className="gallery-text-button"
              disabled={state.loading}
              onClick={() => session?.loadMore()}
            >
              {state.loading ? "正在加载" : "加载更多"}
            </button>
          ) : null}
        </section>
      ))}
      {viewer ? (
        <Viewer
          userId={userId}
          familyId={familyId}
          items={viewer.items.map((item) => ({
            mediaId: item.mediaId,
            albumId: item.albumId,
          }))}
          index={viewer.index}
          onIndex={(index) => setViewer({ ...viewer, index })}
          onClose={() => setViewer(null)}
          onAuthLost={() => {
            session?.suspend();
            setViewer(null);
          }}
          onTrashed={() => session?.activate()}
        />
      ) : null}
    </section>
  );
}
