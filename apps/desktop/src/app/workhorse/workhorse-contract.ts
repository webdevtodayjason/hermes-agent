/**
 * The seam between the workhorse panel (fable-5's slice) and the client
 * plumbing (hermes-sol's slice). Both sides build to this contract verbatim;
 * changing it is a cross-review event, not a local edit. Canonical copy of
 * the contract lives in docs/plans/2026-07-15-phase2-slice1-desktop-workhorse-panel.md.
 */

export type WorkhorseRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TERMINAL_RUN_STATUSES: ReadonlySet<WorkhorseRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled'
])

export interface WorkhorseRun {
  runId: string
  status: WorkhorseRunStatus
  output?: string
  error?: string
  createdAt?: number
  endedAt?: number
}

export interface WorkhorseEvent {
  event: string
  [key: string]: unknown
}

export interface WorkhorseClient {
  startWork(input: string): Promise<WorkhorseRun>
  recover(): Promise<WorkhorseRun[]>
  status(runId: string): Promise<WorkhorseRun>
  stop(runId: string): Promise<WorkhorseRun>
  /** Live event feed for one run; returns unsubscribe. Implementations may
   *  poll status as a degraded fallback but must still emit terminal events. */
  watch(runId: string, onEvent: (event: WorkhorseEvent) => void): () => void
}

/** Model-callable delegation tool whose tool-call/result part the inline
 *  run chip renders. PENDING hermes-sol confirmation of the registered
 *  backend tool name; the chip dispatch keys on this single constant. */
export const WORK_START_TOOL_NAME = 'work_start'
