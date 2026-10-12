"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  familyAdminOverviewSchema,
  systemAdminStatusSchema,
  adminAuditResponseSchema,
  membersResponseSchema,
  memberSummarySchema,
  invitationsResponseSchema,
  createInvitationResponseSchema,
  type AdminMode,
  type MeResponse,
} from "@family-album/contracts";
import {
  browserGalleryGet,
  GalleryClientError,
} from "../../lib/gallery-client.js";
import { reauthenticate } from "../../lib/trash-client.js";
import {
  AdminActivation,
  adminSend,
  controlAttempt,
  exactBytes,
  observeControl,
  requireAdminIdentity,
  sendControl,
} from "../../lib/admin-client.js";

type Overview = z.infer<typeof familyAdminOverviewSchema>;
type System = z.infer<typeof systemAdminStatusSchema>;
type Audit = z.infer<typeof adminAuditResponseSchema>;
type Member = z.infer<typeof membersResponseSchema>["members"][number];
type Invite = z.infer<typeof invitationsResponseSchema>["invitations"][number];
type Identity = MeResponse["memberships"][number];
type Choice = { kind: "MODE" | "RECHECK"; target: AdminMode; revision: string };
const modeLabels = { NORMAL: "正常", READ_ONLY: "只读", MAINTENANCE: "维护" };
const workerLabels = {
  API: "服务端",
  DERIVATIVE: "图片处理",
  METADATA: "元数据处理",
  PURGE: "永久删除",
};

