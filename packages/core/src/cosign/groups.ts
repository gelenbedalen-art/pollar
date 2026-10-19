import type { CosignRequest } from '../types';

/**
 * Approval groups: steps of one flow (a ramp's swap, its bridge) the user
 * approves together. The first request of a group is shown with every step it
 * covers; once the user approves it, the device votes the group's later steps
 * on its own, each still verified against its own payload before the vote. A
 * request outside the steps the user saw, or of a group whose consent lapsed,
 * is shown to the user again.
 */

export interface CosignGroup {
  id: string;
  title: string;
  steps: Array<{ key: string; label: string }>;
}

/** The approval group a request belongs to, when the backend declared one with a usable shape. */
export function cosignGroupOf(request: CosignRequest): CosignGroup | null {
  const group = (request as { group?: unknown }).group as Partial<CosignGroup> | undefined;
  if (!group || typeof group.id !== 'string' || typeof group.title !== 'string' || !Array.isArray(group.steps)) return null;
  const steps = group.steps.filter(
    (s): s is { key: string; label: string } =>
      !!s && typeof (s as { key?: unknown }).key === 'string' && typeof (s as { label?: unknown }).label === 'string',
  );
  return steps.length > 0 ? { id: group.id, title: group.title, steps } : null;
}

/** The step of a multi-step flow a request is for. */
export function cosignStepKeyOf(request: CosignRequest): string | null {
  const key = (request as { stepKey?: unknown }).stepKey;
  return typeof key === 'string' ? key : null;
}

/** A step key belongs to a group step when it is that key or carries it as a prefix (`<key>:...`). */
export function stepInGroup(group: Pick<CosignGroup, 'steps'>, stepKey: string): boolean {
  return group.steps.some((s) => stepKey === s.key || stepKey.startsWith(`${s.key}:`));
}

interface Consent {
  steps: Array<{ key: string; label: string }>;
  expiresAt: number;
}

/** Where consents survive a reload; absent, they last as long as the client. */
export interface CosignGroupConsentStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

/** A day: about as long as a co-sign request may wait for its vote. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class CosignGroupConsents {
  private consents = new Map<string, Consent>();

  constructor(
    private readonly store?: CosignGroupConsentStore,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read what an earlier session recorded; unreadable data is ignored. */
  async load(): Promise<void> {
    if (!this.store) return;
    try {
      const raw = await this.store.load();
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, Consent>;
      for (const [id, consent] of Object.entries(parsed)) {
        if (consent && Array.isArray(consent.steps) && typeof consent.expiresAt === 'number') this.consents.set(id, consent);
      }
      this.prune();
    } catch {
      // A corrupt record only costs the user a prompt they would have answered anyway.
    }
  }

  /**
   * The user approved a request of a group: record the steps that request
   * showed them. Those, and only those, are voted later without asking.
   */
  grant(request: CosignRequest): void {
    const group = cosignGroupOf(request);
    if (!group) return;
    this.consents.set(group.id, { steps: group.steps, expiresAt: this.now() + this.ttlMs });
    void this.persist();
  }

  /** Whether the user already approved the group this request belongs to, and this step is one it showed. */
  covers(request: CosignRequest): boolean {
    const group = cosignGroupOf(request);
    const stepKey = cosignStepKeyOf(request);
    if (!group || !stepKey) return false;
    const consent = this.consents.get(group.id);
    if (!consent || consent.expiresAt <= this.now()) return false;
    return stepInGroup(consent, stepKey);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, consent] of this.consents) if (consent.expiresAt <= now) this.consents.delete(id);
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    this.prune();
    try {
      await this.store.save(JSON.stringify(Object.fromEntries(this.consents)));
    } catch {
      // Kept in memory; only a reload loses it.
    }
  }
}
