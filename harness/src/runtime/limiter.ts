// Per-model requests-per-minute limiter. LiteLLM sends no x-ratelimit-* headers (SPEC §4.5), so the
// limit is static from config and halves for a 60 s cooldown after every 429.

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly rpm: number;
  private readonly now: () => number;
  private readonly reservations = new Map<string, number[]>();
  private readonly cooldown = new Map<string, { until: number; factor: number }>();

  constructor(opts: { rpm: number; now?: () => number }) {
    this.rpm = opts.rpm;
    this.now = opts.now ?? Date.now;
  }

  effectiveRpm(model: string): number {
    const c = this.cooldown.get(model);
    if (!c || this.now() >= c.until) {
      this.cooldown.delete(model);
      return this.rpm;
    }
    return Math.max(1, Math.floor(this.rpm * c.factor));
  }

  onRateLimited(model: string): void {
    const prev = this.cooldown.get(model);
    const factor = prev && this.now() < prev.until ? prev.factor / 2 : 0.5;
    this.cooldown.set(model, { until: this.now() + WINDOW_MS, factor });
  }

  /** Reserves a slot; returns how many ms the caller must wait before sending. */
  reserve(model: string): number {
    const now = this.now();
    const limit = this.effectiveRpm(model);
    const slots = (this.reservations.get(model) ?? []).filter((t) => t > now - WINDOW_MS);
    let at = now;
    if (slots.length >= limit) at = slots[slots.length - limit] + WINDOW_MS;
    slots.push(at);
    this.reservations.set(model, slots);
    return at - now;
  }
}
