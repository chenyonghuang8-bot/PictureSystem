"use client";

import {
  favoriteStateSchema,
  featuredStateSchema,
  mediaTagResponseSchema,
  mediaTagRemovalSchema,
  mediaNoteResponseSchema,
  mediaCommentPageSchema,
  mediaCommentResponseSchema,
  type GalleryMediaDetail,
} from "@family-album/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  browserGalleryGet,
  browserGallerySend,
  GalleryClientError,
} from "../../lib/gallery-client.js";
import {
  galleryQuery,
  mediaFeaturePath,
  originalDownloadPath,
  previewDownloadPath,
} from "../../lib/gallery-paths.js";
import type { ViewerTarget } from "./viewer.js";

type CommentPage = z.infer<typeof mediaCommentPageSchema>;

export function ViewerComment({
  comment,
  pending,
  onDelete,
}: {
  comment: CommentPage["comments"][number];
  pending: boolean;
  onDelete: () => void;
}) {
  return (
    <li>
      <span>{comment.author.displayName}</span>
      <p className="gallery-viewer-text">{comment.body}</p>
      <time dateTime={comment.createdAt}>{comment.createdAt.slice(0, 10)}</time>
      {comment.canDelete ? (
        <button
          type="button"
          aria-label={`删除评论 ${comment.author.displayName}`}
          disabled={pending}
          onClick={onDelete}
        >
          删除
        </button>
      ) : null}
    </li>
  );
}

export function viewerErrorMessage(error: unknown) {
  if (error instanceof GalleryClientError) {
    if (error.code === "UNAUTHENTICATED") return "登录已失效，请重新登录。";
    if (error.code === "NOT_FOUND") return "没有找到这张照片。";
    if (error.code === "FORBIDDEN") return "当前没有操作权限。";
    if (error.code === "CONFLICT")
      return "备注已被其他人更新，已重新加载最新版本，请确认后再编辑。";
  }
  return "操作未完成，请检查输入或稍后再试。";
}

