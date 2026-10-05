"use client";
import { useEffect, useRef, useState } from "react";
import {
  familyMapPageSchema,
  familyLocationOptionsPageSchema,
  type FamilyMapPage,
  type FamilySearchFilters,
} from "@family-album/contracts";
import {
  browserGalleryGet,
  GalleryClientError,
} from "../../lib/gallery-client.js";
import {
  locationMapPath,
  locationOptionsPath,
} from "../../lib/gallery-paths.js";
import { mapProvider, mapResourceRequest } from "../../lib/map-provider.js";
import type { Map as MapLibreMap, Marker as MapMarker } from "maplibre-gl";

type View = { bbox: [number, number, number, number]; zoom: number };
export function LocationMap({
  familyId,
  filters,
  onApply,
  onAuthLost,
}: {
  familyId: string;
  filters: FamilySearchFilters;
  onApply: (filters: FamilySearchFilters) => void;
  onAuthLost: () => void;
}) {
  const [view, setView] = useState<View>({
    bbox: [-180, -90, 180, 90],
    zoom: 1,
  });
  const [page, setPage] = useState<FamilyMapPage | null>(null),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const sequence = useRef(0),
    request = useRef<AbortController | null>(null);
  function moving() {
    ++sequence.current;
    request.current?.abort();
    setPage(null);
  }
  useEffect(() => {
    const abort = new AbortController(),
      current = ++sequence.current;
    request.current = abort;
    setPage(null);
    setFailed(false);
    void browserGalleryGet(
      locationMapPath(familyId, filters, view.bbox, view.zoom),
      familyMapPageSchema,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted && sequence.current === current)
          setPage(result);
      })
      .catch((error) => {
        if (abort.signal.aborted || sequence.current !== current) return;
        if (
          error instanceof GalleryClientError &&
          error.code === "UNAUTHENTICATED"
        )
          onAuthLost();
        else setFailed(true);
      });
    return () => {
      ++sequence.current;
      abort.abort();
    };
  }, [familyId, filters, view, retry]);
  const choose = (location: string) => onApply({ ...filters, location });
  return (
    <section className="gallery-location" aria-label="地图与地区">
      <p>
        地点为约 36
        平方公里的粗略格网（不保证匿名）。国家按概化边界归属，城市表示 50
        公里内附近城市。
      </p>
      <small>
        底图使用 OpenFreeMap，浏览区域及 IP
        等请求元数据会发送给供应商；照片和私人地点标记留在本应用。服务无可用性保证。
        <a
          href="https://openfreemap.org/privacy/"
          target="_blank"
          rel="noreferrer"
        >
          隐私说明
        </a>{" "}
        ·{" "}
        <a href="https://openfreemap.org/tos/" target="_blank" rel="noreferrer">
          服务条款
        </a>
      </small>
      <Basemap
        clusters={page?.clusters ?? []}
        resolution={page?.resolution ?? 0}
        onChoose={choose}
        onView={setView}
        onMoving={moving}
      />
      {failed ? (
        <p role="alert">
          地点暂不可用。
          <button
            className="gallery-text-button"
            onClick={() => setRetry((v) => v + 1)}
          >
            重试地点
          </button>
        </p>
      ) : !page ? (
        <p role="status">正在加载粗略地点…</p>
      ) : (
        <>
          <p>
            {page.locatedCount} 张有当前地点 · {page.pendingCount} 张投影待补齐
            · {page.noGpsCount} 张无 GPS。当前聚合层级 {page.resolution}。
          </p>
          {page.polarCount > 0 ? (
            <p role="status">
              {page.polarCount} 张位于 Web Mercator
              显示范围之外，请通过下方地区列表浏览。
            </p>
          ) : null}
          <details>
            <summary>当前视野格网列表（{page.clusters.length}）</summary>
            <div className="gallery-region-list">
              {page.clusters.map((cluster) => (
                <button
                  className="gallery-text-button"
                  key={cluster.cell}
                  onClick={() =>
                    choose(`cell:${page.resolution}:${cluster.cell}`)
                  }
                >
                  粗略区域 {cluster.cell} · {cluster.count} 张
                </button>
              ))}
            </div>
          </details>
        </>
      )}
      <RegionList
        familyId={familyId}
        filters={filters}
        kind="country"
        onChoose={choose}
        onAuthLost={onAuthLost}
      />
      <RegionList
        familyId={familyId}
        filters={filters}
        kind="city"
        onChoose={choose}
        onAuthLost={onAuthLost}
      />
      <small>
        地区数据：
        <a
          href="https://www.naturalearthdata.com/"
          target="_blank"
          rel="noreferrer"
        >
          Natural Earth 5.1.1
        </a>
        （公共领域；概化 de facto 边界，不作法律或精确行政断言） ·{" "}
        <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
          GeoNames cities1000
        </a>
        （
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noreferrer"
        >
          CC BY 4.0
        </a>
        ；粗格网派生附近城市）。
      </small>
    </section>
  );
}
function RegionList({
  familyId,
  filters,
  kind,
  onChoose,
  onAuthLost,
}: {
  familyId: string;
  filters: FamilySearchFilters;
  kind: "country" | "city";
  onChoose: (id: string) => void;
  onAuthLost: () => void;
}) {
  const [rows, setRows] = useState<
      { id: string; name: string; count: number }[]
    >([]),
    [cursor, setCursor] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false);
  const alive = useRef(true),
    request = useRef<AbortController | null>(null),
    loading = useRef(false);
  async function load(after?: string) {
    if (loading.current) return;
    loading.current = true;
    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    setFailed(false);
    try {
      const page = await browserGalleryGet(
        locationOptionsPath(familyId, filters, kind, after),
        familyLocationOptionsPageSchema,
        abort.signal,
      );
      if (!alive.current || abort.signal.aborted) return;
      setRows((previous) => {
        const ids = new Set(previous.map((r) => r.id));
        return previous.concat(page.options.filter((r) => !ids.has(r.id)));
      });
      setCursor(page.nextCursor);
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
  return (
    <div>
      <h3>{kind === "country" ? "国家 / 地区" : "附近城市"}</h3>
      <div className="gallery-region-list">
        {rows.map((row) => (
          <button
            className="gallery-text-button"
            key={row.id}
            onClick={() => onChoose(row.id)}
          >
            {row.name} · {row.count} 张
          </button>
        ))}
      </div>
      {pending ? <p role="status">加载地区…</p> : null}
      {failed || cursor ? (
        <button
          className="gallery-text-button"
          disabled={pending}
          onClick={() => void load(cursor ?? undefined)}
        >
          {failed ? "重试地区" : "更多地区"}
        </button>
      ) : null}
    </div>
  );
}
function Basemap({
  clusters,
  resolution,
  onChoose,
  onView,
  onMoving,
}: {
  clusters: FamilyMapPage["clusters"];
  resolution: number;
  onChoose: (id: string) => void;
  onView: (view: View) => void;
  onMoving: () => void;
}) {
  const container = useRef<HTMLDivElement | null>(null),
    map = useRef<MapLibreMap | null>(null),
    markers = useRef<MapMarker[]>([]);
  const latest = useRef({ onChoose, onView, onMoving });
  latest.current = { onChoose, onView, onMoving };
  const [status, setStatus] = useState<
      "loading" | "ready" | "disabled" | "failed"
    >("loading"),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false,
      instance: MapLibreMap | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (disposed) return;
      if (deadline) clearTimeout(deadline);
      setStatus("failed");
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      instance?.remove();
      instance = undefined;
      map.current = null;
    };
    setStatus("loading");
    void (async () => {
      try {
        const provider = mapProvider(process.env.NEXT_PUBLIC_MAP_STYLE_URL);
        if (!provider) {
          setStatus("disabled");
          return;
        }
        const lib = await import("maplibre-gl");
        lib.setWorkerUrl("/vendor/maplibre-6.11.2/maplibre-gl-worker.mjs");
        if (disposed || !container.current) return;
        instance = new lib.Map({
          container: container.current,
          style: provider.style,
          center: [0, 20],
          zoom: 1,
          maxZoom: 22,
          renderWorldCopies: false,
          transformRequest: (url) => mapResourceRequest(url, provider.origin),
        });
        map.current = instance;
        instance.addControl(new lib.NavigationControl(), "top-right");
        // Stalled external requests may never emit an error. Region browsing
        // remains local and usable after this bounded initial-load deadline.
        deadline = setTimeout(fail, 15000);
        const emit = () => {
          if (disposed || !instance) return;
          const bounds = instance.getBounds();
          const normalize = (n: number) =>
            ((((n + 180) % 360) + 360) % 360) - 180;
          const width = bounds.getEast() - bounds.getWest();
          latest.current.onView({
            bbox: [
              width >= 360 ? -180 : normalize(bounds.getWest()),
              Math.max(-90, bounds.getSouth()),
              width >= 360 ? 180 : normalize(bounds.getEast()),
              Math.min(90, bounds.getNorth()),
            ],
            zoom: instance.getZoom(),
          });
        };
        instance.on("load", () => {
          if (disposed || !instance) return;
          if (deadline) clearTimeout(deadline);
          setStatus("ready");
          emit();
        });
        instance.on("movestart", () => {
          latest.current.onMoving();
          for (const marker of markers.current) marker.remove();
          markers.current = [];
        });
        instance.on("moveend", emit);
        instance.on("error", fail);
      } catch {
        fail();
      }
    })();
    return () => {
      disposed = true;
      if (deadline) clearTimeout(deadline);
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      instance?.remove();
      map.current = null;
    };
  }, [retry]);
  useEffect(() => {
    let cancelled = false;
    for (const marker of markers.current) marker.remove();
    markers.current = [];
    if (status !== "ready" || !map.current) return;
    void import("maplibre-gl").then((lib) => {
      if (cancelled || !map.current) return;
      for (const cluster of clusters) {
        if (Math.abs(cluster.latitude) > 85.0511287798066) continue;
        const button = document.createElement("button");
        button.className = "gallery-map-marker";
        button.textContent = String(cluster.count);
        button.setAttribute("aria-label", `粗略地区 ${cluster.count} 张照片`);
        button.onclick = () =>
          latest.current.onChoose(`cell:${resolution}:${cluster.cell}`);
        markers.current.push(
          new lib.Marker({ element: button })
            .setLngLat([cluster.longitude, cluster.latitude])
            .addTo(map.current),
        );
      }
    });
    return () => {
      cancelled = true;
      for (const marker of markers.current) marker.remove();
      markers.current = [];
    };
  }, [clusters, resolution, status]);
  return (
    <>
      <div
        ref={container}
        className="gallery-map"
        aria-label="交互底图"
        hidden={status === "disabled" || status === "failed"}
      />
      {status === "loading" ? <p role="status">加载底图…</p> : null}
      {status === "failed" || status === "disabled" ? (
        <p role="status">
          {status === "disabled" ? "底图已禁用" : "底图暂不可用"}
          ，仍可使用地区列表。
          {status === "failed" ? (
            <button
              className="gallery-text-button"
              onClick={() => setRetry((v) => v + 1)}
            >
              重试底图
            </button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
