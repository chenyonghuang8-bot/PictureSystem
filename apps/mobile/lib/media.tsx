import { useEffect, useState } from "react";
import {
  Image,
  View,
  Text,
  type StyleProp,
  type ImageStyle,
} from "react-native";
import { File, Directory, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { request, session } from "./session";
const dir = new Directory(Paths.cache, "private-previews");
let active = 0;
const waiters: (() => void)[] = [];
const files = new Map<string, number>();
let generation = 0;
export function clearMedia() {
  generation++;
  for (const uri of files.keys()) {
    const f = new File(uri);
    if (f.exists) f.delete();
  }
  files.clear();
  if (dir.exists) dir.delete();
  const exported = new Directory(Paths.cache, "explicit-exports");
  if (exported.exists) exported.delete();
}
export async function loadMedia(id: string, kind: "thumbnail" | "preview") {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("INVALID_ID");
  const epoch = session.get().epoch,
    g = generation;
  if (active >= 2)
    await new Promise<void>((resolve) =>
      waiters.push(() => {
        active++;
        resolve();
      }),
    );
  else active++;
  let file: File | undefined;
  try {
    if (epoch !== session.get().epoch || g !== generation)
      throw new Error("STALE_MEDIA");
    const response = await request(`/api/v1/media/${id}/derived/${kind}`);
    const type = response.headers.get("content-type");
    if (!type || !/^image\/(jpeg|png|webp)$/.test(type))
      throw new Error("INVALID_MEDIA");
    const limit = kind === "thumbnail" ? 4 * 1024 ** 2 : 16 * 1024 ** 2;
    if (Number(response.headers.get("content-length")) > limit)
      throw new Error("MEDIA_LIMIT");
    dir.create({ intermediates: true, idempotent: true });
    file = new File(dir, randomUUID() + ".img");
    file.create();
    const h = file.open();
    let count = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("MEDIA_UNAVAILABLE");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        count += chunk.value.length;
        if (
          count > limit ||
          epoch !== session.get().epoch ||
          g !== generation
        ) {
          await reader.cancel();
          throw new Error("STALE_MEDIA");
        }
        h.writeBytes(chunk.value);
      }
    } finally {
      h.close();
    }
    if (epoch !== session.get().epoch || g !== generation)
      throw new Error("STALE_MEDIA");
    let total = [...files.values()].reduce((a, b) => a + b, 0);
    for (const [uri, size] of files) {
      if (total + count <= 64 * 1024 ** 2) break;
      const f = new File(uri);
      if (f.exists) f.delete();
      files.delete(uri);
      total -= size;
    }
    files.set(file.uri, count);
    return file.uri;
  } catch {
    if (file?.exists) file.delete();
    throw new Error("MEDIA_UNAVAILABLE");
  } finally {
    active--;
    waiters.shift()?.();
  }
}
export function PrivateImage({
  id,
  kind = "thumbnail",
  style,
}: {
  id: string;
  kind?: "thumbnail" | "preview";
  style: StyleProp<ImageStyle>;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setUri(null);
    setError(false);
    loadMedia(id, kind)
      .then((x) => {
        if (alive) setUri(x);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [id, kind]);
  return uri ? (
    <Image
      accessibilityLabel="家庭照片"
      source={{ uri }}
      style={style}
      resizeMode={kind === "preview" ? "contain" : "cover"}
      onError={() => {
        setUri(null);
        setError(true);
      }}
    />
  ) : (
    <View
      style={[
        style,
        {
          backgroundColor: "#edeae4",
          alignItems: "center",
          justifyContent: "center",
        },
      ]}
    >
      <Text style={{ color: "#79746c" }}>
        {error ? "照片暂不可用" : "加载中"}
      </Text>
    </View>
  );
}

/** Explicit OS share/export only; never triggered by opening a viewer. */
export async function exportPhoto(
  albumId: string,
  mediaId: string,
  kind: "original" | "preview",
) {
  if (!/^[1-9][0-9]*$/.test(albumId) || !/^[1-9][0-9]*$/.test(mediaId))
    throw new Error("INVALID_ID");
  const { shareAsync, isAvailableAsync } = await import("expo-sharing");
  if (!(await isAvailableAsync())) throw new Error("SHARING_UNAVAILABLE");
  const epoch = session.get().epoch;
  const response = await request(
    `/api/v1/albums/${albumId}/media/${mediaId}/download/${kind}`,
  );
  const size = Number(response.headers.get("content-length"));
  if (
    size > 256 * 1024 ** 2 ||
    Paths.availableDiskSpace < Math.max(size, 0) + 128 * 1024 ** 2
  )
    throw new Error("DOWNLOAD_LIMIT");
  const folder = new Directory(Paths.cache, "explicit-exports");
  folder.create({ idempotent: true, intermediates: true });
  const file = new File(folder, randomUUID() + ".jpg");
  file.create();
  const h = file.open();
  let total = 0;
  try {
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      while (true) {
        const c = await reader.read();
        if (c.done) break;
        total += c.value.length;
        if (epoch !== session.get().epoch || total > 256 * 1024 ** 2) {
          await reader.cancel();
          throw new Error();
        }
        h.writeBytes(c.value);
      }
    } finally {
      h.close();
    }
    if (epoch !== session.get().epoch) throw new Error();
    await shareAsync(file.uri, {
      mimeType: response.headers.get("content-type") ?? "image/jpeg",
      dialogTitle: "保存或分享选中的照片",
    });
  } finally {
    if (file.exists) file.delete();
  }
}
