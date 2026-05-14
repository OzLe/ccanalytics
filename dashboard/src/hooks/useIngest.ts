/**
 * React Query hook for the POST /api/ingest endpoint.
 *
 * `useIngest()` triggers an incremental ingestion pass. On success it
 * invalidates EVERY query in the cache — an ingestion can touch sessions,
 * cost, tools, cache, activity and prompts, so the whole dashboard should
 * re-fetch and reflect the newly ingested data immediately.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "@/lib/api";
import type { ApiEnvelope, IngestResult } from "@/lib/types";

/**
 * POST /api/ingest — runs an incremental ingestion pass.
 *
 * On success, invalidates the entire query cache so all dashboard views
 * re-fetch against the freshly ingested data. A 409 (an ingestion is already
 * running) surfaces as a normal mutation error for the caller to display.
 */
export function useIngest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<ApiEnvelope<IngestResult>>("/ingest"),
    onSuccess: () => {
      // New data was ingested — every cached view is potentially stale.
      queryClient.invalidateQueries();
    },
  });
}
