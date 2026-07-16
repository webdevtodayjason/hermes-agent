import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type RealtimeVoiceClientLike,
  type RealtimeVoiceFactory,
  type RealtimeVoiceStatus,
  useRealtimeConversation
} from './use-realtime-conversation'

afterEach(cleanup)

function makeFactory() {
  let onStatus: ((status: RealtimeVoiceStatus) => void) | null = null
  let onClientFatalError: ((error: unknown) => void) | null = null
  const onUserTranscripts: ((text: string, itemId: string) => void)[] = []

  const client: RealtimeVoiceClientLike = {
    start: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    interrupt: vi.fn()
  }

  const factory: RealtimeVoiceFactory = vi.fn(options => {
    onStatus = options.onStatus
    onClientFatalError = (
      options as typeof options & { onFatalError?: (error: unknown) => void }
    ).onFatalError ?? null
    onUserTranscripts.push(
      (options as typeof options & { onUserTranscript?: (text: string, itemId: string) => void })
        .onUserTranscript ?? (() => undefined)
    )

    return client
  })

  return {
    client,
    factory,
    emit: (status: RealtimeVoiceStatus) => onStatus?.(status),
    emitUser: (text: string, itemId: string, clientIndex = onUserTranscripts.length - 1) =>
      onUserTranscripts[clientIndex]?.(text, itemId),
    fail: (error: unknown) => onClientFatalError?.(error)
  }
}

