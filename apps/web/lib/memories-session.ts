import type {
  MemoriesContext,
  MemoriesPage,
  MemoriesPreview,
} from "@family-album/contracts";
import { GalleryClientError } from "./gallery-client.js";

export type MemoriesData = MemoriesPage | MemoriesPreview;
export type MemoriesState = {
  data: MemoriesData | null;
  loading: boolean;
  error: "retry" | "auth" | null;
};
type Fetcher = (
  cursor: string | undefined,
  signal: AbortSignal,
) => Promise<MemoriesData>;

// One controller per actor/family/kind. Epochs invalidate even successful late replies.
export class MemoriesSession {
  state: MemoriesState = { data: null, loading: false, error: null };
  private epoch = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private usedBootstrap = false;
  private active = false;
  constructor(
    private fetcher: Fetcher,
    private changed: (state: MemoriesState) => void,
    private now: () => number = () => performance.now(),
  ) {}
  private publish(state: MemoriesState) {
    this.state = state;
    this.changed(state);
  }
  private clear() {
    this.epoch++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.publish({ data: null, loading: false, error: null });
  }
  activate() {
    this.active = true;
    this.usedBootstrap = false;
    this.clear();
    void this.fetch();
  }
  suspend() {
    this.active = false;
    this.clear();
  }
  expire() {
    if (!this.active) return;
    this.clear();
    if (this.usedBootstrap) {
      this.publish({ data: null, loading: false, error: "retry" });
      return;
    }
    this.usedBootstrap = true;
    void this.fetch();
  }
  loadMore() {
    const data = this.state.data;
    if (
      this.state.loading ||
      !data ||
      !("nextCursor" in data) ||
      !data.nextCursor
    )
      return;
    void this.fetch(data.nextCursor);
  }
  private async fetch(cursor?: string) {
    const epoch = ++this.epoch,
      controller = new AbortController(),
      started = this.now();
    this.controller?.abort();
    this.controller = controller;
    this.publish({ ...this.state, loading: true, error: null });
    try {
      const result = await this.fetcher(cursor, controller.signal);
      if (!this.active || controller.signal.aborted || epoch !== this.epoch)
        return;
      const context: MemoriesContext = result.context;
      const duration =
        Date.parse(context.nextMidnight) - Date.parse(context.serverNow);
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 26 * 60 * 60_000
      )
        throw new Error("INVALID_CONTEXT");
      const deadline = started + duration;
      if (this.now() >= deadline) {
        this.expire();
        return;
      }
      const previous = this.state.data;
      if (cursor && previous && "media" in previous && "media" in result) {
        if (
          previous.kind !== result.kind ||
          previous.context.anchorDate !== context.anchorDate
        ) {
          this.expire();
          return;
        }
        const seen = new Set(previous.media.map((item) => item.mediaId));
        result.media = [
          ...previous.media,
          ...result.media.filter((item) => !seen.has(item.mediaId)),
        ];
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => this.expire(),
        Math.max(0, deadline - this.now()),
      );
      this.publish({ data: result, loading: false, error: null });
    } catch (error) {
      if (!this.active || controller.signal.aborted || epoch !== this.epoch)
        return;
      if (
        error instanceof GalleryClientError &&
        error.code === "MEMORIES_ANCHOR_EXPIRED"
      ) {
        this.expire();
        return;
      }
      this.clear();
      this.publish({
        data: null,
        loading: false,
        error:
          error instanceof GalleryClientError &&
          error.code === "UNAUTHENTICATED"
            ? "auth"
            : "retry",
      });
    }
  }
}
