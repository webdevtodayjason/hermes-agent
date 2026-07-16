import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkhorseClient, WorkhorseEvent, WorkhorseRun } from './workhorse-contract'
import { WorkhorsePanel } from './workhorse-panel'

afterEach(cleanup)

type EventSink = (event: WorkhorseEvent) => void

/** Contract-faithful test double: scripted runs, capturable watch sinks. */
function makeClient(overrides: Partial<WorkhorseClient> = {}) {
  const sinks = new Map<string, EventSink>()
  const unsubscribed: string[] = []

  const client: WorkhorseClient = {
    startWork: vi.fn(async (_input: string): Promise<WorkhorseRun> => ({
      runId: 'run_new',
      status: 'running',
      createdAt: 1
    })),
    recover: vi.fn(async (): Promise<WorkhorseRun[]> => []),
    status: vi.fn(async (runId: string): Promise<WorkhorseRun> => ({
      runId,
      status: 'completed',
      output: 'final answer'
    })),
    stop: vi.fn(async (runId: string): Promise<WorkhorseRun> => ({
      runId,
      status: 'stopping'
    })),
    watch: vi.fn((runId: string, onEvent: EventSink) => {
      sinks.set(runId, onEvent)

      return () => {
        unsubscribed.push(runId)
        sinks.delete(runId)
      }
    }),
    ...overrides
  }

  return { client, sinks, unsubscribed }
}

