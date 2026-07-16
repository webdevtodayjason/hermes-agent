import type {
  WorkhorseClient,
  WorkhorseEvent,
  WorkhorseRun,
  WorkhorseRunStatus
} from '../app/workhorse/workhorse-contract'

export type WorkhorseClientErrorKind = 'invalid_request' | 'not_found' | 'unavailable' | 'unknown'

export class WorkhorseClientError extends Error {
  constructor(
    message: string,
    readonly kind: WorkhorseClientErrorKind,
    readonly originalError: unknown
  ) {
    super(message)
    this.name = 'WorkhorseClientError'
  }
}

export type WorkhorseRpcRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface CreateWorkhorseClientOptions {
  profile: string
  request: WorkhorseRpcRequest
}

interface RpcRun {
  run_id: string
  status: WorkhorseRunStatus
  output?: string
  error?: string
  created_at?: number
  updated_at?: number
}

function conversationId(profile: string): string {
  return `desktop-workhorse:${profile.trim() || 'default'}`
}

function mapRun(run: RpcRun): WorkhorseRun {
  const terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'

  return {
    runId: run.run_id,
    status: run.status,
    ...(run.output !== undefined && { output: run.output }),
    ...(run.error !== undefined && { error: run.error }),
    ...(run.created_at !== undefined && { createdAt: run.created_at }),
    ...(terminal && run.updated_at !== undefined && { endedAt: run.updated_at })
  }
}

function mapError(error: unknown): WorkhorseClientError {
  if (error instanceof WorkhorseClientError) {
    return error
  }

  const record = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : {}
  const code = typeof record.code === 'number' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : String(error)

  if (code === -32602 || /invalid params?/i.test(message)) {
    return new WorkhorseClientError(
      'The work request is invalid. Check the job and try again.',
      'invalid_request',
      error
    )
  }

  if (code === -32004 || /run not found/i.test(message)) {
    return new WorkhorseClientError('This run is no longer available.', 'not_found', error)
  }

  if (/not connected|connection closed|websocket closed|request timed out/i.test(message)) {
    return new WorkhorseClientError('Hermes is not connected. Reconnect and try again.', 'unavailable', error)
  }

  return new WorkhorseClientError('Workhorse request failed. Try again.', 'unknown', error)
}

export function createWorkhorseClient({ profile, request }: CreateWorkhorseClientOptions): WorkhorseClient {
  const sessionId = conversationId(profile)

  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    try {
      return await request<T>(method, params)
    } catch (error) {
      throw mapError(error)
    }
  }

  return {
    async startWork(input: string): Promise<WorkhorseRun> {
      const run = await call<RpcRun>('work.start', { input, session_id: sessionId })

      return mapRun(run)
    },
    async recover(): Promise<WorkhorseRun[]> {
      const response = await call<{ data: RpcRun[] }>('work.recover', { session_id: sessionId })

      return response.data.map(mapRun)
    },
    async status(runId: string, ownerSessionId?: string): Promise<WorkhorseRun> {
      const run = await call<RpcRun>('work.status', {
        run_id: runId,
        session_id: ownerSessionId?.trim() || sessionId
      })

      return mapRun(run)
    },
    async stop(runId: string, ownerSessionId?: string): Promise<WorkhorseRun> {
      const run = await call<RpcRun>('work.stop', {
        run_id: runId,
        session_id: ownerSessionId?.trim() || sessionId
      })

      return mapRun(run)
    },
    watch(runId: string, onEvent: (event: WorkhorseEvent) => void, ownerSessionId?: string): () => void {
      // Desktop's gateway does not expose per-run events yet. Poll the canonical
      // status RPC as the explicit degraded fallback and synthesize terminal events.
      let stopped = false
      let polling = false
      let timer: ReturnType<typeof setInterval>

      const stopPolling = () => {
        if (!stopped) {
          stopped = true
          clearInterval(timer)
        }
      }

      const poll = async () => {
        if (stopped || polling) {
          return
        }

        polling = true

        try {
          const run = mapRun(
            await call<RpcRun>('work.status', {
              run_id: runId,
              session_id: ownerSessionId?.trim() || sessionId
            })
          )

          if (stopped) {
            return
          }

          const terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'

          onEvent({ event: terminal ? `run.${run.status}` : 'status.update', run })

          if (terminal) {
            stopPolling()
          }
        } catch (error) {
          if (!stopped) {
            onEvent({ event: 'error', error: mapError(error) })
            stopPolling()
          }
        } finally {
          polling = false
        }
      }

      timer = setInterval(() => void poll(), 1_000)

      return stopPolling
    }
  }
}
