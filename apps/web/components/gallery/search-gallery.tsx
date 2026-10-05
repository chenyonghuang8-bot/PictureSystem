"use client";

import {
  albumsResponseSchema,
  familyTimelinePageSchema,
  familySearchOptionsPageSchema,
  type FamilySearchFilters,
  type FamilyTimelinePage,
} from "@family-album/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  albumsPath,
  searchFilterQuery,
  searchFiltersFromUrl,
  searchPath,
  searchOptionsPath,
} from "../../lib/gallery-paths.js";
import {
  browserGalleryGet,
  GalleryClientError,
} from "../../lib/gallery-client.js";
import { Timeline } from "./timeline.js";
import { SignedOut, UnavailableState } from "./states.js";

import { LocationMap } from "./location-map.js";

const PAGE_SIZE = 24;

export function SearchGallery({
  userId,
  familyId,
  initial,
  initialFilters,
}: {
  userId: string;
  familyId: string;
  initial: FamilyTimelinePage;
  initialFilters: FamilySearchFilters;
}) {
  const [mapOpen, setMapOpen] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState<FamilyTimelinePage | null>(initial);
  const [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false),
    [signedOut, setSignedOut] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const latest = useRef(initialFilters);
  const alive = useRef(true);

  async function refresh(next: FamilySearchFilters) {
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    latest.current = next;
    setFilters(next);
    setPage(null);
    setLoading(true);
    setFailed(false);
    setSignedOut(false);
    try {
      const result = await browserGalleryGet(
        searchPath(familyId, next, { limit: PAGE_SIZE }),
        familyTimelinePageSchema,
        request.signal,
      );
      if (
        !alive.current ||
        request.signal.aborted ||
        generation.current !== current
      )
        return;
      setPage(result);
      setRevision((value) => value + 1);
    } catch (error) {
      if (
        !alive.current ||
        request.signal.aborted ||
        generation.current !== current
      )
        return;
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        setSignedOut(true);
      else setFailed(true);
    } finally {
      if (
        alive.current &&
        !request.signal.aborted &&
        generation.current === current
      )
        setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    const restore = () => {
      const values: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(window.location.search)) {
        const previous = values[key];
        values[key] =
          previous === undefined
            ? value
            : [...(Array.isArray(previous) ? previous : [previous]), value];
      }
      try {
        void refresh(searchFiltersFromUrl(values));
      } catch {
        ++generation.current;
        controller.current?.abort();
        setPage(null);
        setLoading(false);
        setFailed(true);
      }
    };
    window.addEventListener("popstate", restore);
    return () => {
      alive.current = false;
      ++generation.current;
      controller.current?.abort();
      window.removeEventListener("popstate", restore);
    };
    // Actor/filter identity is bound by the parent key; requests are cancelled on unmount.
  }, []);

  function apply(next: FamilySearchFilters) {
    window.history.pushState(null, "", searchFilterQuery(next));
    void refresh(next);
  }

  return (
    <>
      <SearchControls
        key={searchFilterQuery(filters)}
        familyId={familyId}
        filters={filters}
        disabled={signedOut}
        onApply={apply}
        onAuthLost={() => {
          controller.current?.abort();
          ++generation.current;
          setPage(null);
          setSignedOut(true);
          setLoading(false);
        }}
      />
      {!signedOut ? (
        <button
          className="gallery-text-button"
          onClick={() => setMapOpen((value) => !value)}
        >
          {mapOpen ? "关闭地图" : "地图与地区"}
        </button>
      ) : null}
      {mapOpen && !signedOut ? (
        <LocationMap
          key={`${userId}:${familyId}:${searchFilterQuery(filters)}`}
          familyId={familyId}
          filters={filters}
          onApply={apply}
          onAuthLost={() => {
            ++generation.current;
            controller.current?.abort();
            setPage(null);
            setSignedOut(true);
            setLoading(false);
            setMapOpen(false);
          }}
        />
      ) : null}
      {loading ? <p role="status">正在查找照片…</p> : null}
      {failed ? (
        <>
          <UnavailableState />
          <button
            className="gallery-text-button"
            onClick={() => void refresh(latest.current)}
          >
            重新查找
          </button>
        </>
      ) : null}
      {signedOut ? <SignedOut /> : null}
      {page && !signedOut ? (
        <Timeline
          key={`${userId}:${familyId}:${searchFilterQuery(filters)}:${revision}`}
          userId={userId}
          familyId={familyId}
          initial={page}
          filters={filters}
          onRefresh={() => void refresh(latest.current)}
          onAuthLost={() => {
            ++generation.current;
            controller.current?.abort();
            setPage(null);
            setSignedOut(true);
            setLoading(false);
          }}
        />
      ) : null}
    </>
  );
}