describe('WorkhorsePanel', () => {
  it('recovers existing runs on mount and watches the active ones', async () => {
    const { client, sinks } = makeClient({
      recover: vi.fn(async (): Promise<WorkhorseRun[]> => [
        { runId: 'run_active', status: 'running' },
        { runId: 'run_done', status: 'completed', output: 'shipped' }
      ])
    })

    render(<WorkhorsePanel client={client} />)

    await waitFor(() => expect(screen.getAllByTestId('run-card')).toHaveLength(2))
    expect(sinks.has('run_active')).toBe(true)
    expect(sinks.has('run_done')).toBe(false)
    expect(screen.getByTestId('run-output').textContent).toContain('shipped')
  })

  it('starts a job from the input and shows the new run', async () => {
    const { client } = makeClient()
    render(<WorkhorsePanel client={client} />)

    fireEvent.change(screen.getByTestId('job-input'), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(screen.queryByTestId('run-card')).not.toBeNull())
    expect(client.startWork).toHaveBeenCalledWith('do the thing')
    expect(screen.getByTestId('status-chip').textContent).toContain('running')
  })

  it('updates the activity line from watch events and settles on terminal', async () => {
    const { client, sinks } = makeClient()
    render(<WorkhorsePanel client={client} />)

    fireEvent.change(screen.getByTestId('job-input'), { target: { value: 'stream me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(sinks.has('run_new')).toBe(true))

    const emit = sinks.get('run_new')!
    await act(async () => emit({ event: 'tool.started', tool: 'terminal' }))
    await waitFor(() =>
      expect(screen.getByTestId('activity-line').textContent).toContain('tool.started')
    )

    await act(async () => {
      emit({ event: 'message.delta' })
      emit({ event: 'message.delta' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('activity-line').textContent).toContain('2 deltas')
    )

    await act(async () => emit({ event: 'run.completed' }))
    await waitFor(() => expect(screen.getByTestId('run-output').textContent).toContain('final answer'))
    expect(client.status).toHaveBeenCalledWith('run_new')
  })

  it('stops an active run and reflects the stopping state', async () => {
    const { client } = makeClient({
      recover: vi.fn(async (): Promise<WorkhorseRun[]> => [
        { runId: 'run_active', status: 'running' }
      ])
    })

    render(<WorkhorsePanel client={client} />)
    await waitFor(() => expect(screen.queryByTestId('run-card')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    await waitFor(() => expect(screen.getByTestId('status-chip').textContent).toContain('stopping'))
    expect(client.stop).toHaveBeenCalledWith('run_active')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('surfaces start failures without losing the panel', async () => {
    const { client } = makeClient({
      startWork: vi.fn(async () => {
        throw new Error('gateway unreachable')
      })
    })

    render(<WorkhorsePanel client={client} />)

    fireEvent.change(screen.getByTestId('job-input'), { target: { value: 'doomed job' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() =>
      expect(screen.getByTestId('panel-error').textContent).toContain('gateway unreachable')
    )
    expect(screen.queryByTestId('job-input')).not.toBeNull()
  })

  it('tears down watches on unmount', async () => {
    const { client, sinks, unsubscribed } = makeClient({
      recover: vi.fn(async (): Promise<WorkhorseRun[]> => [
        { runId: 'run_active', status: 'running' }
      ])
    })

    const { unmount } = render(<WorkhorsePanel client={client} />)
    await waitFor(() => expect(sinks.has('run_active')).toBe(true))

    unmount()

    expect(unsubscribed).toContain('run_active')
  })
})

describe('WorkhorsePanel watch teardown signals', () => {
  it('settles the card when the client emits a bare error event', async () => {
    const { client, sinks, unsubscribed } = makeClient({
      recover: vi.fn(async (): Promise<WorkhorseRun[]> => [
        { runId: 'run_active', status: 'running' }
      ]),
      status: vi.fn(async (runId: string): Promise<WorkhorseRun> => ({
        runId,
        status: 'failed',
        error: 'gateway went away'
      }))
    })

    render(<WorkhorsePanel client={client} />)
    await waitFor(() => expect(sinks.has('run_active')).toBe(true))

    await act(async () => sinks.get('run_active')!({ event: 'error', message: 'poll failed' }))

    await waitFor(() =>
      expect(screen.getByTestId('run-error').textContent).toContain('gateway went away')
    )
    expect(unsubscribed).toContain('run_active')
  })
})

describe('WorkhorsePanel lifecycle races (Task 2 cross-review findings)', () => {
  it('does not let a late recover() erase a run submitted while it was in flight', async () => {
    let resolveRecover!: (runs: WorkhorseRun[]) => void

    const deferred = new Promise<WorkhorseRun[]>(resolve => {
      resolveRecover = resolve
    })

    const { client } = makeClient({
      recover: vi.fn(() => deferred)
    })

    render(<WorkhorsePanel client={client} />)

    fireEvent.change(screen.getByTestId('job-input'), { target: { value: 'racing job' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(screen.queryByTestId('run-card')).not.toBeNull())

    await act(async () => {
      resolveRecover([{ runId: 'run_old', status: 'completed', output: 'old news' }])
    })

    await waitFor(() => expect(screen.getAllByTestId('run-card')).toHaveLength(2))
    const cardText = screen.getAllByTestId('run-card').map(card => card.textContent).join(' ')
    expect(cardText).toContain('run_new')
    expect(cardText).toContain('run_old')
  })

  it('discards a recover() that resolves after unmount instead of leaking a watcher', async () => {
    let resolveRecover!: (runs: WorkhorseRun[]) => void

    const deferred = new Promise<WorkhorseRun[]>(resolve => {
      resolveRecover = resolve
    })

    const { client } = makeClient({
      recover: vi.fn(() => deferred)
    })

    const { unmount } = render(<WorkhorsePanel client={client} />)
    unmount()

    await act(async () => {
      resolveRecover([{ runId: 'run_zombie', status: 'running' }])
    })

    expect(client.watch).not.toHaveBeenCalled()
  })

  it('surfaces the watch error and recovers via Retry when status() also fails', async () => {
    const goodRecover = vi.fn(async (): Promise<WorkhorseRun[]> => [
      { runId: 'run_active', status: 'running' }
    ])

    const { client, sinks } = makeClient({
      recover: goodRecover,
      status: vi.fn(async () => {
        throw new Error('gateway down')
      })
    })

    render(<WorkhorsePanel client={client} />)
    await waitFor(() => expect(sinks.has('run_active')).toBe(true))

    await act(async () => {
      sinks.get('run_active')!({
        event: 'error',
        error: Object.assign(new Error('Hermes is not connected. Reconnect and try again.'), {
          kind: 'unavailable'
        })
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('panel-error').textContent).toContain(
        'Hermes is not connected. Reconnect and try again.'
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(goodRecover).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('panel-error')).toBeNull())
  })
})
