import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWorkhorseClient, WorkhorseClientError } from './workhorse-client'

describe('createWorkhorseClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('starts work with the stable per-profile conversation identity and maps the run', async () => {
    const request = vi.fn().mockResolvedValue({
      run_id: 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'queued',
      created_at: 123
    })

    const client = createWorkhorseClient({ profile: 'research', request })

    await expect(client.startWork('Investigate the regression')).resolves.toEqual({
      runId: 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'queued',
      createdAt: 123
    })
    expect(request).toHaveBeenCalledWith('work.start', {
      input: 'Investigate the regression',
      session_id: 'desktop-workhorse:research'
    })
  })

  it('recovers and maps all runs for the same conversation identity', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [
        {
          run_id: 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          status: 'completed',
          output: 'done',
          created_at: 100,
          updated_at: 125
        }
      ]
    })

    const client = createWorkhorseClient({ profile: ' ', request })

    await expect(client.recover()).resolves.toEqual([
      {
        runId: 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        status: 'completed',
        output: 'done',
        createdAt: 100,
        endedAt: 125
      }
    ])
    expect(request).toHaveBeenCalledWith('work.recover', {
      session_id: 'desktop-workhorse:default'
    })
  })

  it('reads status with the owning conversation identity', async () => {
    const request = vi.fn().mockResolvedValue({
      run_id: 'run_cccccccccccccccccccccccccccccccc',
      status: 'failed',
      error: 'provider unavailable',
      updated_at: 140
    })

    const client = createWorkhorseClient({ profile: 'ops', request })

    await expect(client.status('run_cccccccccccccccccccccccccccccccc')).resolves.toEqual({
      runId: 'run_cccccccccccccccccccccccccccccccc',
      status: 'failed',
      error: 'provider unavailable',
      endedAt: 140
    })
    expect(request).toHaveBeenCalledWith('work.status', {
      run_id: 'run_cccccccccccccccccccccccccccccccc',
      session_id: 'desktop-workhorse:ops'
    })
  })

  it('stops a run through the owning conversation identity', async () => {
    const request = vi.fn().mockResolvedValue({
      run_id: 'run_dddddddddddddddddddddddddddddddd',
      status: 'stopping'
    })

    const client = createWorkhorseClient({ profile: 'ops', request })

    await expect(client.stop('run_dddddddddddddddddddddddddddddddd')).resolves.toEqual({
      runId: 'run_dddddddddddddddddddddddddddddddd',
      status: 'stopping'
    })
    expect(request).toHaveBeenCalledWith('work.stop', {
      run_id: 'run_dddddddddddddddddddddddddddddddd',
      session_id: 'desktop-workhorse:ops'
    })
  })

  it('polls status and synthesizes exactly one terminal event', async () => {
    vi.useFakeTimers()

    const request = vi
      .fn()
      .mockResolvedValueOnce({
        run_id: 'run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        status: 'running'
      })
      .mockResolvedValueOnce({
        run_id: 'run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        status: 'completed',
        output: 'finished',
        updated_at: 200
      })

    const client = createWorkhorseClient({ profile: 'default', request })
    const onEvent = vi.fn()

    client.watch('run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', onEvent)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(onEvent).toHaveBeenNthCalledWith(1, {
      event: 'status.update',
      run: { runId: 'run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', status: 'running' }
    })
    expect(onEvent).toHaveBeenNthCalledWith(2, {
      event: 'run.completed',
      run: {
        runId: 'run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        status: 'completed',
        output: 'finished',
        endedAt: 200
      }
    })
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe suppresses an in-flight poll result and future polls', async () => {
    vi.useFakeTimers()
    let resolveStatus!: (value: unknown) => void

    const request = vi.fn().mockReturnValue(
      new Promise(resolve => {
        resolveStatus = resolve
      })
    )

    const client = createWorkhorseClient({ profile: 'default', request })
    const onEvent = vi.fn()

    const unsubscribe = client.watch('run_ffffffffffffffffffffffffffffffff', onEvent)
    await vi.advanceTimersByTimeAsync(1_000)
    unsubscribe()
    resolveStatus({
      run_id: 'run_ffffffffffffffffffffffffffffffff',
      status: 'completed'
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(onEvent).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      Object.assign(new Error('backend rejected request'), { code: -32602 }),
      'invalid_request',
      'The work request is invalid. Check the job and try again.'
    ],
    [Object.assign(new Error('ownership mismatch'), { code: -32004 }), 'not_found', 'This run is no longer available.'],
    [new Error('gateway not connected'), 'unavailable', 'Hermes is not connected. Reconnect and try again.']
  ])('maps RPC failures to typed user-safe errors', async (rpcError, kind, message) => {
    const client = createWorkhorseClient({
      profile: 'default',
      request: vi.fn().mockRejectedValue(rpcError)
    })

    const failure = await client.startWork('do work').catch(error => error)

    expect(failure).toBeInstanceOf(WorkhorseClientError)
    expect(failure).toMatchObject({ kind, message })
  })

  it('emits one typed error event and stops polling after a status failure', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockRejectedValue(new Error('gateway not connected'))
    const client = createWorkhorseClient({ profile: 'default', request })
    const onEvent = vi.fn()

    client.watch('run_99999999999999999999999999999999', onEvent)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({
      event: 'error',
      error: expect.objectContaining({
        kind: 'unavailable',
        message: 'Hermes is not connected. Reconnect and try again.'
      })
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
