// Live collection-queue depth from /api/queue, so loading copy can say
// "waiting in the queue" instead of an endless "collecting". One shared
// poller no matter how many notices are mounted: it starts with the first
// subscriber, stops with the last, and polls only while something is
// actually showing a collecting state.

import { useEffect, useState } from "react";
import { authHeaders } from "./auth";

export type QueueStatus = { running: number; queued: number };

const POLL_MS = 2500;

let current: QueueStatus | null = null;
const listeners = new Set<(status: QueueStatus | null) => void>();
let timer: number | null = null;

async function poll(): Promise<void> {
  try {
    const response = await fetch("/api/queue", { headers: authHeaders() });
    current = response.ok ? ((await response.json()) as QueueStatus) : null;
  } catch {
    // Unknown beats wrong: render nothing rather than a stale depth.
    current = null;
  }
  for (const listener of listeners) listener(current);
}

/** Queue depth while mounted; null when unknown (fetch failed or first poll pending). */
export function useQueueStatus(): QueueStatus | null {
  const [status, setStatus] = useState<QueueStatus | null>(current);
  useEffect(() => {
    listeners.add(setStatus);
    if (timer === null) {
      void poll();
      timer = window.setInterval(() => void poll(), POLL_MS);
    }
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
        current = null;
      }
    };
  }, []);
  return status;
}