// All private state lives in the keyed Viewer session. There is no shared cache.
export function ViewerDetails({
  detail,
  target,
  reload,
  onFailure,
}: {
  detail: GalleryMediaDetail;
  target: ViewerTarget;
  reload: () => Promise<void>;
  onFailure: (error: unknown) => void;
}) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const active = useRef(new Set<string>());
  const alive = useRef(false);
  const [message, setMessage] = useState("");
  const [tagName, setTagName] = useState("");
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [noteRevision, setNoteRevision] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [comments, setComments] = useState<CommentPage | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const commentsRequest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const path = (
    feature: "favorite" | "featured" | "tags" | "note" | "comments",
    id?: string,
  ) => mediaFeaturePath(target.albumId, target.mediaId, feature, id);

  async function loadComments(append = false) {
    const request = ++commentsRequest.current;
    const page = await browserGalleryGet(
      galleryQuery(path("comments"), {
        limit: 20,
        cursor: append ? (comments?.nextCursor ?? undefined) : undefined,
      }),
      mediaCommentPageSchema,
    );
    if (!alive.current || request !== commentsRequest.current) return;
    setComments((current) => {
      if (!append || !current) return page;
      const ids = new Set(current.comments.map((comment) => comment.id));
      return {
        comments: current.comments.concat(
          page.comments.filter((comment) => !ids.has(comment.id)),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  async function run(key: string, operation: () => Promise<void>) {
    // A synchronous guard also blocks rapid duplicate actions before React renders.
    if (active.current.has(key)) return;
    active.current.add(key);
    setPending(new Set(active.current));
    setMessage("");
    try {
      await operation();
    } catch (error) {
      if (!alive.current) return;
      setMessage(viewerErrorMessage(error));
      onFailure(error);
    } finally {
      active.current.delete(key);
      if (alive.current) setPending(new Set(active.current));
    }
  }

  async function saveNote() {
    try {
      await browserGallerySend("PUT", path("note"), mediaNoteResponseSchema, {
        note: noteDraft,
        expectedRevision: noteRevision,
      });
    } catch (error) {
      if (error instanceof GalleryClientError && error.code === "CONFLICT") {
        if (!alive.current) return;
        setNoteDraft(null);
        setNoteRevision(null);
        await reload();
      }
      throw error;
    }
    if (!alive.current) return;
    setNoteDraft(null);
    setNoteRevision(null);
    await reload();
  }

  const busy = (key: string) => pending.has(key);
  const metadata = [
    detail.displayWidth && detail.displayHeight
      ? `${detail.displayWidth} × ${detail.displayHeight}`
      : null,
    detail.orientation ? `方向 ${detail.orientation}` : null,
    detail.capturedLocalAt,
    [detail.cameraMake, detail.cameraModel].filter(Boolean).join(" ") || null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <section className="gallery-viewer-details" aria-label="照片详情">
      <p className="gallery-viewer-meta">{metadata}</p>
      <div className="gallery-viewer-actions">
        <button
          type="button"
          aria-pressed={detail.isFavorite}
          disabled={busy("favorite")}
          onClick={() =>
            void run("favorite", async () => {
              await browserGallerySend(
                detail.isFavorite ? "DELETE" : "PUT",
                path("favorite"),
                favoriteStateSchema,
                {},
              );
              if (alive.current) await reload();
            })
          }
        >
          {detail.isFavorite ? "取消收藏" : "收藏"}
        </button>
        {detail.capabilities.canManageFeatured ? (
          <button
            type="button"
            aria-pressed={detail.isFamilyFeatured}
            disabled={busy("featured")}
            onClick={() =>
              void run("featured", async () => {
                await browserGallerySend(
                  detail.isFamilyFeatured ? "DELETE" : "PUT",
                  path("featured"),
                  featuredStateSchema,
                  {},
                );
                if (alive.current) await reload();
              })
            }
          >
            {detail.isFamilyFeatured ? "取消家庭精选" : "设为家庭精选"}
          </button>
        ) : (
          <span>{detail.isFamilyFeatured ? "家庭精选" : "未设为家庭精选"}</span>
        )}
      </div>
      <section aria-label="标签">
        <h2>标签</h2>
        <ul className="gallery-viewer-tags">
          {detail.tags.map((tag) => (
            <li key={tag.id}>
              <span>{tag.name}</span>
              {detail.capabilities.canEditTags ? (
                <button
                  type="button"
                  aria-label={`移除标签 ${tag.name}`}
                  disabled={busy("tags")}
                  onClick={() =>
                    void run("tags", async () => {
                      await browserGallerySend(
                        "DELETE",
                        path("tags", tag.id),
                        mediaTagRemovalSchema,
                        {},
                      );
                      if (alive.current) await reload();
                    })
                  }
                >
                  移除
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {detail.capabilities.canEditTags ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("tags", async () => {
                await browserGallerySend(
                  "POST",
                  path("tags"),
                  mediaTagResponseSchema,
                  { name: tagName },
                );
                if (!alive.current) return;
                setTagName("");
                await reload();
              });
            }}
          >
            <label>
              新标签
              <input
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                disabled={busy("tags")}
                required
              />
            </label>
            <button disabled={busy("tags")} type="submit">
              添加标签
            </button>
          </form>
        ) : null}
      </section>
      <section aria-label="备注">
        <h2>备注</h2>
        <p className="gallery-viewer-text">{detail.note || "暂无备注"}</p>
        {detail.capabilities.canEditNote ? (
          noteDraft === null ? (
            <button
              type="button"
              onClick={() => {
                setNoteDraft(detail.note ?? "");
                setNoteRevision(detail.noteRevision);
              }}
            >
              编辑备注
            </button>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run("note", saveNote);
              }}
            >
              <label>
                照片备注
                <textarea
                  autoFocus
                  value={noteDraft}
                  disabled={busy("note")}
                  onChange={(event) => setNoteDraft(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy("note")}>
                保存备注
              </button>
              <button
                type="button"
                disabled={busy("note")}
                onClick={() => {
                  setNoteDraft(null);
                  setNoteRevision(null);
                }}
              >
                取消编辑
              </button>
            </form>
          )
        ) : null}
      </section>
      <section aria-label="评论">
        <h2>评论（{detail.commentCount}）</h2>
        <button
          type="button"
          disabled={busy("comments-load")}
          onClick={() => {
            if (commentsOpen) {
              setCommentsOpen(false);
              return;
            }
            setCommentsOpen(true);
            void run("comments-load", () => loadComments());
          }}
        >
          {commentsOpen ? "收起评论" : "查看评论"}
        </button>
        {commentsOpen ? (
          <>
            <ul className="gallery-viewer-comments">
              {comments?.comments.map((comment) => (
                <ViewerComment
                  key={comment.id}
                  comment={comment}
                  pending={
                    busy("comment-delete") ||
                    busy("comments-load") ||
                    busy("comment-create")
                  }
                  onDelete={() =>
                    void run("comment-delete", async () => {
                      await browserGallerySend(
                        "DELETE",
                        path("comments", comment.id),
                        z.undefined(),
                        {},
                      );
                      if (!alive.current) return;
                      await loadComments();
                      await reload();
                    })
                  }
                />
              ))}
            </ul>
            {comments?.nextCursor ? (
              <button
                type="button"
                disabled={
                  busy("comments-load") ||
                  busy("comment-create") ||
                  busy("comment-delete")
                }
                onClick={() =>
                  void run("comments-load", () => loadComments(true))
                }
              >
                加载更多评论
              </button>
            ) : null}
            {detail.capabilities.canComment ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run("comment-create", async () => {
                    await browserGallerySend(
                      "POST",
                      path("comments"),
                      mediaCommentResponseSchema,
                      { body: commentBody },
                    );
                    if (!alive.current) return;
                    setCommentBody("");
                    await loadComments();
                    await reload();
                  });
                }}
              >
                <label>
                  新评论
                  <textarea
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    disabled={busy("comment-create")}
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    busy("comment-create") ||
                    busy("comments-load") ||
                    busy("comment-delete")
                  }
                >
                  发表评论
                </button>
              </form>
            ) : null}
          </>
        ) : null}
      </section>
      <div className="gallery-viewer-actions" aria-label="下载">
        {detail.capabilities.canDownloadOriginal ? (
          <a href={originalDownloadPath(target.albumId, target.mediaId)}>
            下载原图
          </a>
        ) : null}
        {detail.capabilities.canDownloadPreview ? (
          <a href={previewDownloadPath(target.albumId, target.mediaId)}>
            下载预览
          </a>
        ) : null}
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
