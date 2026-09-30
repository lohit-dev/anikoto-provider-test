export class RateLimitedError extends Error {
  constructor(public provider: string, public retryAfter: number) {
    super(`${provider} rate limited, retry after ${retryAfter}s`);
  }
}
