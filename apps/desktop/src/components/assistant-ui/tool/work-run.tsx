import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'

import {
  TERMINAL_RUN_STATUSES,
  type WorkhorseClient,
  type WorkhorseEvent,
  type WorkhorseRun,
  type WorkhorseRunStatus
} from '@/app/workhorse/workhorse-contract'
import { Button } from '@/components/ui/button'

/**
 * Inline run chip: the custom renderer for the `work_start` delegation
 * tool part in the chat stream. The tool result (run_id/status) is the
 * authoritative record from the transcript; when a live WorkhorseClient is
 * provided via context the chip follows the run (watch → settle) and offers
 * Stop. Without a client (transcript replay, tests, logs) it renders the
 * recorded state statically. No page, no route: the conversation is the UI.
 */

const WorkRunClientContext = createContext<WorkhorseClient | null>(null)

/** Consumer hook for the live client; null means transcript-replay mode. */
export function useWorkRunClient(): WorkhorseClient | null {
  return useContext(WorkRunClientContext)
}

export function WorkRunClientProvider({
  client,
  children
}: {
  client: WorkhorseClient
  children: ReactNode
}) {
  return <WorkRunClientContext.Provider value={client}>{children}</WorkRunClientContext.Provider>
}

interface WorkRunToolProps {
  args?: unknown
  result?: unknown
  toolCallId?: string
  toolName?: string
}

const STATUS_TONE: Record<WorkhorseRunStatus | 'starting', string> = {
  starting: 'bg-muted text-muted-foreground',
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-primary/15 text-primary',
  waiting_for_approval: 'bg-amber-500/15 text-amber-600',
  stopping: 'bg-amber-500/15 text-amber-600',
  completed: 'bg-emerald-500/15 text-emerald-600',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground'
}

function parseRun(result: unknown): WorkhorseRun | null {
  if (!result || typeof result !== 'object') {return null}
  const record = result as { run_id?: unknown; runId?: unknown; status?: unknown; output?: unknown; error?: unknown }
  const runId = typeof record.run_id === 'string' ? record.run_id : typeof record.runId === 'string' ? record.runId : null

  if (!runId || typeof record.status !== 'string') {return null}

  return {
    runId,
    status: record.status as WorkhorseRunStatus,
    ...(typeof record.output === 'string' && { output: record.output }),
    ...(typeof record.error === 'string' && { error: record.error })
  }
}

function taskLabel(args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as { task?: unknown; input?: unknown }

    if (typeof record.task === 'string' && record.task) {return record.task}

    if (typeof record.input === 'string' && record.input) {return record.input}
  }

  return 'Background work'
}

function isTerminal(status: WorkhorseRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function WorkRunTool({ args, result }: WorkRunToolProps) {
  const client = useContext(WorkRunClientContext)
  const recorded = parseRun(result)
  const [run, setRun] = useState<WorkhorseRun | null>(recorded)
  const [lastEvent, setLastEvent] = useState('')
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // The recorded tool result is authoritative on (re)mount; live updates
  // layer on top of it.
  const runId = recorded?.runId ?? run?.runId ?? null
  const live = client !== null && runId !== null && run !== null && !isTerminal(run.status)

  useEffect(() => {
    if (!live || !client || !runId) {return}

    if (unsubscribeRef.current) {return}

    const unsubscribe = client.watch(runId, (event: WorkhorseEvent) => {
      const name = event.event

      if (name !== 'message.delta') {setLastEvent(name)}

      if (name.startsWith('run.') || name === 'error') {
        unsubscribeRef.current?.()
        unsubscribeRef.current = null
        client.status(runId).then(setRun, () => {
          setLastEvent('connection lost — final state unknown')
        })
      }
    })

    unsubscribeRef.current = unsubscribe

    return () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [client, live, runId])

  const status: WorkhorseRunStatus | 'starting' = run?.status ?? 'starting'
  const active = run !== null && !isTerminal(run.status) && run.status !== 'stopping'

  const stop = () => {
    if (client && runId) {
      client.stop(runId).then(setRun, () => setLastEvent('stop request failed'))
    }
  }

  return (
    <div className="my-1 rounded-lg border bg-background/55 p-2" data-testid="work-run-chip">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${STATUS_TONE[status]}`}
          data-testid="work-run-status"
        >
          {status.replace(/_/g, ' ')}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{taskLabel(args)}</span>
        {client !== null && active && (
          <Button onClick={stop} size="sm" variant="outline">
            Stop
          </Button>
        )}
      </div>
      {lastEvent && !isTerminal(status as WorkhorseRunStatus) && status !== 'starting' && (
        <p className="mt-1 text-[0.7rem] text-muted-foreground">{lastEvent}</p>
      )}
      {run?.status === 'completed' && run.output && (
        <p className="mt-1.5 whitespace-pre-wrap text-sm" data-testid="work-run-output">
          {run.output}
        </p>
      )}
      {run?.status === 'failed' && (
        <p className="mt-1.5 text-sm text-destructive" data-testid="work-run-error">
          {run.error ?? 'Run failed'}
        </p>
      )}
    </div>
  )
}
