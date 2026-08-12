import { useEffect, useRef, useState } from "react";
import { authHeaders } from "./auth";

export type ReportState<T> = {
  data: T | null;
  error: string | null;
  /** True while a request is in flight, including refetches. */
  loading: boolean;
};

/**
 * Fetches a report route and tracks its lifecycle. Collection routes walk
 * the Neon API under the account request budget, so a load can take a
 * minute — callers must render that state honestly, not as a hang.
 */
export function useReport<T>(path: string | null): ReportState<T> {
  const [state, setState] = useState<ReportState<T>>({
    data: null,
    error: null,
    loading: path !== null,
  });
  const generation = useRef(0);
  const requestedPath = useRef(path);

  // Reflect a path change synchronously (before paint) so a section never
  // renders a blank frame between "Collect clicked" and the fetch effect
  // flipping loading on — the effect runs after this render commits.
  if (requestedPath.current !== path) {
    requestedPath.current = path;
    generation.current += 1;
    setState({ data: null, error: null, loading: path !== null });
  }

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const requested = ++generation.current;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, error: null, loading: true }));
    fetch(path, {
      signal: controller.signal,
      headers: { accept: "application/json", ...authHeaders() },
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (generation.current !== requested) return;
        if (!response.ok) {
          const detail =
            typeof body === "object" && body !== null && "error" in body
              ? (body.error as { code?: string; message?: string })
              : {};
          setState({
            data: null,
            error: `${detail.code ?? response.status}: ${detail.message ?? "request failed"}`,
            loading: false,
          });
          return;
        }
        setState({ data: body as T, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (generation.current !== requested || controller.signal.aborted) return;
        setState({
          data: null,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      });
    return () => controller.abort();
  }, [path]);

  return state;
}
