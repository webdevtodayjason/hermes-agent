import { useCallback, useEffect, useRef, useState } from 'react'

import {
  TERMINAL_RUN_STATUSES,
  type WorkhorseClient,
  type WorkhorseEvent,
  type WorkhorseRun
} from './workhorse-contract'

export interface RunActivity {
  /** Most recent non-delta lifecycle event name (e.g. "tool.started"). */
  lastEvent: string
  /** Count of message.delta events — the "it's alive" ticker. */
  deltaCount: number
}

export interface WorkhorseRunView extends WorkhorseRun {
  activity: RunActivity
}

interface WorkhorseState {
  runs: WorkhorseRunView[]
  error: string | null
  submitting: boolean
}

const EMPTY_ACTIVITY: RunActivity = { lastEvent: '', deltaCount: 0 }

function isTerminal(status: WorkhorseRun['status']): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

function watchFailureText(event: WorkhorseEvent): string {
  // Task 1 emits `error` as a typed WorkhorseClientError carrying the
  // user-safe message; plain strings and top-level message are fallbacks.
  const raw = event.error

  if (raw && typeof raw === 'object' && 'message' in raw) {
    const message = (raw as { message?: unknown }).message

    if (typeof message === 'string' && message) {return message}
  }

  if (typeof raw === 'string' && raw) {return raw}

  if (typeof event.message === 'string' && event.message) {return event.message}

  return 'Lost contact with the run — use Retry to re-sync.'
}

/**
 * Panel-facing state over a WorkhorseClient: recover on mount, start/stop
 * actions, and a live activity feed per active run.
 *
 * Lifecycle rules (the races live here, so they are stated):
 * - A generation counter fences every async resolution; anything resolving
 *   after unmount or a client switch is discarded, so a slow recover() can
 *   neither publish stale rows nor register a watcher into a drained map.
 * - recover() results MERGE with local rows: runs the snapshot does not know
 *   about (submitted while it was in flight) stay, newest first.
 * - Watches end on terminal `run.*` events, on the client's bare `error`
 *   teardown signal, and on unmount. The error path must not trust a
 *   follow-up status() call — on a dead gateway it fails too, so the failure
 *   is surfaced and Retry (re-recover) is the bounded recovery affordance.
 */
export function useWorkhorse(client: WorkhorseClient) {
  const [state, setState] = useState<WorkhorseState>({
    runs: [],
    error: null,
    submitting: false
  })

  const unsubscribesRef = useRef<Map<string, () => void>>(new Map())
  const activityRef = useRef<Map<string, RunActivity>>(new Map())
  const generationRef = useRef(0)

  const applyRun = useCallback((run: WorkhorseRun) => {
    setState(previous => {
      const activity = activityRef.current.get(run.runId) ?? EMPTY_ACTIVITY
      const next = previous.runs.filter(existing => existing.runId !== run.runId)
      next.unshift({ ...run, activity })

      return { ...previous, runs: next }
    })
  }, [])

  const unwatch = useCallback((runId: string) => {
    const unsubscribe = unsubscribesRef.current.get(runId)

    if (unsubscribe) {
      unsubscribesRef.current.delete(runId)
      unsubscribe()
    }
  }, [])

  const watch = useCallback(
    (runId: string) => {
      if (unsubscribesRef.current.has(runId)) {return}

      const generation = generationRef.current

      const unsubscribe = client.watch(runId, (event: WorkhorseEvent) => {
        if (generation !== generationRef.current) {return}
        const name = event.event
        const current = activityRef.current.get(runId) ?? EMPTY_ACTIVITY
        activityRef.current.set(
          runId,
          name === 'message.delta'
            ? { ...current, deltaCount: current.deltaCount + 1 }
            : { ...current, lastEvent: name }
        )
        setState(previous => ({
          ...previous,
          runs: previous.runs.map(run =>
            run.runId === runId
              ? { ...run, activity: activityRef.current.get(runId) ?? EMPTY_ACTIVITY }
              : run
          )
        }))

        // run.* is the synthesized/native terminal; a bare `error` event is
        // the client's watch-teardown signal (poll failure) with no terminal
        // after it. Both settle via one authoritative status() read — but on
        // the error path that read usually fails too (same dead gateway), so
        // its rejection surfaces instead of being swallowed.
        if (name.startsWith('run.') || name === 'error') {
          unwatch(runId)
          const failureText = name === 'error' ? watchFailureText(event) : null
          void client.status(runId).then(
            run => {
              if (generation === generationRef.current) {applyRun(run)}
            },
            () => {
              if (generation !== generationRef.current) {return}
              setState(previous => ({
                ...previous,
                error: failureText ?? 'Run finished but its final status could not be read — use Retry.'
              }))
            }
          )
        }
      })

      unsubscribesRef.current.set(runId, unsubscribe)
    },
    [applyRun, client, unwatch]
  )

  const refresh = useCallback(async () => {
    const generation = generationRef.current

    try {
      const recovered = await client.recover()

      if (generation !== generationRef.current) {return}
      setState(previous => {
        const recoveredIds = new Set(recovered.map(run => run.runId))
        // Local rows the snapshot does not know about were created after it
        // was requested — they are newer and stay in front.
        const newerLocal = previous.runs.filter(run => !recoveredIds.has(run.runId))

        return {
          ...previous,
          error: null,
          runs: [
            ...newerLocal,
            ...recovered.map(run => ({
              ...run,
              activity: activityRef.current.get(run.runId) ?? EMPTY_ACTIVITY
            }))
          ]
        }
      })

      for (const run of recovered) {
        if (!isTerminal(run.status)) {watch(run.runId)}
      }
    } catch (error) {
      if (generation !== generationRef.current) {return}
      setState(previous => ({ ...previous, error: String(error) }))
    }
  }, [client, watch])

  const submit = useCallback(
    async (input: string) => {
      const job = input.trim()

      if (!job) {return}
      const generation = generationRef.current
      setState(previous => ({ ...previous, submitting: true, error: null }))

      try {
        const run = await client.startWork(job)

        if (generation !== generationRef.current) {return}
        applyRun(run)

        if (!isTerminal(run.status)) {watch(run.runId)}
      } catch (error) {
        if (generation !== generationRef.current) {return}
        setState(previous => ({ ...previous, error: String(error) }))
      } finally {
        if (generation === generationRef.current) {
          setState(previous => ({ ...previous, submitting: false }))
        }
      }
    },
    [applyRun, client, watch]
  )

  const stopRun = useCallback(
    async (runId: string) => {
      const generation = generationRef.current

      try {
        const run = await client.stop(runId)

        if (generation === generationRef.current) {applyRun(run)}
      } catch (error) {
        if (generation !== generationRef.current) {return}
        setState(previous => ({ ...previous, error: String(error) }))
      }
    },
    [applyRun, client]
  )

  useEffect(() => {
    void refresh()
    const subscriptions = unsubscribesRef.current

    return () => {
      generationRef.current += 1

      for (const unsubscribe of subscriptions.values()) {unsubscribe()}
      subscriptions.clear()
    }
  }, [refresh])

  return { ...state, submit, stopRun, refresh }
}
