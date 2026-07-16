import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  WorkhorseClient,
  WorkhorseEvent,
  WorkhorseRun
} from '@/app/workhorse/workhorse-contract'

import { WorkRunClientProvider, WorkRunTool } from './work-run'

afterEach(cleanup)

type EventSink = (event: WorkhorseEvent) => void

function makeClient(overrides: Partial<WorkhorseClient> = {}) {
  const sinks = new Map<string, EventSink>()

  const client: WorkhorseClient = {
    startWork: vi.fn(async () => ({ runId: 'run_x', status: 'running' }) as WorkhorseRun),
    recover: vi.fn(async () => []),
    status: vi.fn(async (runId: string) => ({ runId, status: 'running' }) as WorkhorseRun),
    stop: vi.fn(async (runId: string) => ({ runId, status: 'stopping' }) as WorkhorseRun),
    watch: vi.fn((runId: string, onEvent: EventSink) => {
      sinks.set(runId, onEvent)

      return () => sinks.delete(runId)
    }),
    ...overrides
  }

  return { client, sinks }
}

function renderChip(client: WorkhorseClient, result: unknown) {
  return render(
    <WorkRunClientProvider client={client}>
      <WorkRunTool
        args={{ task: 'migrate the database' }}
        result={result}
        toolCallId="call_1"
        toolName="work_start"
      />
    </WorkRunClientProvider>
  )
}

describe('WorkRunTool inline chip', () => {
  it('renders a live chip from the tool result and watches the run', async () => {
    const { client, sinks } = makeClient()
    renderChip(client, { run_id: 'run_abc', status: 'running' })

    await waitFor(() => expect(screen.getByTestId('work-run-chip')).toBeTruthy())
    expect(screen.getByTestId('work-run-status').textContent).toContain('running')
    await waitFor(() => expect(sinks.has('run_abc')).toBe(true))
  })

  it('stops the run from the chip and settles to cancelled', async () => {
    const { client, sinks } = makeClient({
      status: vi.fn(async (runId: string) => ({ runId, status: 'cancelled' }) as WorkhorseRun)
    })

    renderChip(client, { run_id: 'run_abc', status: 'running' })
    await waitFor(() => expect(sinks.has('run_abc')).toBe(true))

    screen.getByRole('button', { name: 'Stop' }).click()
    await waitFor(() => expect(client.stop).toHaveBeenCalledWith('run_abc'))

    await act(async () => sinks.get('run_abc')?.({ event: 'run.cancelled' }))
    await waitFor(() =>
      expect(screen.getByTestId('work-run-status').textContent).toContain('cancelled')
    )
  })

  it('shows completed output and does not watch terminal runs', async () => {
    const { client, sinks } = makeClient()
    renderChip(client, { run_id: 'run_done', status: 'completed', output: 'all migrated' })

    await waitFor(() =>
      expect(screen.getByTestId('work-run-output').textContent).toContain('all migrated')
    )
    expect(sinks.has('run_done')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('renders statically without a client (transcript replay)', async () => {
    render(
      <WorkRunTool
        args={{ task: 'old job' }}
        result={{ run_id: 'run_old', status: 'completed', output: 'done earlier' }}
        toolCallId="call_2"
        toolName="work_start"
      />
    )
    expect(screen.getByTestId('work-run-output').textContent).toContain('done earlier')
  })

  it('renders a pending chip while the tool call has no result yet', () => {
    const { client } = makeClient()
    renderChip(client, undefined)
    expect(screen.getByTestId('work-run-status').textContent).toContain('starting')
  })
})
