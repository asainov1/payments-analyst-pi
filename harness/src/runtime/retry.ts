// Retry of transient LLM/proxy failures with exponential backoff + jitter (SPEC §3.2 runtime/governor).

export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterS?: number;
  constructor(status: number, message: string, retryAfterS?: number) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);

export function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 408 || e.status === 429 || e.status >= 500;
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

export interface RetryOptions {
  attempts?: number; // total tries, including the first
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (e: unknown, attempt: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseMs = 500, maxMs = 20_000, sleep = realSleep } = opts;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isRetryable(e)) throw e;
      opts.onRetry?.(e, i);
      const backoff = Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.5 + Math.random() / 2);
      const retryAfter = e instanceof HttpError && e.retryAfterS ? e.retryAfterS * 1000 : 0;
      await sleep(Math.max(backoff, retryAfter));
    }
  }
}
