"use client";
import { useEffect, useRef, useState } from "react";
import {
  albumsResponseSchema,
  meResponseSchema,
  sortedTargets,
  uploadStep,
  queueFailure,
  ClientFault,
  checked,
  type ClientJob,
} from "@family-album/contracts";
import {
  digestFile,
  persistJob,
  savedJobs,
  webUploadRequest,
} from "../../lib/mobile-upload.js";
import { privateAlbumPage } from "../../lib/private-album-page.js";
const stageText: Record<string, string> = {
  WAITING: "等待上传",
  OBSERVING: "确认服务器进度",
  UPLOADING: "上传中",
  FINALIZING: "保存原始文件",
  PROCESSING: "生成预览",
  PLACING: "加入相册",
  PAUSED_AUTH: "请重新登录",
  RETRY_WAIT: "等待重试",
  PAUSED_USER: "已暂停",
  NEEDS_FILE: "请选择原文件",
  NEEDS_ACTION: "需要处理",
  DONE: "已加入相册",
};
export function MobileUploadPanel({
  userId,
  familyId,
}: {
  userId: string;
  familyId: string;
}) {
  const [validated, setValidated] = useState(false);
  const [jobs, setJobs] = useState<ClientJob[]>([]),
    [albums, setAlbums] = useState<
      ReturnType<typeof albumsResponseSchema.parse>["albums"]
    >([]),
    [after, setAfter] = useState<string | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [open, setOpen] = useState(false),
    [message, setMessage] = useState(""),
    [running, setRunning] = useState(false),
    [restore, setRestore] = useState<ClientJob | null>(null),
    [editing, setEditing] = useState<ClientJob | null>(null);
  const scope = useRef(""),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    files = useRef(new Map<string, File>()),
    busy = useRef(false),
    active = useRef(false);
  const refresh = async () => {
    const e = epoch.current;
    const list = await savedJobs(scope.current);
    if (e === epoch.current) setJobs(list);
  };
  const suspend = () => {
    epoch.current++;
    active.current = false;
    controller.current?.abort();
    files.current.clear();
    setJobs([]);
    setAlbums([]);
    setAfter(null);
    setValidated(false);
    setSelected([]);
    setOpen(false);
    setRestore(null);
    setEditing(null);
  };
  const activate = async () => {
    suspend();
    if (document.visibilityState !== "visible") return;
    const e = epoch.current;
    scope.current = `${window.location.origin}|${userId}|${familyId}`;
    controller.current = new AbortController();
    try {
      const me = meResponseSchema.parse(
        await (
          await webUploadRequest(
            "/api/v1/auth/me",
            {},
            controller.current.signal,
          )
        ).json(),
      );
      if (
        e !== epoch.current ||
        me.user.id !== userId ||
        !me.memberships.some((m) => m.familyId === familyId)
      )
        return;
      await refresh();
      if (e !== epoch.current) return;
      active.current = true;
      setValidated(true);
      const a = albumsResponseSchema.parse(
        await (
          await webUploadRequest(
            `/api/v1/albums?familyId=${familyId}&limit=50`,
            {},
            controller.current.signal,
          )
        ).json(),
      );
      if (e !== epoch.current) return;
      setAlbums(a.albums);
      setAfter(a.nextAfterId);
    } catch {
      if (e === epoch.current) {
        suspend();
        setMessage(
          "无法确认账号或保存上传记录，上传已暂停。请登录或允许浏览器本地存储。",
        );
      }
    }
  };
  useEffect(() => {
    void activate();
    const visibility = () => {
      if (document.visibilityState === "visible") void activate();
      else suspend();
    };
    const pageshow = (e: PageTransitionEvent) => {
      if (e.persisted) void activate();
    };
    const auth = () => {
      suspend();
      setMessage("登录已失效，请重新登录。原上传记录保留在所属账号中。");
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", pageshow);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("family-auth-lost", auth);
    return () => {
      suspend();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("family-auth-lost", auth);
    };
  }, [userId, familyId]);
  async function pick(input: FileList | null) {
    if (!input?.length || busy.current || !active.current) return;
    busy.current = true;
    setRunning(true);
    const e = epoch.current;
    try {
      const pending = jobs.filter((j) => j.stage !== "DONE");
      if (pending.length + input.length > 50)
        throw new ClientFault(400, "最多50个任务");
      let total = pending.reduce((n, j) => n + j.size, 0);
      for (const file of Array.from(input)) {
        if (
          !file.type.startsWith("image/") ||
          file.size <= 0 ||
          file.size > 256 * 1024 ** 2 ||
          total + file.size > 2 * 1024 ** 3
        )
          throw new ClientFault(400, "照片大小超出限制");
        const digest = await digestFile(
          file,
          () => e === epoch.current && active.current,
        );
        if (e !== epoch.current) return;
        if (restore) {
          if (file.size !== restore.size || digest !== restore.digest)
            throw new ClientFault(400, "所选照片内容不同，请选择原文件");
          files.current.set(restore.operationId, file);
          restore.stage = "WAITING";
          restore.failures = 0;
          await persistJob(restore);
          setRestore(null);
          break;
        }
        const ids = sortedTargets(selected);
        const job: ClientJob = {
          scope: scope.current,
          operationId: crypto.randomUUID(),
          name: file.name.normalize("NFC").slice(0, 255),
          mime: file.type || "application/octet-stream",
          size: file.size,
          digest,
          originalTargets: ids,
          targets: ids,
          source: "RESELECT_REQUIRED",
          offset: 0,
          stage: "WAITING",
          failures: 0,
          nextAttempt: 0,
        }; // Durable UUID+digest+immutable snapshot precedes the first HTTP request.
        await persistJob(job);
        if (e !== epoch.current) return;
        files.current.set(job.operationId, file);
        total += file.size;
      }
      await refresh();
      setOpen(false);
      setMessage("");
    } catch (err) {
      setMessage(
        err instanceof ClientFault && !err.code.includes("_")
          ? err.code
          : "无法保存任务，未开始上传。请允许本地存储后重试。",
      );
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }
  async function tick() {
    if (busy.current || !active.current) return;
    busy.current = true;
    const e = epoch.current;
    try {
      const current = await savedJobs(scope.current);
      const job = current.find(
        (j) =>
          !["DONE", "NEEDS_ACTION", "NEEDS_FILE", "PAUSED_USER"].includes(
            j.stage,
          ) && j.nextAttempt <= Date.now(),
      );
      if (!job || e !== epoch.current) return;
      const abort = new AbortController();
      controller.current = abort;
      const timeout = setTimeout(() => abort.abort(), 30000);
      try {
        await uploadStep(job, {
          active: () => active.current && e === epoch.current,
          request: async (path, init) => {
            const r = await webUploadRequest(path, init, abort.signal);
            if (e !== epoch.current) throw new ClientFault(0, "STALE");
            return r;
          },
          save: async (j) => {
            await persistJob(j);
            if (e === epoch.current) await refresh();
          },
          read: async (start, end) => {
            const file = files.current.get(job.operationId);
            if (!file) throw new ClientFault(400, "NEEDS_FILE");
            return new Uint8Array(await file.slice(start, end).arrayBuffer());
          },
        });
        job.nextAttempt =
          Date.now() + (job.stage === "PROCESSING" ? 5000 : 2000);
        if (job.stage === "DONE") files.current.delete(job.operationId);
      } catch (err) {
        if (err instanceof ClientFault && err.code === "NEEDS_FILE")
          job.stage = "NEEDS_FILE";
        else queueFailure(job, err);
      } finally {
        clearTimeout(timeout);
      }
      await persistJob(job);
      if (e === epoch.current) await refresh();
    } catch {
      if (e === epoch.current) setMessage("浏览器存储不可用，上传已暂停");
      active.current = false;
    } finally {
      busy.current = false;
    }
  }
  async function moreAlbums() {
    if (!active.current || !after || !controller.current) return;
    const e = epoch.current,
      cursor = after,
      signal = controller.current.signal;
    try {
      await privateAlbumPage(
        () =>
          webUploadRequest(
            `/api/v1/albums?familyId=${familyId}&limit=50&afterId=${cursor}`,
            {},
            signal,
          ),
        () => e === epoch.current && active.current && !signal.aborted,
        (a) => {
          setAlbums((old) => [...old, ...a.albums]);
          setAfter(a.nextAfterId);
        },
      );
    } catch {
      if (e === epoch.current && active.current)
        setMessage("无法读取更多相册，请重试。");
    }
  }
  useEffect(() => {
    const timer = setInterval(() => void tick(), 2000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="mobile-upload" aria-label="照片上传">
      <button
        className="mobile-upload-fab"
        disabled={!validated}
        type="button"
        onClick={() => {
          if (!active.current) return;
          setRestore(null);
          setEditing(null);
          setOpen(true);
        }}
      >
        ＋ 上传照片
      </button>
      {message ? <p role="alert">{message}</p> : null}
      {jobs.length ? (
        <details>
          <summary>
            上传队列 · {jobs.filter((j) => j.stage !== "DONE").length} 个待处理
          </summary>
          <p>
            前台上传。重新打开网页后，尚需传输的任务要重新选择内容相同的原文件；已上传成功的任务先查询服务器结果。清除站点数据会丢失本地任务编号，无法按原编号恢复。
          </p>
          {jobs.map((job) => (
            <div className="mobile-upload-job" key={job.operationId}>
              <strong>{job.name}</strong>
              <span>
                {job.stage === "DONE"
                  ? "已加入相册"
                  : job.stage === "NEEDS_FILE"
                    ? "请选择原文件"
                    : job.stage === "NEEDS_ACTION"
                      ? "需要处理"
                      : job.stage === "PROCESSING"
                        ? "生成预览中"
                        : `${Math.floor((job.offset / job.size) * 100)}% · ${stageText[job.stage] ?? "未完成"}`}
              </span>
              {job.stage !== "DONE" ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setRestore(job);
                      setEditing(null);
                      setOpen(true);
                    }}
                  >
                    重新选择原文件
                  </button>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                      job.stage = "WAITING";
                      job.failures = 0;
                      job.nextAttempt = 0;
                      void persistJob(job)
                        .then(refresh)
                        .catch(() => setMessage("无法保存任务"));
                    }}
                  >
                    观察并重试
                  </button>
                  {job.uploadId ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(job);
                        setSelected(job.targets);
                        setOpen(true);
                      }}
                    >
                      更换目标相册
                    </button>
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                disabled={running || busy.current}
                onClick={() => {
                  files.current.delete(job.operationId);
                  void persistJob(null, job.operationId).then(refresh);
                }}
              >
                移除本地记录
              </button>
            </div>
          ))}
        </details>
      ) : null}
      {open && validated ? (
        <div
          className="mobile-upload-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="选择照片上传"
        >
          <div className="mobile-upload-card">
            <h2>{restore ? "重新选择原照片" : "选择目标相册"}</h2>
            <p>不会压缩原文件。上传前必须能保存任务编号与照片内容摘要。</p>
            {!restore ? (
              albums
                .filter(
                  (a) =>
                    a.effectivePermissions.canView &&
                    (a.effectivePermissions.canEdit ||
                      a.effectivePermissions.canUpload),
                )
                .map((a) => (
                  <label key={a.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(a.id)}
                      onChange={() =>
                        setSelected((old) =>
                          old.includes(a.id)
                            ? old.filter((x) => x !== a.id)
                            : [...old, a.id],
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))
            ) : (
              <p>请选择与“{restore.name}”内容完全相同的文件。</p>
            )}
            {after && !restore ? (
              <button onClick={() => void moreAlbums()}>更多相册</button>
            ) : null}
            {editing ? (
              <button
                disabled={running || !selected.length}
                onClick={() => {
                  const e = epoch.current;
                  setRunning(true);
                  void webUploadRequest(
                    `/api/v1/uploads/${editing.uploadId}/targets`,
                    {
                      method: "PUT",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        albumIds: sortedTargets(selected),
                      }),
                    },
                  )
                    .then(checked)
                    .then(async () => {
                      if (e !== epoch.current) return;
                      editing.targets = sortedTargets(selected);
                      editing.stage = "WAITING";
                      editing.failures = 0;
                      await persistJob(editing);
                      await refresh();
                      setOpen(false);
                    })
                    .catch(() =>
                      setMessage(
                        "目标未更改：请确认当前权限，已APPLIED的目标不能重开",
                      ),
                    )
                    .finally(() => setRunning(false));
                }}
              >
                确认目标
              </button>
            ) : (
              <label className="mobile-file-pick">
                选择照片
                <input
                  aria-label={restore ? "重新选择原照片" : "选择多张照片"}
                  type="file"
                  accept="image/*"
                  multiple={!restore}
                  disabled={running || (!restore && !selected.length)}
                  onChange={(e) => {
                    void pick(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
            <button
              disabled={running}
              onClick={() => {
                setOpen(false);
                setRestore(null);
                setEditing(null);
              }}
            >
              关闭
            </button>
            {message ? <p role="alert">{message}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