function SearchControls({
  familyId,
  filters,
  disabled,
  onApply,
  onAuthLost,
}: {
  familyId: string;
  filters: FamilySearchFilters;
  disabled: boolean;
  onApply: (filters: FamilySearchFilters) => void;
  onAuthLost: () => void;
}) {
  const [albums, setAlbums] = useState<{ id: string; name: string }[]>([]),
    [afterId, setAfterId] = useState<string | null | undefined>(undefined);
  const [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false),
    [invalid, setInvalid] = useState(false);
  const [selectedAlbum, setSelectedAlbum] = useState(filters.albumId ?? "");
  const alive = useRef(true),
    request = useRef<AbortController | null>(null),
    loading = useRef(false);
  async function loadAlbums(cursor?: string) {
    if (loading.current || disabled) return;
    loading.current = true;
    setPending(true);
    setFailed(false);
    const abort = new AbortController();
    request.current = abort;
    try {
      const result = await browserGalleryGet(
        albumsPath(familyId, {
          limit: 50,
          ...(cursor ? { afterId: cursor } : {}),
        }),
        albumsResponseSchema,
        abort.signal,
      );
      if (!alive.current || abort.signal.aborted) return;
      setAlbums((previous) => {
        const seen = new Set(previous.map((row) => row.id));
        return previous.concat(
          result.albums.filter((row) => !seen.has(row.id)),
        );
      });
      setAfterId(result.nextAfterId);
    } catch (error) {
      if (!alive.current || abort.signal.aborted) return;
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        onAuthLost();
      else setFailed(true);
    } finally {
      if (alive.current && !abort.signal.aborted) {
        loading.current = false;
        setPending(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void loadAlbums();
    return () => {
      alive.current = false;
      request.current?.abort();
      loading.current = false;
    };
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      onApply(
        searchFiltersFromUrl({
          ...(values.get("location")
            ? { location: String(values.get("location")) }
            : {}),
          ...(values.get("fromDate")
            ? { fromDate: String(values.get("fromDate")) }
            : {}),
          ...(values.get("toDate")
            ? { toDate: String(values.get("toDate")) }
            : {}),
          ...(values.get("albumId")
            ? { albumId: String(values.get("albumId")) }
            : {}),
          ...(values.get("favoritesOnly") ? { favoritesOnly: "true" } : {}),
          ...(String(values.get("filename") ?? "").trim()
            ? { filename: String(values.get("filename")).trim() }
            : {}),
          ...(values.get("uploaderMemberId")
            ? { uploaderMemberId: String(values.get("uploaderMemberId")) }
            : {}),
          ...(values.get("tagId")
            ? { tagId: String(values.get("tagId")) }
            : {}),
        }),
      );
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  }
  return (
    <section className="gallery-search" aria-label="查找照片">
      <form onSubmit={submit}>
        <p className="gallery-search-label">
          照片时间 <small>无拍摄时间时用上传时间</small>
        </p>
        <div className="gallery-search-fields">
          <label>
            开始日期
            <input
              name="fromDate"
              type="date"
              min="1000-01-01"
              max="9999-12-31"
              defaultValue={filters.fromDate ?? ""}
              disabled={disabled}
            />
          </label>
          <label>
            结束日期
            <input
              name="toDate"
              type="date"
              min="1000-01-01"
              max="9999-12-31"
              defaultValue={filters.toDate ?? ""}
              disabled={disabled}
            />
          </label>
          <label>
            相册
            <select
              name="albumId"
              aria-label="相册"
              value={selectedAlbum}
              onChange={(event) => setSelectedAlbum(event.target.value)}
              disabled={disabled}
            >
              <option value="">全部可见相册</option>
              {filters.albumId &&
              !albums.some((row) => row.id === filters.albumId) ? (
                <option value={filters.albumId}>当前筛选相册</option>
              ) : null}
              {albums.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            首次上传文件名
            <input
              name="filename"
              type="search"
              defaultValue={filters.filename ?? ""}
              disabled={disabled}
              placeholder="包含文字，区分大小写/重音"
            />
          </label>
          <SearchOptionControl
            familyId={familyId}
            kind="uploader"
            {...(filters.uploaderMemberId
              ? { selectedId: filters.uploaderMemberId }
              : {})}
            disabled={disabled}
            onAuthLost={onAuthLost}
          />
          <SearchOptionControl
            familyId={familyId}
            kind="tag"
            {...(filters.tagId ? { selectedId: filters.tagId } : {})}
            disabled={disabled}
            onAuthLost={onAuthLost}
          />
          <label>
            地点
            <select
              name="location"
              defaultValue={filters.location ?? ""}
              disabled={disabled}
            >
              <option value="">全部照片（包括无地点）</option>
              <option value="located">有当前粗略地点</option>
              <option value="unknown">未知国家 / 海洋</option>
              <option value="no-city">无附近城市</option>
              {filters.location &&
              !["located", "unknown", "no-city"].includes(filters.location) ? (
                <option value={filters.location}>当前地区筛选</option>
              ) : null}
            </select>
            <small>通过地图与地区选择国家、附近城市或粗略格网</small>
          </label>
          <label className="gallery-search-favorite">
            <input
              type="checkbox"
              name="favoritesOnly"
              defaultChecked={filters.favoritesOnly}
              disabled={disabled}
            />
            仅我的收藏
          </label>
          <button
            type="submit"
            className="gallery-primary-button"
            disabled={disabled}
          >
            查找照片
          </button>
          <button
            type="button"
            className="gallery-text-button"
            disabled={disabled}
            onClick={() => onApply({ favoritesOnly: false })}
          >
            清除筛选
          </button>
        </div>
        {invalid ? <p role="alert">请检查筛选条件。</p> : null}
      </form>
      <small>文件名和成员按首次上传来源检索；重复上传不改变归属。</small>
      {pending ? <small role="status">正在加载相册选项…</small> : null}
      {failed ? (
        <button
          className="gallery-text-button"
          onClick={() => void loadAlbums(afterId ?? undefined)}
        >
          重试相册选项
        </button>
      ) : null}
      {afterId ? (
        <button
          className="gallery-text-button"
          disabled={pending || disabled}
          onClick={() => void loadAlbums(afterId)}
        >
          加载更多相册选项
        </button>
      ) : null}
    </section>
  );
}

function SearchOptionControl({
  familyId,
  kind,
  selectedId,
  disabled,
  onAuthLost,
}: {
  familyId: string;
  kind: "tag" | "uploader";
  selectedId?: string;
  disabled: boolean;
  onAuthLost: () => void;
}) {
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [selected, setSelected] = useState(selectedId ?? "");
  const [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false);
  const alive = useRef(true),
    loading = useRef(false),
    request = useRef<AbortController | null>(null);
  const label = kind === "tag" ? "标签" : "首次上传成员";
  async function load(nextCursor?: string) {
    if (disabled || loading.current) return;
    loading.current = true;
    setPending(true);
    setFailed(false);
    const abort = new AbortController();
    request.current = abort;
    try {
      const result = await browserGalleryGet(
        searchOptionsPath(familyId, kind, nextCursor),
        familySearchOptionsPageSchema,
        abort.signal,
      );
      if (!alive.current || abort.signal.aborted) return;
      setOptions((previous) => {
        const seen = new Set(previous.map((row) => row.id));
        return previous.concat(
          result.options.filter((row) => !seen.has(row.id)),
        );
      });
      setCursor(result.nextCursor);
    } catch (error) {
      if (!alive.current || abort.signal.aborted) return;
      if (
        error instanceof GalleryClientError &&
        error.code === "UNAUTHENTICATED"
      )
        onAuthLost();
      else setFailed(true);
    } finally {
      if (alive.current && !abort.signal.aborted) {
        loading.current = false;
        setPending(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loading.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (disabled) {
      request.current?.abort();
      setOptions([]);
      setPending(false);
    }
  }, [disabled]);
  return (
    <div>
      <label>
        {label}
        <select
          name={kind === "tag" ? "tagId" : "uploaderMemberId"}
          aria-label={label}
          value={selected}
          disabled={disabled}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">
            全部可见{kind === "tag" ? "标签" : "来源成员"}
          </option>
          {selectedId && !options.some((row) => row.id === selectedId) ? (
            <option value={selectedId}>当前筛选{label}</option>
          ) : null}
          {options.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      {pending ? <small role="status">正在加载{label}选项…</small> : null}
      {failed || cursor ? (
        <button
          type="button"
          className="gallery-text-button"
          disabled={pending || disabled}
          onClick={() => void load(cursor ?? undefined)}
        >
          {failed ? "重试" : "加载更多"}
          {label}选项
        </button>
      ) : null}
    </div>
  );
}
