import { NeonLoader } from "@/components/neon-loader/neon-loader";
import type { Coverage } from "@/lib/api";
import { formatUtcInstant } from "@/lib/metrics";
import { useQueueStatus } from "@/lib/queue-status";
import { cn } from "@/lib/utils";

/**
 * The honesty strip: coverage status, quality flags, and report timestamps
 * stay visible on every view. Partial coverage is a fact about the data,
 * never a rendering detail to drop.
 */
export function CoverageBanner({
  coverage,
  generatedAt,
  asOf,
  servedFromStore,
  extra,
}: {
  coverage: Coverage;
  generatedAt: string;
  asOf?: string;
  /** Buckets served from the local store instead of a fresh collection. */
  servedFromStore?: { from: string; to: string; collectedAt: string } | undefined;
  extra?: string[];
}) {
  const partial = coverage.status === "partial";
  const flags = coverage.qualityFlags ?? [];
  const notes = [...(coverage.errors ?? []), ...(extra ?? [])];
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs",
        partial
          ? "border-[color:var(--status-scaling)]/40 bg-[color:var(--status-scaling)]/10"
          : "border-[color:var(--border)] bg-[color:var(--muted)]/40",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-medium",
          partial ? "text-[color:var(--status-scaling)]" : "text-[color:var(--status-active)]",
        )}
      >
        <span aria-hidden>{partial ? "◐" : "●"}</span>
        {partial ? "Partial coverage" : "Complete coverage"}
      </span>
      <span className="text-[color:var(--muted-foreground)]">
        generated {formatUtcInstant(generatedAt)}
      </span>
      {asOf ? (
        <span className="text-[color:var(--muted-foreground)]">as of {formatUtcInstant(asOf)}</span>
      ) : null}
      {servedFromStore ? (
        <span className="text-[color:var(--muted-foreground)]">
          served from local store through {servedFromStore.to.slice(0, 10)} (collected{" "}
          {formatUtcInstant(servedFromStore.collectedAt)})
        </span>
      ) : null}
      {flags.map((flag) => (
        <span
          key={flag}
          className="rounded border border-[color:var(--border)] bg-[color:var(--card)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--muted-foreground)]"
        >
          {flag}
        </span>
      ))}
      {notes.map((note) => (
        <span key={note} className="text-[color:var(--status-scaling)]">
          {note}
        </span>
      ))}
    </div>
  );
}

/** The explicit collecting state: a fresh collection can take a minute.
 * While mounted it watches the server's collection queue (/api/queue), so a
 * request waiting its turn says so instead of looking like an endless
 * collection. */
export function CollectingNotice({ label }: { label: string }) {
  const queue = useQueueStatus();
  return (
    <div
      className="flex items-center gap-2 text-xs text-[color:var(--muted-foreground)]"
      role="status"
      aria-live="polite"
    >
      <NeonLoader size="sm" decorative className="shrink-0" />
      <span>
        Collecting {label} from Neon… fresh collections walk the API under the
        account request budget (45 requests/minute unless raised) and can take up to a minute.
        {queue && queue.queued > 0 ? (
          <>
            {" "}
            Collections run one at a time to keep the local store consistent;{" "}
            {queue.queued === 1 ? "1 request is" : `${queue.queued} requests are`} queued behind
            the one running, so this may still be waiting its turn.
          </>
        ) : null}
      </span>
    </div>
  );
}
