# Rate limiting plan

We will add per-user rate limiting to the public API so that a single client
cannot, under any circumstances whatsoever, ever possibly overwhelm the shared
backend and thereby degrade the experience for everyone else on the platform.

## Approach

- Token-bucket per user, 100 requests/minute.
- Return `429` with a `Retry-After` header when the bucket is empty.
- Store buckets in Redis with a 60s TTL.