export function AdminWorkspace({
  userId,
  familyId,
}: {
  userId: string;
  familyId: string;
}) {
  const [overview, setOverview] = useState<Overview | null>(null),
    [system, setSystem] = useState<System | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null),
    [members, setMembers] = useState<Member[]>([]),
    [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<Audit | null>(null),
    [systemAudit, setSystemAudit] = useState<Audit | null>(null);
  const [source, setSource] = useState<"management" | "media">("management"),
    [days, setDays] = useState(7);
  const [notice, setNotice] = useState("正在验证当前管理权限…"),
    [systemNotice, setSystemNotice] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null),
    [password, setPassword] = useState(""),
    [memberPassword, setMemberPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const activation = useRef(new AdminActivation()),
    pending = useRef<string | null>(null),
    mutation = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const invalidate = useRef<() => void>(() => {});
  const familyBase = `/api/v1/families/${familyId}`;
  useEffect(() => {
    const scope = activation.current;
    let disposed = false,
      pollGeneration = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      scope.clear();
      setOverview(null);
      setSystem(null);
      setIdentity(null);
      setMembers([]);
      setInvites([]);
      setAudit(null);
      setSystemAudit(null);
      setChoice(null);
      setPassword("");
      setMemberPassword("");
      setInvitationUrl(null);
    };
    invalidate.current = clear;
    const refreshNow = async () => {
      if (disposed || document.hidden || mutation.current) return;
      const ticket = scope.begin();
      try {
        const who = await requireAdminIdentity(userId, familyId, ticket.signal);
        if (!scope.current(ticket)) return;
        setIdentity(who);
        const stats = await browserGalleryGet(
          `${familyBase}/admin/overview`,
          familyAdminOverviewSchema,
          ticket.signal,
        );
        if (!scope.current(ticket)) return;
        setOverview(stats);
        setNotice("");
        const [memberRows, invitations, events] = await Promise.all([
          browserGalleryGet(
            `${familyBase}/members`,
            membersResponseSchema,
            ticket.signal,
          ),
          browserGalleryGet(
            `${familyBase}/invitations`,
            invitationsResponseSchema,
            ticket.signal,
          ),
          browserGalleryGet(
            `${familyBase}/admin/audit?source=${source}&days=${days}&limit=25`,
            adminAuditResponseSchema,
            ticket.signal,
          ),
        ]);
        if (!scope.current(ticket)) return;
        setMembers(memberRows.members);
        setInvites(invitations.invitations);
        setAudit(events);
        try {
          const status = await browserGalleryGet(
            "/api/v1/admin/system/status",
            systemAdminStatusSchema,
            ticket.signal,
          );
          if (!scope.current(ticket)) return;
          setSystem(status);
          setSystemNotice("");
          const events = await browserGalleryGet(
            `/api/v1/admin/system/audit?days=${days}&limit=25`,
            adminAuditResponseSchema,
            ticket.signal,
          );
          if (!scope.current(ticket)) return;
          setSystemAudit(events);
          if (pending.current) {
            const op = await observeControl(pending.current, ticket.signal);
            if (!scope.current(ticket)) return;
            setSystemNotice(
              op.status === "PENDING"
                ? "操作已接收，正在等待在途处理排空或恢复证明。"
                : op.status === "APPLIED"
                  ? "操作已完成；请以当前模式和健康状态判断是否可写。"
                  : "操作保持保护状态，需要检查健康原因。不会自动重发。",
            );
            if (op.status !== "PENDING") pending.current = null;
          }
        } catch (error) {
          if (!scope.current(ticket)) return;
          if (
            error instanceof GalleryClientError &&
            error.code === "UNAUTHENTICATED"
          )
            throw error;
          setSystem(null);
          setSystemAudit(null);
          setChoice(null);
          setPassword("");
          setSystemNotice(
            error instanceof GalleryClientError && error.code === "FORBIDDEN"
              ? "当前账号没有系统管理权限。"
              : "系统状态暂不可确认；已有操作不会自动重发。",
          );
        }
      } catch (error) {
        if (!scope.current(ticket)) return;
        clear();
        setNotice(
          error instanceof GalleryClientError &&
            ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
            ? "管理权限或家庭身份已变化，请重新登录或返回当前家庭。"
            : "管理数据暂不可用，请稍后刷新。",
        );
      }
    };
    const poll = async (generation: number) => {
      if (generation !== pollGeneration) return;
      await refreshNow();
      if (!disposed && !document.hidden && generation === pollGeneration)
        timer = setTimeout(() => {
          void poll(generation);
        }, 5000);
    };
    refresh.current = refreshNow;
    const pause = () => {
      pollGeneration++;
      if (timer) clearTimeout(timer);
      clear();
    };
    const visible = () => {
      pause();
      if (!document.hidden) void poll(pollGeneration);
    };
    const leave = () => pause();
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) visible();
    };
    const authLost = () => {
      pending.current = null;
      pause();
      setNotice("登录状态已失效，请重新登录。");
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    window.addEventListener("family-auth-lost", authLost);
    void poll(pollGeneration);
    return () => {
      disposed = true;
      scope.clear();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("family-auth-lost", authLost);
    };
  }, [userId, familyId, familyBase, source, days]);

  async function memberAction(
    path: string,
    body: unknown,
    method: "POST" | "PATCH" = "POST",
    invite = false,
  ) {
    if (mutation.current || document.hidden) return;
    if (!memberPassword) {
      setNotice("请先输入成员管理验证密码。");
      return;
    }
    const proof = memberPassword;
    setMemberPassword("");
    mutation.current = true;
    setBusy(true);
    setInvitationUrl(null);
    const ticket = activation.current.begin();
    try {
      await requireAdminIdentity(userId, familyId, ticket.signal);
      if (!activation.current.current(ticket)) return;
      await reauthenticate(proof);
      await requireAdminIdentity(userId, familyId, ticket.signal);
      if (!activation.current.current(ticket)) return;
      if (invite) {
        const row = await adminSend(
          path,
          createInvitationResponseSchema,
          body,
          method,
        );
        if (activation.current.current(ticket))
          setInvitationUrl(row.invitationUrl);
      } else if (method === "PATCH")
        await adminSend(path, memberSummarySchema, body, method);
      else await adminSend(path, z.undefined(), body, method);
      if (activation.current.current(ticket))
        setNotice(
          invite ? "邀请链接只在此处展示，请妥善保存。" : "操作已确认。",
        );
    } catch (error) {
      if (
        activation.current.current(ticket) &&
        error instanceof GalleryClientError &&
        ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
      )
        invalidate.current();
      if (activation.current.current(ticket))
        setNotice(
          error instanceof GalleryClientError && error.code === "FORBIDDEN"
            ? "当前权限不允许该操作，请刷新。"
            : "操作结果未确认；请观察最新成员/邀请状态后再决定，不会自动重发。",
        );
    } finally {
      mutation.current = false;
      setBusy(false);
    }
    await refresh.current();
  }
  async function applyMode() {
    if (
      !choice ||
      !password ||
      mutation.current ||
      document.hidden ||
      pending.current
    )
      return;
    const selected = choice,
      proof = password;
    setPassword("");
    mutation.current = true;
    setBusy(true);
    const ticket = activation.current.begin();
    try {
      await requireAdminIdentity(userId, familyId, ticket.signal);
      if (!activation.current.current(ticket)) return;
      await reauthenticate(proof);
      await requireAdminIdentity(userId, familyId, ticket.signal);
      if (!activation.current.current(ticket)) return;
      const attempt = controlAttempt(
        selected.revision,
        selected.target,
        selected.kind,
      );
      pending.current = attempt.operationId;
      try {
        const result = await sendControl(attempt);
        if (!activation.current.current(ticket)) return;
        setSystemNotice(
          result.status === "APPLIED"
            ? "操作已记录，正在重新核对当前状态。"
            : "已接收；排空完成前仍可能有在途处理。",
        );
      } catch (error) {
        if (!activation.current.current(ticket)) return;
        if (error instanceof GalleryClientError && error.code === "FORBIDDEN") {
          setSystem(null);
          setSystemAudit(null);
        }
        if (
          error instanceof GalleryClientError &&
          ["CONFLICT", "FORBIDDEN", "INVALID_REQUEST"].includes(error.code)
        )
          pending.current = null;
        setSystemNotice(
          error instanceof GalleryClientError && error.code === "CONFLICT"
            ? "状态修订已变化，请刷新后重新确认。"
            : "结果未确认，只查询此操作，不会重新发送模式请求。",
        );
      }
    } catch {
      if (activation.current.current(ticket))
        setSystemNotice(
          "重新验证未确认，请重新登录后再操作。尚未发送模式请求。",
        );
    } finally {
      mutation.current = false;
      setBusy(false);
      setChoice(null);
      setPassword("");
    }
    await refresh.current();
  }
  async function moreAudit(systemScope = false) {
    const page = systemScope ? systemAudit : audit;
    if (!page?.nextCursor || mutation.current) return;
    const ticket = activation.current.begin();
    try {
      await requireAdminIdentity(userId, familyId, ticket.signal);
      const path = systemScope
        ? "/api/v1/admin/system/audit"
        : `${familyBase}/admin/audit`;
      const next = await browserGalleryGet(
        `${path}?source=${systemScope ? "management" : source}&days=${days}&limit=25&cursor=${encodeURIComponent(page.nextCursor)}`,
        adminAuditResponseSchema,
        ticket.signal,
      );
      if (!activation.current.current(ticket)) return;
      const joined = { ...next, events: [...page.events, ...next.events] };
      if (systemScope) setSystemAudit(joined);
      else setAudit(joined);
    } catch {
      if (activation.current.current(ticket))
        setNotice("审计页暂不可用，请刷新当前权限和筛选。");
    }
  }
  return (
    <div className="admin-workspace">
      <header>
        <h1>家庭管理</h1>
        <p>当前可见照片与家庭事务。系统操作需要独立授权。</p>
        <button
          type="button"
          onClick={() => void refresh.current()}
          disabled={busy}
        >
          刷新
        </button>
      </header>
      {notice ? <p role="status">{notice}</p> : null}
      {overview && (
        <>
          <section className="admin-stats" aria-label="当前可见媒体统计">
            <article>
              <h2>照片</h2>
              <strong>{overview.photos}</strong>
            </article>
            <article>
              <h2>视频</h2>
              <strong>{overview.videos}</strong>
            </article>
            <article>
              <h2>回收站</h2>
              <strong>{overview.trash}</strong>
              <a href="/trash">查看、恢复与永久删除</a>
            </article>
            <article>
              <h2>媒体写入</h2>
              <strong>
                {overview.mediaControl === "WRITABLE"
                  ? "可写"
                  : overview.mediaControl === "PAUSED"
                    ? "暂停"
                    : "不可用"}
              </strong>
            </article>
          </section>
          <section className="admin-card">
            <h2>存储用量</h2>
            <p>以下仅包含当前权限可见媒体，同一媒体的多个相册关系只计一次。</p>
            <dl>
              <dt>逻辑用量</dt>
              <dd>{exactBytes(overview.visibleLogicalBytes)}</dd>
              <dt>引用的原始文件</dt>
              <dd>{exactBytes(overview.visibleReferencedStorageBytes)}</dd>
              <dt>当前衍生图片</dt>
              <dd>{exactBytes(overview.visibleDerivedBytes)}</dd>
            </dl>
            <h3>各成员上传量</h3>
            {overview.uploaders.length ? (
              <ul>
                {overview.uploaders.map((u) => (
                  <li key={u.memberId}>
                    成员 {u.memberId}：{u.mediaCount} 项，
                    {exactBytes(u.logicalBytes)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>当前没有可见上传。</p>
            )}
          </section>
          <section className="admin-card">
            <h2>成员与邀请</h2>
            <label>
              成员管理验证密码
              <input
                type="password"
                autoComplete="current-password"
                value={memberPassword}
                onChange={(e) => setMemberPassword(e.target.value)}
              />
            </label>
            <ul>
              {members.map((m) => (
                <li key={m.id}>
                  <span>
                    {m.displayName ?? m.username} · {m.role} ·{" "}
                    {m.disabled ? "已停用" : "启用"}
                  </span>
                  {identity &&
                  m.role !== "SUPER_ADMIN" &&
                  m.id !== identity.id &&
                  (identity.role === "SUPER_ADMIN" || m.role === "MEMBER") ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void memberAction(
                            `${familyBase}/members/${m.id}`,
                            { disabled: !m.disabled },
                            "PATCH",
                          )
                        }
                      >
                        {m.disabled ? "恢复成员" : "停用成员"}
                      </button>
                      {identity.role === "SUPER_ADMIN" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void memberAction(
                              `${familyBase}/members/${m.id}`,
                              {
                                role: m.role === "MEMBER" ? "ADMIN" : "MEMBER",
                              },
                              "PATCH",
                            )
                          }
                        >
                          {m.role === "MEMBER" ? "设为管理员" : "设为成员"}
                        </button>
                      )}
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void memberAction(
                  `${familyBase}/invitations`,
                  { role: "MEMBER", expiresInHours: 48 },
                  "POST",
                  true,
                )
              }
            >
              邀请成员
            </button>
            {identity?.role === "SUPER_ADMIN" && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void memberAction(
                    `${familyBase}/invitations`,
                    { role: "ADMIN", expiresInHours: 48 },
                    "POST",
                    true,
                  )
                }
              >
                邀请管理员
              </button>
            )}
            {invitationUrl && (
              <p>
                一次展示的邀请链接：
                <a href={invitationUrl} rel="noreferrer">
                  {invitationUrl}
                </a>
                <button type="button" onClick={() => setInvitationUrl(null)}>
                  关闭链接
                </button>
              </p>
            )}
            <ul>
              {invites.map((i) => (
                <li key={i.id}>
                  邀请 {i.id} · {i.role} · {i.status} · 到期 {i.expiresAt}
                  {i.status === "PENDING" &&
                    (identity?.role === "SUPER_ADMIN" ||
                      i.role === "MEMBER") && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void memberAction(
                            `${familyBase}/invitations/${i.id}/revoke`,
                            {},
                          )
                        }
                      >
                        撤销邀请
                      </button>
                    )}
                </li>
              ))}
            </ul>
          </section>
          <section className="admin-card">
            <h2>备份与完整性</h2>
            <p>备份：{overview.backups.state} · 尚无已确认的成功记录。</p>
            <p>
              完整性检查：{overview.integrity.state} · 尚无已确认的成功记录。
            </p>
          </section>
        </>
      )}
      <section className="admin-card">
        <h2>家庭审计</h2>
        <label>
          来源
          <select
            value={source}
            onChange={(e) => {
              setAudit(null);
              setSource(e.target.value as typeof source);
            }}
          >
            <option value="management">成员与管理事务</option>
            <option value="media">当前可见媒体</option>
          </select>
        </label>
        <label>
          时间
          <select
            value={days}
            onChange={(e) => {
              setAudit(null);
              setDays(Number(e.target.value));
            }}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
        </label>
        <AuditList page={audit} />
        <button
          type="button"
          disabled={!audit?.nextCursor || busy}
          onClick={() => void moreAudit()}
        >
          更多审计
        </button>
      </section>
      <section className="admin-card">
        <h2>系统管理</h2>
        {systemNotice && <p role="status">{systemNotice}</p>}
        {system && (
          <>
            <p>
              当前 {modeLabels[system.enforcedMode]} · 请求{" "}
              {modeLabels[system.requestedMode]} · {system.transitionState} ·
              修订 {system.revision}
            </p>
            <p>
              保护：
              {system.faultLatched || system.localDeny
                ? "已启用"
                : "未锁存"} ·{" "}
              {system.reasonCode === "STARTUP_RECHECK_REQUIRED"
                ? "启动安全未确认，需要检查"
                : system.reasonCode}
            </p>
            <h3>数据库与存储健康</h3>
            <p>
              数据库 {system.observations.database.state} ·{" "}
              {system.observations.database.observedAt}
            </p>
            <p>
              存储 {system.observations.storage.state} ·{" "}
              {system.observations.storage.reasonCode}
            </p>
            {system.observations.storage.availableBytes !== null && (
              <p>
                设备可用{" "}
                {exactBytes(system.observations.storage.availableBytes)} /
                总容量 {exactBytes(system.observations.storage.totalBytes!)}
              </p>
            )}
            <p>
              全局原始文件{" "}
              {exactBytes(system.observations.accounting.storedOriginalBytes)}
              ；未写入预约{" "}
              {exactBytes(system.observations.accounting.reservedFutureBytes)}
              ；保留 staging{" "}
              {exactBytes(system.observations.accounting.retainedStagingBytes)}
              ；衍生总账{" "}
              {exactBytes(system.observations.accounting.derivedBytes)}
              ；未收口衍生{" "}
              {exactBytes(system.observations.accounting.unsettledDerivedBytes)}
              。
            </p>
            <h3>后台处理</h3>
            <ul>
              {system.observations.workers.map((w) => (
                <li key={w.role}>
                  {workerLabels[w.role]}：{w.state} · 完成{" "}
                  {w.completedUnits ?? "未知"} · 心跳{" "}
                  {w.observation.observedAt ?? "无记录"} · 最近成功{" "}
                  {w.lastSuccessfulAt ?? "无记录"}
                </li>
              ))}
            </ul>
            <div className="admin-mode-actions">
              {(["READ_ONLY", "MAINTENANCE", "NORMAL"] as const).map(
                (target) => (
                  <button
                    type="button"
                    key={target}
                    disabled={
                      busy ||
                      !!pending.current ||
                      (target === "NORMAL" &&
                        (system.transitionState !== "STABLE" ||
                          system.faultLatched))
                    }
                    onClick={() => {
                      setPassword("");
                      setChoice({
                        kind: "MODE",
                        target,
                        revision: system.revision,
                      });
                    }}
                  >
                    切换到{modeLabels[target]}
                  </button>
                ),
              )}
              <button
                type="button"
                disabled={busy || !!pending.current}
                onClick={() => {
                  setPassword("");
                  setChoice({
                    kind: "RECHECK",
                    target: system.enforcedMode,
                    revision: system.revision,
                  });
                }}
              >
                重核恢复证明
              </button>
            </div>
            <h3>系统审计</h3>
            <AuditList page={systemAudit} />
            <button
              type="button"
              disabled={!systemAudit?.nextCursor || busy}
              onClick={() => void moreAudit(true)}
            >
              更多系统审计
            </button>
          </>
        )}
      </section>
      {choice && (
        <div className="lifecycle-dialog-backdrop">
          <form
            className="lifecycle-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-confirm-title"
            onSubmit={(e) => {
              e.preventDefault();
              void applyMode();
            }}
          >
            <h2 id="admin-confirm-title">
              {choice.kind === "RECHECK"
                ? "重核恢复证明"
                : `切换到${modeLabels[choice.target]}`}
            </h2>
            <p>
              此操作影响所有家庭、服务端及后台
              worker。收紧模式先暂停新写入，再等待在途处理排空；恢复需新鲜健康与存储证明。不会忽略保护或自动恢复正常。
            </p>
            <p>确认修订 {choice.revision}</p>
            <label>
              重新验证密码
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button disabled={busy || !password}>验证并确认</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setChoice(null);
                setPassword("");
              }}
            >
              取消
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
function AuditList({ page }: { page: Audit | null }) {
  if (!page) return <p>暂无已确认的审计数据。</p>;
  if (!page.events.length) return <p>当前权限与筛选下没有记录。</p>;
  return (
    <ul className="admin-audit">
      {page.events.map((e) => (
        <li key={e.id}>
          <time>{e.createdAt}</time>
          <span>
            {e.action} · {e.resultCategory}
          </span>
          <span>
            {e.targetType} {e.targetId}
          </span>
        </li>
      ))}
    </ul>
  );
}
