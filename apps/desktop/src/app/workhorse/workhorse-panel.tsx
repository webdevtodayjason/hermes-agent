import { useState } from 'react'

import { Button } from '@/components/ui/button'

import { useWorkhorse, type WorkhorseRunView } from './use-workhorse'
import { TERMINAL_RUN_STATUSES, type WorkhorseClient, type WorkhorseRunStatus } from './workhorse-contract'

interface WorkhorsePanelProps {
  client: WorkhorseClient
}

const STATUS_TONE: Record<WorkhorseRunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-primary/15 text-primary',
  waiting_for_approval: 'bg-amber-500/15 text-amber-600',
  stopping: 'bg-amber-500/15 text-amber-600',
  completed: 'bg-emerald-500/15 text-emerald-600',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground'
}

function StatusChip({ status }: { status: WorkhorseRunStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${STATUS_TONE[status]}`}
      data-testid="status-chip"
    >
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function ActivityLine({ run }: { run: WorkhorseRunView }) {
  if (TERMINAL_RUN_STATUSES.has(run.status)) {return null}
  const parts: string[] = []

  if (run.activity.lastEvent) {parts.push(run.activity.lastEvent)}

  if (run.activity.deltaCount > 0) {parts.push(`${run.activity.deltaCount} deltas`)}

  if (parts.length === 0) {parts.push('working…')}

  return (
    <p className="mt-1 text-[0.7rem] text-muted-foreground" data-testid="activity-line">
      {parts.join(' · ')}
    </p>
  )
}

function RunCard({ run, onStop }: { run: WorkhorseRunView; onStop: (runId: string) => void }) {
  const active = !TERMINAL_RUN_STATUSES.has(run.status) && run.status !== 'stopping'

  return (
    <div className="rounded-lg bg-background/55 p-2.5" data-testid="run-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusChip status={run.status} />
          <span className="truncate font-mono text-[0.7rem] text-muted-foreground">{run.runId}</span>
        </div>
        {active && (
          <Button onClick={() => onStop(run.runId)} size="sm" variant="outline">
            Stop
          </Button>
        )}
      </div>
      <ActivityLine run={run} />
      {run.status === 'completed' && run.output && (
        <p className="mt-2 whitespace-pre-wrap text-sm" data-testid="run-output">
          {run.output}
        </p>
      )}
      {run.status === 'failed' && (
        <p className="mt-2 text-sm text-destructive" data-testid="run-error">
          {run.error ?? 'Run failed'}
        </p>
      )}
    </div>
  )
}

/**
 * The workhorse loop, clickable: hand Hermes a job, watch it work, stop it
 * mid-flight. Slice 1 of the Jarvis track — this panel exercises the exact
 * WorkhorseClient contract the realtime voice adapter will drive next.
 */
export function WorkhorsePanel({ client }: WorkhorsePanelProps) {
  const { runs, error, submitting, submit, stopRun, refresh } = useWorkhorse(client)
  const [draft, setDraft] = useState('')

  const handleSubmit = async () => {
    const job = draft
    setDraft('')
    await submit(job)
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm"
          data-testid="job-input"
          disabled={submitting}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && draft.trim()) {void handleSubmit()}
          }}
          placeholder="Give the workhorse a job…"
          value={draft}
        />
        <Button disabled={submitting || !draft.trim()} onClick={() => void handleSubmit()}>
          {submitting ? 'Starting…' : 'Start'}
        </Button>
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-destructive" data-testid="panel-error">
            {error}
          </p>
          <Button onClick={() => void refresh()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {runs.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No runs yet — the workhorse is ready.</p>
        )}
        {runs.map(run => (
          <RunCard key={run.runId} onStop={runId => void stopRun(runId)} run={run} />
        ))}
      </div>
    </div>
  )
}
