// The launch URL carries the per-process capability in its fragment, which
// never reaches the HTTP server. The fragment is deliberately LEFT in the
// address bar: a reload re-reads it, so the page keeps working for the
// server's lifetime. Stripping it would buy nothing — later occupants of a
// reused loopback origin cannot read this visit's URL or history — while a
// strip plus in-memory-only retention would turn every F5 into a lockout.

let memoryToken: string | null = null;

/** Capture #token= from the launch URL; report whether the tab holds one. */
export function bootstrapToken(): boolean {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (token) memoryToken = token;
  return memoryToken !== null;
}

export function authHeaders(): Record<string, string> {
  return memoryToken ? { authorization: `Bearer ${memoryToken}` } : {};
}
