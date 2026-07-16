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

  const client: RealtimeVoiceClientLike = {
    start: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    interrupt: vi.fn()
  }

  const factory: RealtimeVoiceFactory = vi.fn(options => {
    onStatus = options.onStatus

    return client
  })

  return { client, factory, emit: (status: RealtimeVoiceStatus) => onStatus?.(status) }
}

describe('useRealtimeConversation', () => {
  it('starts the client when enabled and maps provider statuses to composer vocabulary', async () => {
    const { client, factory, emit } = makeFactory()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError: vi.fn(), sessionId: 's1' })
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
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())

    act(() => result.current.stopTurn())

    expect(client.interrupt).toHaveBeenCalledTimes(1)
    expect(client.end).not.toHaveBeenCalled()
  })

  it('toggles mute through setMuted and tracks the flag', async () => {
    const { client, factory } = makeFactory()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError: vi.fn(), sessionId: 's1' })
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
        useRealtimeConversation({ createClient: factory, enabled, onFatalError: vi.fn(), sessionId: 's1' }),
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
      useRealtimeConversation({ createClient: undefined, enabled: true, onFatalError, sessionId: 's1' })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalled())
    expect(String(onFatalError.mock.calls[0][0])).toMatch(/[Rr]ealtime voice/)
    expect(result.current.status).toBe('idle')
  })

  it('fails closed when start() rejects and surfaces provider error status', async () => {
    const { client, factory, emit } = makeFactory()

    ;(client.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('mint failed'))
    const onFatalError = vi.fn()

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError, sessionId: 's1' })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalled())
    expect(result.current.status).toBe('idle')

    act(() => emit('error'))
    expect(result.current.status).toBe('idle')
  })
})

describe('useRealtimeConversation end-exactly-once (Sol finding)', () => {
  it('ends each client exactly once across explicit end() and disable/unmount', async () => {
    const { client, factory } = makeFactory()

    const { result, rerender, unmount } = renderHook(
      ({ enabled }) =>
        useRealtimeConversation({ createClient: factory, enabled, onFatalError: vi.fn(), sessionId: 's1' }),
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
