export type PreviewDownloadLease = { release(): void };

export class PreviewDownloadLimiter {
  readonly #members = new Map<string, number>();
  #active = 0;

  constructor(
    private readonly processLimit = 4,
    private readonly perMemberLimit = 2,
  ) {}

  tryAcquire(familyId: string, memberId: string): PreviewDownloadLease | null {
    const key = `${familyId}:${memberId}`;
    const memberActive = this.#members.get(key) ?? 0;
    if (
      this.#active >= this.processLimit ||
      memberActive >= this.perMemberLimit
    ) {
      return null;
    }
    this.#active += 1;
    this.#members.set(key, memberActive + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        const current = this.#members.get(key) ?? 0;
        if (current <= 1) this.#members.delete(key);
        else this.#members.set(key, current - 1);
      },
    };
  }

  snapshot() {
    return {
      active: this.#active,
      activeMembers: this.#members.size,
      memberCounts: [...this.#members.values()].sort((a, b) => a - b),
    };
  }
}
