import { useEffect, useState, useSyncExternalStore, useRef } from "react";
import {
  AppState,
  BackHandler,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
  Linking,
  Alert,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import {
  albumsResponseSchema,
  familyTimelinePageSchema,
  galleryMediaPageSchema,
  galleryMediaDetailSchema,
  memoriesPageSchema,
  type FamilyTimelinePage,
  type GalleryMediaDetail,
  type ClientJob,
  ClientFault,
} from "@family-album/contracts";
import { session, request } from "../lib/session";
import { PrivateImage, clearMedia, exportPhoto } from "../lib/media";
import {
  openQueue,
  listJobs,
  onQueue,
  selectPhotos,
  pumpQueue,
  retryJob,
  reselectJob,
  deleteJob,
  changeTargets,
} from "../lib/queue";
import {
  acceptLink,
  pendingInvitation,
  previewInvitation,
  consumeInvitation,
  clearInvitation,
} from "../lib/invitations";

type Tab = "photos" | "albums" | "memories" | "my";
type Album = ReturnType<typeof albumsResponseSchema.parse>["albums"][number];
type Item = FamilyTimelinePage["media"][number];
const titles = { photos: "照片", albums: "相册", memories: "回忆", my: "我的" };
const stageLabel: Record<string, string> = {
  COPYING: "保存原始照片",
  WAITING: "等待上传",
  OBSERVING: "确认服务器进度",
  UPLOADING: "上传中",
  FINALIZING: "保存原始文件",
  PROCESSING: "生成预览",
  PLACING: "加入相册",
  DONE: "已加入相册",
  NEEDS_ACTION: "需要处理",
  PAUSED_AUTH: "请重新登录",
  RETRY_WAIT: "等待重试",
  PAUSED_USER: "已暂停",
};
function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[s.button, secondary && s.secondary, disabled && { opacity: 0.5 }]}
    >
      <Text style={[s.buttonText, secondary && { color: "#3c6850" }]}>
        {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  set,
  secret = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  secret?: boolean;
}) {
  return (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      value={value}
      onChangeText={set}
      secureTextEntry={secret}
      autoCapitalize="none"
      autoCorrect={false}
      style={s.input}
    />
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <AlbumApp />
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
function AlbumApp() {
  const auth = useSyncExternalStore(
    session.subscribe,
    session.get,
    session.get,
  );
  const [tab, setTab] = useState<Tab>("photos"),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Item[]>([]),
    [albums, setAlbums] = useState<Album[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [afterAlbum, setAfterAlbum] = useState<string | null>(null),
    [album, setAlbum] = useState<Album | null>(null),
    [viewer, setViewer] = useState<{ item: Item; index: number } | null>(null),
    [detail, setDetail] = useState<GalleryMediaDetail | null>(null);
  const [search, setSearch] = useState(""),
    [fromDate, setFromDate] = useState(""),
    [toDate, setToDate] = useState(""),
    [favorite, setFavorite] = useState(false),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("ON_THIS_DAY"),
    [anchor, setAnchor] = useState("");
  const [jobs, setJobs] = useState<ClientJob[]>([]),
    [queueReady, setQueueReady] = useState(false),
    [uploadOpen, setUploadOpen] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [targetJob, setTargetJob] = useState<ClientJob | null>(null),
    [invitation, setInvitation] =
      useState<Awaited<ReturnType<typeof previewInvitation>>>(null),
    [hasInvite, setHasInvite] = useState(false),
    [newPassword, setNewPassword] = useState("");
  const bootstrapUsed = useRef(false);
  const generation = useRef(0),
    deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const family = auth.me?.memberships.find((m) => m.familyId === auth.familyId);
  const report = (e: unknown) =>
    setMessage(
      e instanceof ClientFault
        ? e.status === 401
          ? "请重新登录"
          : e.status === 403
            ? "当前没有操作权限"
            : e.code.includes("_")
              ? "操作未完成，请重试或确认服务器状态"
              : e.code
        : "操作未完成，请重试",
    );
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
      setPassword("");
      setNewPassword("");
    }
  };
  useEffect(() => {
    void session.restore();
    void openQueue()
      .then(() => setQueueReady(true))
      .catch(() => setMessage("无法保存上传任务，上传已停用"));
    const app = AppState.addEventListener("change", (state) => {
      void session.foreground(state === "active");
    });
    const links = Linking.addEventListener("url", ({ url }) => {
      void acceptLink(url)
        .then(async (accepted) => {
          if (accepted) setHasInvite(!!(await pendingInvitation()));
        })
        .catch(() => setMessage("请先处理当前邀请"));
    });
    void Linking.getInitialURL().then(async (url) => {
      if (url) await acceptLink(url);
      setHasInvite(!!(await pendingInvitation()));
    });
    return () => {
      app.remove();
      links.remove();
    };
  }, []);
  useEffect(() => {
    generation.current++;
    bootstrapUsed.current = false;
    setAnchor("");
    clearMedia();
    setItems([]);
    setAlbums([]);
    setViewer(null);
    setDetail(null);
    setJobs([]);
    setAlbum(null);
    setUploadOpen(false);
    setTargetJob(null);
    setSelected([]);
    if (deadline.current) clearTimeout(deadline.current);
  }, [auth.epoch]);
  useEffect(() => {
    if (!queueReady) return;
    const refresh = () => {
      const epoch = session.get().epoch;
      void listJobs().then((j) => {
        if (epoch === session.get().epoch) setJobs(j);
      });
    };
    refresh();
    const off = onQueue(refresh);
    const timer = setInterval(() => {
      void pumpQueue().catch(() => {});
    }, 2000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [queueReady, auth.epoch, auth.me?.user.id, auth.familyId]);
  async function load(more = false, automatic = false) {
    // Automatic recovery shares one budget within this activation.
    if (!automatic && !more) bootstrapUsed.current = false;
    if (!auth.me || !family || tab === "my") return;
    const epoch = session.get().epoch,
      gen = ++generation.current;
    setBusy(true);
    setMessage("");
    const start = performance.now();
    try {
      const ap = albumsResponseSchema.parse(
        await (
          await request(
            `/api/v1/albums?familyId=${family.familyId}&limit=50${more && tab === "albums" && afterAlbum ? `&afterId=${afterAlbum}` : ""}`,
          )
        ).json(),
      );
      if (epoch !== session.get().epoch || gen !== generation.current) return;
      setAlbums((old) =>
        more && tab === "albums" ? [...old, ...ap.albums] : ap.albums,
      );
      setAfterAlbum(ap.nextAfterId);
      if (tab === "albums" && !album) {
        setItems([]);
        return;
      }
      const q = new URLSearchParams({ limit: "48" });
      if (more && cursor) q.set("cursor", cursor);
      let path: string;
      if (album) path = `/api/v1/albums/${album.id}/media?${q}`;
      else if (tab === "memories") {
        q.set("kind", kind);
        path = `/api/v1/families/${family.familyId}/memories?${q}`;
      } else
        path = `/api/v1/families/${family.familyId}/${query ? "search" : "timeline"}?${q}${query ? "&" + query : ""}`;
      const raw = await (await request(path)).json();
      let list: Item[], next: string | null;
      if (tab === "memories" && !album) {
        const data = memoriesPageSchema.parse(raw);
        list = data.media;
        next = data.nextCursor;
        const remaining =
          Date.parse(data.context.nextMidnight) -
          Date.parse(data.context.serverNow) -
          (performance.now() - start);
        if (remaining <= 0) {
          setItems([]);
          throw new ClientFault(409, "MEMORIES_ANCHOR_EXPIRED");
        }
        setAnchor(data.context.anchorDate + " · 上海时间");
        if (deadline.current) clearTimeout(deadline.current);
        deadline.current = setTimeout(
          () => {
            generation.current++;
            setItems([]);
            setViewer(null);
            setCursor(null);
            if (!bootstrapUsed.current) {
              bootstrapUsed.current = true;
              void load(false, true);
            } else setMessage("回忆日期已更新，请下拉刷新");
          },
          Math.min(2147483647, remaining),
        );
      } else if (album) {
        const data = galleryMediaPageSchema.parse(raw);
        list = data.media.map((x) => ({ ...x, albumId: album.id }));
        next = data.nextCursor;
      } else {
        const data = familyTimelinePageSchema.parse(raw);
        list = data.media;
        next = data.nextCursor;
      }
      if (epoch !== session.get().epoch || gen !== generation.current) return;
      setItems((old) => (more ? [...old, ...list] : list));
      setCursor(next);
    } catch (e) {
      if (
        epoch === session.get().epoch &&
        tab === "memories" &&
        e instanceof ClientFault &&
        e.code === "MEMORIES_ANCHOR_EXPIRED" &&
        !bootstrapUsed.current
      ) {
        bootstrapUsed.current = true;
        await load(false, true);
        return;
      }
      if (epoch === session.get().epoch) {
        setItems([]);
        setCursor(null);
        report(e);
      }
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [auth.me, auth.familyId, tab, album?.id, query, kind]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (viewer) {
          setViewer(null);
          return true;
        }
        if (uploadOpen) {
          setUploadOpen(false);
          return true;
        }
        if (album) {
          setAlbum(null);
          return true;
        }
        if (tab !== "photos") {
          setTab("photos");
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [viewer, uploadOpen, album, tab]);
  useEffect(() => {
    setDetail(null);
    if (!viewer) return;
    let live = true;
    const epoch = session.get().epoch;
    void request(
      `/api/v1/albums/${viewer.item.albumId}/media/${viewer.item.mediaId}`,
    )
      .then((r) => r.json())
      .then((body) => {
        if (live && epoch === session.get().epoch)
          setDetail(galleryMediaDetailSchema.parse(body));
      })
      .catch(() => {
        if (live) {
          setViewer(null);
          setMessage("这张照片当前不可查看");
        }
      });
    return () => {
      live = false;
    };
  }, [viewer]);
  useEffect(() => {
    if (!hasInvite || auth.me) return;
    void previewInvitation()
      .then(setInvitation)
      .catch(() => setMessage("邀请无效、已使用或已过期"));
  }, [hasInvite, auth.me]);
  if (!auth.ready)
    return (
      <SafeAreaView style={s.screen}>
        <ActivityIndicator />
        <Text>正在确认登录状态…</Text>
      </SafeAreaView>
    );
  if (!auth.me)
    return (
      <SafeAreaView style={s.screen}>
        <ScrollView contentContainerStyle={s.login}>
          <Text style={s.brand}>FAMILY ALBUM</Text>
          <Text style={s.title}>嘟嘟家庭相册</Text>
          <Text style={s.muted}>记录爱，分享生活</Text>
          {hasInvite ? (
            <View style={s.card}>
              <Text style={s.heading}>
                {invitation?.familyName ?? "家庭邀请"}
              </Text>
              <Text>此邀请将创建新账号；不会把已有账号自动加入。</Text>
              <Text>
                {invitation?.role} · {invitation?.expiresAt.slice(0, 10)}
              </Text>
            </View>
          ) : null}
          <Field label="账号" value={username} set={setUsername} />
          <Field label="密码" value={password} set={setPassword} secret />
          <Button
            label="登录"
            disabled={busy}
            onPress={() =>
              void act(async () => {
                await session.login(username, password);
              })
            }
          />
          {hasInvite ? (
            <>
              <Button
                label="确认创建新账号并加入家庭"
                disabled={busy || !invitation}
                onPress={() =>
                  Alert.alert(
                    "创建新账号",
                    `加入${invitation?.familyName ?? "家庭"}，创建填写的账号？`,
                    [
                      { text: "取消" },
                      {
                        text: "确认",
                        onPress: () =>
                          void act(async () => {
                            try {
                              await consumeInvitation(username, password);
                              setHasInvite(false);
                              setInvitation(null);
                              setMessage("账号已创建，请正常登录");
                            } catch {
                              setMessage(
                                "结果未确认。请先尝试登录该账号，再检查邀请；不要自动重复提交。",
                              );
                            }
                          }),
                      },
                    ],
                  )
                }
              />
              <Button
                secondary
                label="取消邀请"
                onPress={() => {
                  void clearInvitation();
                  setHasInvite(false);
                  setInvitation(null);
                }}
              />
            </>
          ) : null}
          {message ? (
            <Text accessibilityRole="alert" style={s.error}>
              {message}
            </Text>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={s.screen} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <Text style={s.brand}>FAMILY ALBUM</Text>
        <Text style={s.title}>
          {album?.name ?? family?.familyName ?? "选择家庭"}
        </Text>
        <Text style={s.muted}>
          {titles[tab]} · {auth.me.user.displayName ?? auth.me.user.username}
        </Text>
      </View>
      {message ? (
        <Text accessibilityRole="alert" style={s.error}>
          {message}
        </Text>
      ) : null}
      {tab === "my" ? (
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.card}>
            <Text style={s.heading}>我的家庭</Text>
            {auth.me.memberships.map((m) => (
              <Button
                key={m.familyId}
                label={`${m.familyName}${m.familyId === auth.familyId ? " ✓" : ""}`}
                secondary
                onPress={() => session.selectFamily(m.familyId)}
              />
            ))}
          </View>
          <View style={s.card}>
            <Text style={s.heading}>账号与安全</Text>
            <Field
              label="当前密码 / 重新验证"
              value={password}
              set={setPassword}
              secret
            />
            <Button
              label="重新验证"
              disabled={busy}
              onPress={() => void act(() => session.rotate(password))}
            />
            <Field
              label="新密码（至少8位）"
              value={newPassword}
              set={setNewPassword}
              secret
            />
            <Button
              secondary
              label="修改密码"
              disabled={busy}
              onPress={() =>
                void act(() => session.rotate("", password, newPassword))
              }
            />
            <Button
              secondary
              label="退出所有设备"
              onPress={() =>
                void act(async () => {
                  await request("/api/v1/auth/logout-all", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  });
                  await session.logout(false);
                })
              }
            />
            <Button
              secondary
              label="退出登录"
              onPress={() => void act(() => session.logout())}
            />
          </View>
          {hasInvite ? (
            <View style={s.card}>
              <Text>邀请用于创建新账号，需要先退出当前账号。</Text>
              <Button
                label="退出并查看邀请"
                onPress={() => void act(() => session.logout())}
              />
            </View>
          ) : null}
          <View style={s.card}>
            <Text style={s.heading}>上传队列</Text>
            <Text style={s.muted}>
              仅在前台上传。退出后保留本账号任务，重新登录后恢复。关掉App不保证继续传输。
            </Text>
            {jobs.length === 0 ? (
              <Text>还没有上传任务</Text>
            ) : (
              jobs.map((job) => (
                <View key={job.operationId} style={s.job}>
                  <Text
                    numberOfLines={1}
                    accessibilityLabel={`上传任务 ${job.name}：${stageLabel[job.stage] ?? job.stage}`}
                  >
                    {job.name}
                  </Text>
                  <Text>
                    {stageLabel[job.stage] ?? job.stage} ·{" "}
                    {Math.floor((job.offset / job.size) * 100)}%
                  </Text>
                  <View style={s.row}>
                    <Button
                      secondary
                      label="重试"
                      onPress={() => void act(() => retryJob(job))}
                    />
                    {job.stage === "NEEDS_ACTION" ? (
                      <Button
                        secondary
                        label="重新选择原照片"
                        onPress={() => void act(() => reselectJob(job))}
                      />
                    ) : null}
                    {job.uploadId && job.stage === "NEEDS_ACTION" ? (
                      <Button
                        secondary
                        label="重新选相册"
                        onPress={() => {
                          setTargetJob(job);
                          setSelected(job.targets);
                          setUploadOpen(true);
                        }}
                      />
                    ) : null}
                    <Button
                      secondary
                      label="移除本地任务"
                      onPress={() => void act(() => deleteJob(job))}
                    />
                  </View>
                </View>
              ))
            )}
          </View>
          <Text style={s.muted}>
            鸿蒙6.1请使用手机网页，并从浏览器添加桌面快捷方式。通知本期不启用。
          </Text>
        </ScrollView>
      ) : (
        <>
          {tab === "photos" && !album ? (
            <View style={s.search}>
              <Field label="搜索原文件名" value={search} set={setSearch} />
              <View style={s.row}>
                <Field
                  label="起始 YYYY-MM-DD"
                  value={fromDate}
                  set={setFromDate}
                />
                <Field label="截止 YYYY-MM-DD" value={toDate} set={setToDate} />
              </View>
              <View style={s.row}>
                <Button
                  secondary
                  label={favorite ? "✓ 我的收藏" : "我的收藏"}
                  onPress={() => setFavorite(!favorite)}
                />
                <Button
                  label="查找"
                  onPress={() => {
                    const q = new URLSearchParams();
                    if (search.trim()) q.set("filename", search.trim());
                    if (fromDate) q.set("fromDate", fromDate);
                    if (toDate) q.set("toDate", toDate);
                    if (favorite) q.set("favoritesOnly", "true");
                    setQuery(q.toString());
                  }}
                />
              </View>
              <Pressable
                style={s.memoryCard}
                onPress={() => {
                  setTab("memories");
                  setAlbum(null);
                }}
              >
                <Text style={s.heading}>✦ 往年今日</Text>
                <Text style={s.muted}>看看那些值得珍藏的瞬间</Text>
              </Pressable>
            </View>
          ) : null}
          {tab === "memories" ? (
            <View style={s.row}>
              <Button
                secondary
                label="往年今日"
                onPress={() => setKind("ON_THIS_DAY")}
              />
              <Button
                secondary
                label="一年前这周"
                onPress={() => setKind("LAST_YEAR_WEEK")}
              />
              <Text style={s.muted}>{anchor}</Text>
            </View>
          ) : null}
          {album ? (
            <Button secondary label="返回相册" onPress={() => setAlbum(null)} />
          ) : null}
          {busy ? <ActivityIndicator color="#518d63" /> : null}
          {tab === "albums" && !album ? (
            <FlatList
              data={albums}
              keyExtractor={(x) => x.id}
              contentContainerStyle={s.content}
              renderItem={({ item }) => (
                <Pressable style={s.album} onPress={() => setAlbum(item)}>
                  <Text style={s.albumIcon}>▦</Text>
                  <View>
                    <Text style={s.heading}>{item.name}</Text>
                    <Text style={s.muted}>
                      {item.description ?? "珍藏家的日常"}
                    </Text>
                  </View>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={s.empty}>还没有可查看的相册</Text>
              }
              ListFooterComponent={
                afterAlbum ? (
                  <Button
                    secondary
                    label="更多相册"
                    onPress={() => void load(true)}
                  />
                ) : null
              }
            />
          ) : (
            <FlatList
              key="photos"
              data={items}
              numColumns={3}
              initialNumToRender={12}
              windowSize={3}
              removeClippedSubviews
              keyExtractor={(x) => `${x.albumId}:${x.mediaId}`}
              contentContainerStyle={s.grid}
              renderItem={({ item, index }) => (
                <Pressable
                  style={s.tile}
                  accessibilityLabel={`查看${item.timelineKey.slice(0, 10)}照片`}
                  onPress={() => setViewer({ item, index })}
                >
                  <PrivateImage id={item.mediaId} style={s.thumbnail} />
                  {item.isFavorite ? <Text style={s.heart}>♥</Text> : null}
                </Pressable>
              )}
              ListHeaderComponent={
                items.length ? (
                  <Text style={s.heading}>
                    {items[0]?.timelineKey.slice(0, 7).replace("-", "年")}月
                  </Text>
                ) : null
              }
              ListEmptyComponent={
                !busy ? (
                  <Text style={s.empty}>
                    这里还没有照片
                    {query ? "，试试其他筛选条件" : "，选择相册后上传第一张吧"}
                  </Text>
                ) : null
              }
              ListFooterComponent={
                cursor ? (
                  <Button
                    secondary
                    label="加载更多"
                    onPress={() => void load(true)}
                  />
                ) : null
              }
              refreshing={busy}
              onRefresh={() => void load(false)}
            />
          )}
        </>
      )}
      {tab !== "my" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="选择照片上传"
          style={s.fab}
          onPress={() => {
            setTargetJob(null);
            setSelected([]);
            setUploadOpen(true);
          }}
        >
          <Text style={s.plus}>＋</Text>
        </Pressable>
      ) : null}
      <SafeAreaView edges={["bottom"]} style={s.nav}>
        <View style={s.row}>
          {(Object.keys(titles) as Tab[]).map((t) => (
            <Pressable
              key={t}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === t }}
              style={s.navItem}
              onPress={() => {
                setAlbum(null);
                setViewer(null);
                setTab(t);
              }}
            >
              <Text style={[s.navIcon, tab === t && s.accent]}>
                {{ photos: "▧", albums: "▦", memories: "♡", my: "◉" }[t]}
              </Text>
              <Text style={tab === t ? s.accent : s.muted}>{titles[t]}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
      <Modal
        visible={uploadOpen}
        animationType="slide"
        onRequestClose={() => setUploadOpen(false)}
      >
        <SafeAreaView style={s.screen}>
          <ScrollView contentContainerStyle={s.content}>
            <Text style={s.title}>选择目标相册</Text>
            <Text style={s.muted}>
              选择1–20个相册，全组成功后才显示“已加入”。原始照片不会压缩或旋转。
            </Text>
            {albums
              .filter(
                (a) =>
                  a.effectivePermissions.canView &&
                  (a.effectivePermissions.canUpload ||
                    a.effectivePermissions.canEdit),
              )
              .map((a) => (
                <Button
                  key={a.id}
                  secondary
                  label={`${selected.includes(a.id) ? "✓ " : ""}${a.name}`}
                  onPress={() =>
                    setSelected((x) =>
                      x.includes(a.id)
                        ? x.filter((v) => v !== a.id)
                        : [...x, a.id],
                    )
                  }
                />
              ))}
            {afterAlbum ? (
              <Button
                secondary
                label="加载更多相册"
                onPress={() =>
                  void act(async () => {
                    const data = albumsResponseSchema.parse(
                      await (
                        await request(
                          `/api/v1/albums?familyId=${family?.familyId}&limit=50&afterId=${afterAlbum}`,
                        )
                      ).json(),
                    );
                    setAlbums((x) => [...x, ...data.albums]);
                    setAfterAlbum(data.nextAfterId);
                  })
                }
              />
            ) : null}
            <Button
              disabled={busy || !queueReady || !selected.length}
              label={targetJob ? "确认更换目标" : "选择多张照片并上传"}
              onPress={() =>
                void act(async () => {
                  if (targetJob) await changeTargets(targetJob, selected);
                  else await selectPhotos(selected);
                  setUploadOpen(false);
                  setTab("my");
                })
              }
            />
            <Button
              secondary
              label="取消"
              onPress={() => setUploadOpen(false)}
            />
            {message ? <Text style={s.error}>{message}</Text> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <Modal
        visible={!!viewer}
        animationType="fade"
        onRequestClose={() => setViewer(null)}
      >
        <SafeAreaView style={s.viewer}>
          <Button secondary label="关闭照片" onPress={() => setViewer(null)} />
          {viewer ? (
            <PrivateImage
              id={viewer.item.mediaId}
              kind="preview"
              style={s.preview}
            />
          ) : null}
          <View style={s.row}>
            <Button
              secondary
              label="上一张"
              disabled={!viewer || viewer.index === 0}
              onPress={() => {
                if (viewer)
                  setViewer({
                    item: items[viewer.index - 1]!,
                    index: viewer.index - 1,
                  });
              }}
            />
            <Button
              secondary
              label="下一张"
              disabled={!viewer || viewer.index === items.length - 1}
              onPress={() => {
                if (viewer)
                  setViewer({
                    item: items[viewer.index + 1]!,
                    index: viewer.index + 1,
                  });
              }}
            />
          </View>
          {detail ? (
            <ScrollView style={s.details}>
              <Text style={s.heading}>
                {detail.capturedLocalAt?.slice(0, 10) ??
                  detail.timelineKey.slice(0, 10)}
              </Text>
              <Text>{detail.note ?? ""}</Text>
              <Text style={s.muted}>
                {detail.cameraMake} {detail.cameraModel} ·{" "}
                {detail.timelineBasis}
              </Text>
              <Text>{detail.tags.map((t) => t.name).join(" · ")}</Text>
              {detail.capabilities.canDownloadOriginal && viewer ? (
                <Button
                  secondary
                  label="保存或分享原图"
                  onPress={() =>
                    void act(() =>
                      exportPhoto(
                        viewer.item.albumId,
                        viewer.item.mediaId,
                        "original",
                      ),
                    )
                  }
                />
              ) : null}
              {detail.capabilities.canDownloadPreview && viewer ? (
                <Button
                  secondary
                  label="保存或分享预览"
                  onPress={() =>
                    void act(() =>
                      exportPhoto(
                        viewer.item.albumId,
                        viewer.item.mediaId,
                        "preview",
                      ),
                    )
                  }
                />
              ) : null}
            </ScrollView>
          ) : (
            <ActivityIndicator />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#faf8f4" },
  content: { padding: 20, gap: 14, paddingBottom: 100 },
  login: { padding: 28, gap: 15, paddingTop: 90 },
  brand: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#548462",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#2f302b",
    marginVertical: 7,
  },
  heading: {
    fontSize: 18,
    fontWeight: "600",
    color: "#373a32",
    marginVertical: 7,
  },
  muted: { color: "#85847d", fontSize: 13, lineHeight: 21 },
  header: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 14 },
  card: { backgroundColor: "white", padding: 19, borderRadius: 22, gap: 12 },
  input: {
    backgroundColor: "#f0eee8",
    borderRadius: 16,
    padding: 13,
    minHeight: 48,
    flexShrink: 1,
    color: "#333",
    marginVertical: 3,
  },
  button: {
    backgroundColor: "#558e65",
    padding: 13,
    borderRadius: 16,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  secondary: { backgroundColor: "#edf1e9" },
  buttonText: { color: "white", fontWeight: "600", fontSize: 14 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" },
  search: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  memoryCard: {
    backgroundColor: "#efe5d8",
    padding: 17,
    borderRadius: 20,
    marginTop: 4,
  },
  grid: { padding: 10, paddingBottom: 100 },
  tile: {
    flex: 1 / 3,
    margin: 2,
    aspectRatio: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  thumbnail: { width: "100%", height: "100%" },
  heart: {
    position: "absolute",
    right: 8,
    top: 5,
    color: "white",
    fontSize: 20,
  },
  empty: { padding: 25, color: "#8a857b", lineHeight: 24, textAlign: "center" },
  album: {
    backgroundColor: "white",
    borderRadius: 22,
    padding: 22,
    flexDirection: "row",
    gap: 18,
    alignItems: "center",
    marginBottom: 12,
  },
  albumIcon: { fontSize: 38, color: "#87a785" },
  nav: {
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderColor: "#eee9e0",
    paddingTop: 8,
  },
  navItem: { flex: 1, alignItems: "center", padding: 8, minHeight: 52 },
  navIcon: { fontSize: 25, color: "#8b8e88" },
  accent: { color: "#518d63", fontWeight: "600" },
  fab: {
    position: "absolute",
    right: 22,
    bottom: 100,
    borderRadius: 35,
    width: 68,
    height: 68,
    backgroundColor: "#589568",
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
  },
  plus: { color: "white", fontSize: 44, lineHeight: 50 },
  error: { color: "#995c40", paddingHorizontal: 20, paddingVertical: 9 },
  job: { borderTopWidth: 1, borderColor: "#eae8e1", paddingTop: 15, gap: 8 },
  viewer: { flex: 1, backgroundColor: "#faf8f4", padding: 15, gap: 12 },
  preview: { width: "100%", flex: 1 },
  details: { maxHeight: 160 },
});
