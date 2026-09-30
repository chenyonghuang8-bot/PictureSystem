export type OriginalDownloadLease = { release(): void };

export class OriginalDownloadLimiter {
  readonly #members = new Set<string>();
  #active = 0;

  constructor(
    private readonly processLimit = 2,
    private readonly perMemberLimit = 1,
  ) {}

  tryAcquire(familyId: string, memberId: string): OriginalDownloadLease | null {
    const key = `${familyId}:${memberId}`;
    if (
      this.#active >= this.processLimit ||
      (this.perMemberLimit === 1 && this.#members.has(key))
    ) {
      return null;
    }
    this.#active += 1;
    this.#members.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#members.delete(key);
      },
    };
  }

  snapshot() {
    return { active: this.#active, activeMembers: this.#members.size };
  }
}