describe('useRealtimeConversation', () => {
  it('delivers user finals to the latest callback without recreating the transport', async () => {
    const { client, emitUser, factory } = makeFactory()
    const first = vi.fn()
    const latest = vi.fn()

    const { rerender } = renderHook(
      ({ onUserTranscript }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onFatalError: vi.fn(),
          onUserTranscript,
          sessionId: 's1'
        }),
      { initialProps: { onUserTranscript: first } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ onUserTranscript: latest })
    act(() => emitUser('  exact final  ', 'item-7'))

    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
    expect(latest).toHaveBeenCalledWith('  exact final  ', 'item-7')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(client.end).not.toHaveBeenCalled()
  })

  it('does not let an ended lifecycle deliver to a replacement callback', async () => {
    const { client, emitUser, factory } = makeFactory()
    const first = vi.fn()
    const replacement = vi.fn()

    const { rerender } = renderHook(
      ({ onUserTranscript, sessionId }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onFatalError: vi.fn(),
          onUserTranscript,
          sessionId
        }),
      { initialProps: { onUserTranscript: first, sessionId: 's1' } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ onUserTranscript: replacement, sessionId: 's2' })
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    act(() => emitUser('stale final', 'old-item', 0))

    expect(first).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it('closes transcript delivery before explicit end begins transport teardown', async () => {
    const { client, emitUser, factory } = makeFactory()
    const onUserTranscript = vi.fn()

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onFatalError: vi.fn(),
        onUserTranscript,
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    await act(async () => result.current.end())
    act(() => emitUser('late final', 'late-item'))

    expect(onUserTranscript).not.toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('blocks an old transport during the render-to-cleanup window of a session switch', async () => {
    const { client, emitUser, factory } = makeFactory()
    const first = vi.fn()
    const replacement = vi.fn()

    const { rerender } = renderHook(
      ({ onUserTranscript, sessionId }) => {
        const conversation = useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onFatalError: vi.fn(),
          onUserTranscript,
          sessionId
        })

        if (sessionId === 's2') {
          emitUser('transition final', 'old-item', 0)
        }

        return conversation
      },
      { initialProps: { onUserTranscript: first, sessionId: 's1' } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ onUserTranscript: replacement, sessionId: 's2' })

    expect(first).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it('contains and surfaces a rejecting explicit transport end', async () => {
    const { client, factory } = makeFactory()
    const error = new Error('transport end failed')
    const onFatalError = vi.fn()
    const endMock = client.end as ReturnType<typeof vi.fn>

    endMock.mockRejectedValueOnce(error)

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    await act(async () => result.current.end())

    expect(onFatalError).toHaveBeenCalledWith(error)
  })

  it('fails closed and ends the microphone when canonical handoff rejects', async () => {
    const { client, emitUser, factory } = makeFactory()
    const error = new Error('Voice transcript could not be submitted.')
    const onFatalError = vi.fn()
    const onUserTranscript = vi.fn(async () => Promise.reject(error))

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onFatalError,
        onUserTranscript,
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => emitUser('canonical request', 'item-failed'))

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
  })

  it('fails closed when canonical handoff throws synchronously', async () => {
    const { client, emitUser, factory } = makeFactory()
    const error = new Error('synchronous handoff failure')
    const onFatalError = vi.fn()

    const onUserTranscript = vi.fn(() => {
      throw error
    })

    renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onFatalError,
        onUserTranscript,
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => emitUser('canonical request', 'item-thrown'))

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('contains a rejecting teardown while reporting the original handoff failure once', async () => {
    const { client, emitUser, factory } = makeFactory()
    const handoffError = new Error('handoff failed')
    const onFatalError = vi.fn()
    const endMock = client.end as ReturnType<typeof vi.fn>

    endMock.mockRejectedValueOnce(new Error('end failed'))

    renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onFatalError,
        onUserTranscript: async () => Promise.reject(handoffError),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => emitUser('canonical request', 'item-end-reject'))

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(handoffError))
    expect(onFatalError).toHaveBeenCalledTimes(1)
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('starts the client when enabled and maps provider statuses to composer vocabulary', async () => {
    const { client, factory, emit } = makeFactory()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError: vi.fn(), onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())

    act(() => emit('connecting'))
    expect(result.current.status).toBe('thinking')
    act(() => emit('listening'))
    expect(result.current.status).toBe('listening')
    act(() => emit('user-speaking'))
    expect(result.current.status).toBe('listening')
    act(() => emit('assistant-speaking'))
    expect(result.current.status).toBe('speaking')
    act(() => emit('reconnecting'))
    expect(result.current.status).toBe('thinking')
  })

  it('routes stopTurn to interrupt() and never to end()', async () => {
    const { client, factory } = makeFactory()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError: vi.fn(), onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())

    act(() => result.current.stopTurn())

    expect(client.interrupt).toHaveBeenCalledTimes(1)
    expect(client.end).not.toHaveBeenCalled()
  })

  it('toggles mute through setMuted and tracks the flag', async () => {
    const { client, factory } = makeFactory()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError: vi.fn(), onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())

    act(() => result.current.toggleMute())
    expect(client.setMuted).toHaveBeenCalledWith(true)
    expect(result.current.muted).toBe(true)

    act(() => result.current.toggleMute())
    expect(client.setMuted).toHaveBeenCalledWith(false)
    expect(result.current.muted).toBe(false)
  })

  it('ends the client when disabled and on unmount', async () => {
    const { client, factory } = makeFactory()

    const { rerender, unmount } = renderHook(
      ({ enabled }) =>
        useRealtimeConversation({ createClient: factory, enabled, onFatalError: vi.fn(), onUserTranscript: vi.fn(), sessionId: 's1' }),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())

    rerender({ enabled: false })
    await waitFor(() => expect(client.end).toHaveBeenCalledTimes(1))

    rerender({ enabled: true })
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(2))
    unmount()
    await waitFor(() => expect(client.end).toHaveBeenCalledTimes(2))
  })

  it('fails closed with an actionable error when no factory is available', async () => {
    const onFatalError = vi.fn()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: undefined, enabled: true, onFatalError, onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalled())
    expect(String(onFatalError.mock.calls[0][0])).toMatch(/[Rr]ealtime voice/)
    expect(result.current.status).toBe('idle')
  })

  it('fails closed when start() rejects and surfaces provider error status', async () => {
    const { client, factory } = makeFactory()

    ;(client.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('mint failed'))
    const onFatalError = vi.fn()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError, onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalled())
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
  })

  it('surfaces terminal transport failures and ends the microphone session', async () => {
    const { client, factory, fail } = makeFactory()
    const onFatalError = vi.fn()
    const error = new Error('Transcript could not be saved')

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError, onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())
    act(() => fail(error))

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
  })
})

describe('useRealtimeConversation end-exactly-once (Sol finding)', () => {
  it('ends each client exactly once across explicit end() and disable/unmount', async () => {
    const { client, factory } = makeFactory()

    const { result, rerender, unmount } = renderHook(
      ({ enabled }) =>
        useRealtimeConversation({ createClient: factory, enabled, onFatalError: vi.fn(), onUserTranscript: vi.fn(), sessionId: 's1' }),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())

    await act(async () => {
      await result.current.end()
    })
    expect(client.end).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    await waitFor(() => expect(client.end).toHaveBeenCalledTimes(1))

    rerender({ enabled: true })
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(2))
    await act(async () => {
      await result.current.end()
    })
    unmount()
    expect(client.end).toHaveBeenCalledTimes(2)
  })
})
