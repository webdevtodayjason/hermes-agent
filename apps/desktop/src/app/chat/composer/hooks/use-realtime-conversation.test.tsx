import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { startTransition, Suspense, useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type RealtimeVoiceClientLike,
  type RealtimeVoiceFactory,
  type RealtimeVoiceStatus,
  useRealtimeConversation
} from './use-realtime-conversation'

afterEach(cleanup)

function makeFactory() {
  const onStatuses: ((status: RealtimeVoiceStatus) => void)[] = []
  const onClientFatalErrors: ((error: unknown) => void)[] = []
  const onUserTranscripts: ((text: string, itemId: string) => void)[] = []

  const client: RealtimeVoiceClientLike = {
    start: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    interrupt: vi.fn()
  }

  const factory: RealtimeVoiceFactory = vi.fn(options => {
    onStatuses.push(options.onStatus)
    onClientFatalErrors.push((
      options as typeof options & { onFatalError?: (error: unknown) => void }
    ).onFatalError ?? (() => undefined))
    onUserTranscripts.push(
      (options as typeof options & { onUserTranscript?: (text: string, itemId: string) => void })
        .onUserTranscript ?? (() => undefined)
    )

    return client
  })

  return {
    client,
    factory,
    emit: (status: RealtimeVoiceStatus, clientIndex = onStatuses.length - 1) =>
      onStatuses[clientIndex]?.(status),
    emitUser: (text: string, itemId: string, clientIndex = onUserTranscripts.length - 1) =>
      onUserTranscripts[clientIndex]?.(text, itemId),
    fail: (error: unknown, clientIndex = onClientFatalErrors.length - 1) =>
      onClientFatalErrors[clientIndex]?.(error)
  }
}

describe('useRealtimeConversation', () => {
  it('keeps committed callbacks active when a replacement render suspends', async () => {
    const { client, emit, emitUser, factory } = makeFactory()
    const firstBargeIn = vi.fn()
    const firstTranscript = vi.fn()
    const replacementBargeIn = vi.fn()
    const replacementTranscript = vi.fn()
    const suspended = new Promise<void>(() => undefined)

    function Harness({
      onBargeIn,
      onUserTranscript,
      shouldSuspend
    }: {
      onBargeIn: () => void
      onUserTranscript: (text: string, itemId?: string) => void
      shouldSuspend: boolean
    }) {
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError: vi.fn(),
        onUserTranscript,
        sessionId: 's1'
      })

      if (shouldSuspend) {
        throw suspended
      }

      return null
    }

    const view = render(
      <Suspense fallback={null}>
        <Harness
          onBargeIn={firstBargeIn}
          onUserTranscript={firstTranscript}
          shouldSuspend={false}
        />
      </Suspense>
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback={null}>
            <Harness
              onBargeIn={replacementBargeIn}
              onUserTranscript={replacementTranscript}
              shouldSuspend={true}
            />
          </Suspense>
        )
      })
    })
    act(() => {
      emitUser('still committed', 'item-a')
      emit('user-speaking')
    })

    expect(firstTranscript).toHaveBeenCalledWith('still committed', 'item-a')
    expect(replacementTranscript).not.toHaveBeenCalled()
    expect(firstBargeIn).toHaveBeenCalledTimes(1)
    expect(replacementBargeIn).not.toHaveBeenCalled()
    expect(client.end).not.toHaveBeenCalled()
  })

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

  it('blocks an old transport during the commit-to-cleanup window of a session switch', async () => {
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

        useLayoutEffect(() => {
          if (sessionId === 's2') {
            emitUser('transition final', 'old-item', 0)
          }
        }, [sessionId])

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

  it('contains and surfaces a synchronous explicit transport end failure', async () => {
    const { client, factory } = makeFactory()
    const error = new Error('transport end threw')

    const onFatalError = vi.fn()

    ;(client.end as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw error
    })

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

  it('calls the latest playback stop once on automatic user speech without recreating the transport', async () => {
    const { client, emit, factory } = makeFactory()
    const first = vi.fn()
    const latest = vi.fn()

    const { rerender } = renderHook(
      ({ onBargeIn }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn,
          onFatalError: vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId: 's1'
        }),
      { initialProps: { onBargeIn: first } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ onBargeIn: latest })
    act(() => emit('user-speaking'))

    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(client.interrupt).not.toHaveBeenCalled()
    expect(client.end).not.toHaveBeenCalled()
  })

  it('suppresses automatic barge-in from an old transport during a session transition', async () => {
    const { client, emit, factory } = makeFactory()
    const first = vi.fn()
    const replacement = vi.fn()
    let transitionEmitted = false
    let callsDuringRender = 0

    const { rerender } = renderHook(
      ({ onBargeIn, sessionId }) => {
        const conversation = useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn,
          onFatalError: vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId
        })

        useLayoutEffect(() => {
          if (sessionId === 's2' && !transitionEmitted) {
            transitionEmitted = true
            emit('user-speaking', 0)
            callsDuringRender = first.mock.calls.length
          }
        }, [sessionId])

        return conversation
      },
      { initialProps: { onBargeIn: first, sessionId: 's1' } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ onBargeIn: replacement, sessionId: 's2' })

    expect(callsDuringRender).toBe(0)
    expect(first).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('suppresses old transport callbacks during same-session Spoke deactivation', async () => {
    const { client, emit, factory } = makeFactory()
    const onBargeIn = vi.fn()
    let transitionEmitted = false
    let callsDuringRender = 0

    const { rerender } = renderHook(
      ({ enabled }) => {
        const conversation = useRealtimeConversation({
          createClient: factory,
          enabled,
          onBargeIn,
          onFatalError: vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId: 's1'
        })

        useLayoutEffect(() => {
          if (!enabled && !transitionEmitted) {
            transitionEmitted = true
            emit('user-speaking', 0)
            callsDuringRender = onBargeIn.mock.calls.length
          }
        }, [enabled])

        return conversation
      },
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ enabled: false })

    expect(callsDuringRender).toBe(0)
    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(client.interrupt).not.toHaveBeenCalled()
  })

  it('blocks old status and fatal callbacks during a replacement-session render', async () => {
    const { client, emit, factory, fail } = makeFactory()
    const replacementFatal = vi.fn()
    const seenStatuses: string[] = []
    let transitionEmitted = false

    const { rerender } = renderHook(
      ({ sessionId }) => {
        const conversation = useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn: vi.fn(),
          onFatalError: sessionId === 's2' ? replacementFatal : vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId
        })

        if (sessionId === 's2' && !transitionEmitted) {
          transitionEmitted = true
          emit('assistant-speaking', 0)
          fail(new Error('stale fatal'), 0)
        }

        if (sessionId === 's2') {
          seenStatuses.push(conversation.status)
        }

        return conversation
      },
      { initialProps: { sessionId: 's1' } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ sessionId: 's2' })

    expect(replacementFatal).not.toHaveBeenCalled()
    expect(seenStatuses).not.toContain('speaking')
  })

  it('stops old-session narration during replacement cleanup', async () => {
    const { client, factory } = makeFactory()
    const firstStop = vi.fn()
    const replacementStop = vi.fn()

    const { rerender } = renderHook(
      ({ onBargeIn, sessionId }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn,
          onFatalError: vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId
        }),
      { initialProps: { onBargeIn: firstStop, sessionId: 's1' } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    rerender({ onBargeIn: replacementStop, sessionId: 's2' })

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(replacementStop).not.toHaveBeenCalled()
  })

  it('does not report delayed old-cleanup rejection to the replacement lifecycle', async () => {
    let rejectOldEnd: ((error: Error) => void) | null = null

    const oldClient: RealtimeVoiceClientLike = {
      start: vi.fn(async () => undefined),
      end: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectOldEnd = reject
      })),
      interrupt: vi.fn(),
      setMuted: vi.fn()
    }

    const replacementClient: RealtimeVoiceClientLike = {
      start: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      interrupt: vi.fn(),
      setMuted: vi.fn()
    }

    const clients = [oldClient, replacementClient]
    let clientIndex = 0
    const factory: RealtimeVoiceFactory = vi.fn(() => clients[clientIndex++] ?? replacementClient)
    const replacementFatal = vi.fn()

    const { rerender } = renderHook(
      ({ sessionId }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn: vi.fn(),
          onFatalError: sessionId === 's2' ? replacementFatal : vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId
        }),
      { initialProps: { sessionId: 's1' } }
    )

    await waitFor(() => expect(oldClient.start).toHaveBeenCalledTimes(1))
    rerender({ sessionId: 's2' })
    await waitFor(() => expect(replacementClient.start).toHaveBeenCalledTimes(1))
    act(() => rejectOldEnd?.(new Error('old cleanup failed')))

    await Promise.resolve()
    expect(replacementFatal).not.toHaveBeenCalled()
  })

  it('does not report delayed explicit-end rejection to a replacement lifecycle', async () => {
    let rejectOldEnd: ((error: Error) => void) | null = null

    const oldClient: RealtimeVoiceClientLike = {
      start: vi.fn(async () => undefined),
      end: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectOldEnd = reject
      })),
      interrupt: vi.fn(),
      setMuted: vi.fn()
    }

    const replacementClient: RealtimeVoiceClientLike = {
      start: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      interrupt: vi.fn(),
      setMuted: vi.fn()
    }

    const clients = [oldClient, replacementClient]
    let clientIndex = 0
    const factory: RealtimeVoiceFactory = vi.fn(() => clients[clientIndex++] ?? replacementClient)
    const replacementFatal = vi.fn()

    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn: vi.fn(),
          onFatalError: sessionId === 's2' ? replacementFatal : vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId
        }),
      { initialProps: { sessionId: 's1' } }
    )

    await waitFor(() => expect(oldClient.start).toHaveBeenCalledTimes(1))
    let ending!: Promise<void>

    act(() => {
      ending = result.current.end()
    })
    rerender({ sessionId: 's2' })
    await waitFor(() => expect(replacementClient.start).toHaveBeenCalledTimes(1))
    act(() => rejectOldEnd?.(new Error('late explicit end failure')))
    await ending

    expect(replacementFatal).not.toHaveBeenCalled()
  })

  it('treats a same-session factory replacement as a new lifecycle', async () => {
    let rejectOldEnd: ((error: Error) => void) | null = null

    const oldClient: RealtimeVoiceClientLike = {
      end: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectOldEnd = reject
      })),
      interrupt: vi.fn(),
      setMuted: vi.fn(),
      start: vi.fn(async () => undefined)
    }

    const replacementClient: RealtimeVoiceClientLike = {
      end: vi.fn(async () => undefined),
      interrupt: vi.fn(),
      setMuted: vi.fn(),
      start: vi.fn(async () => undefined)
    }

    const oldFactory: RealtimeVoiceFactory = vi.fn(() => oldClient)
    const replacementFactory: RealtimeVoiceFactory = vi.fn(() => replacementClient)
    const replacementFatal = vi.fn()

    const { result, rerender } = renderHook(
      ({ factory }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled: true,
          onBargeIn: vi.fn(),
          onFatalError: replacementFatal,
          onUserTranscript: vi.fn(),
          sessionId: 's1'
        }),
      { initialProps: { factory: oldFactory } }
    )

    await waitFor(() => expect(oldClient.start).toHaveBeenCalledTimes(1))
    rerender({ factory: replacementFactory })
    await waitFor(() => expect(replacementClient.start).toHaveBeenCalledTimes(1))

    expect(result.current.isNarrationBlocked()).toBe(false)
    await act(async () => rejectOldEnd?.(new Error('old factory cleanup failed')))
    expect(replacementFatal).not.toHaveBeenCalled()
  })

  it('does not reuse lifecycle ownership after a same-session stop and restart', async () => {
    let rejectOldEnd: ((error: Error) => void) | null = null

    const oldClient: RealtimeVoiceClientLike = {
      start: vi.fn(async () => undefined),
      end: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectOldEnd = reject
      })),
      interrupt: vi.fn(),
      setMuted: vi.fn()
    }

    const replacementClient: RealtimeVoiceClientLike = {
      start: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      interrupt: vi.fn(),
      setMuted: vi.fn()
    }

    const clients = [oldClient, replacementClient]
    let clientIndex = 0
    const factory: RealtimeVoiceFactory = vi.fn(() => clients[clientIndex++] ?? replacementClient)
    const fatal = vi.fn()

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled,
          onBargeIn: vi.fn(),
          onFatalError: fatal,
          onUserTranscript: vi.fn(),
          sessionId: 's1'
        }),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(oldClient.start).toHaveBeenCalledTimes(1))
    let ending!: Promise<void>

    act(() => {
      ending = result.current.end()
    })
    rerender({ enabled: false })
    rerender({ enabled: true })
    await waitFor(() => expect(replacementClient.start).toHaveBeenCalledTimes(1))
    act(() => rejectOldEnd?.(new Error('late same-session failure')))
    await ending

    expect(fatal).not.toHaveBeenCalled()
  })

  it('publishes synchronous user-speaking ownership before stopping playback', async () => {
    const { client, emit, factory } = makeFactory()
    let speakingDuringStop = false
    let resultRef: ReturnType<typeof useRealtimeConversation> | null = null

    const { result } = renderHook(() => {
      const conversation = useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn: () => {
          speakingDuringStop = resultRef?.isUserSpeaking() ?? false
        },
        onFatalError: vi.fn(),
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })

      resultRef = conversation

      return conversation
    })

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => emit('user-speaking'))

    expect(result.current.userSpeaking).toBe(true)
    expect(speakingDuringStop).toBe(true)
  })

  it('does not let a pending manual clear remove a same-generation close block', async () => {
    const { client, factory } = makeFactory()
    const onBargeIn = vi.fn()

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError: vi.fn(),
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => {
      result.current.stopTurn()
      void result.current.end()
    })
    await Promise.resolve()

    expect(result.current.isNarrationBlocked()).toBe(true)
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(onBargeIn).toHaveBeenCalledTimes(1)
  })

  it('contains a synchronous interrupt failure and promotes it to fatal close', async () => {
    const { client, factory } = makeFactory()
    const error = new Error('interrupt failed')

    const onFatalError = vi.fn()

    ;(client.interrupt as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw error
    })
    ;(client.end as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('end also failed')
    })

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn: vi.fn(),
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    expect(() => act(() => result.current.stopTurn())).not.toThrow()

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(result.current.isNarrationBlocked()).toBe(true)
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('deduplicates VAD playback stop followed synchronously by fatal close', async () => {
    const { client, emit, factory, fail } = makeFactory()
    const onBargeIn = vi.fn()

    renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError: vi.fn(),
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => {
      emit('user-speaking')
      fail(new Error('fatal after VAD'))
    })

    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('publishes a transient narration block before manual playback stop', async () => {
    const { client, factory } = makeFactory()
    let blockedDuringStop = false
    let resultRef: ReturnType<typeof useRealtimeConversation> | null = null

    const { result } = renderHook(() => {
      const conversation = useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn: () => {
          blockedDuringStop = resultRef?.isNarrationBlocked?.() ?? false
        },
        onFatalError: vi.fn(),
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })

      resultRef = conversation

      return conversation
    })

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => result.current.stopTurn())

    expect(blockedDuringStop).toBe(true)
    await Promise.resolve()
    expect(result.current.isNarrationBlocked?.() ?? false).toBe(false)
  })

  it('publishes a persistent narration block before close playback teardown', async () => {
    const { client, factory } = makeFactory()
    let blockedDuringStop = false
    let resultRef: ReturnType<typeof useRealtimeConversation> | null = null

    const { result } = renderHook(() => {
      const conversation = useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn: () => {
          blockedDuringStop = resultRef?.isNarrationBlocked?.() ?? false
        },
        onFatalError: vi.fn(),
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })

      resultRef = conversation

      return conversation
    })

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    await act(async () => result.current.end())

    expect(blockedDuringStop).toBe(true)
    expect(result.current.isNarrationBlocked?.() ?? false).toBe(true)
  })

  it('stops canonical playback and interrupts only on manual stopTurn', async () => {
    const { client, factory } = makeFactory()
    const onBargeIn = vi.fn()

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError: vi.fn(),
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => result.current.stopTurn())

    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(client.interrupt).toHaveBeenCalledTimes(1)
    expect(client.end).not.toHaveBeenCalled()
  })

  it('stops canonical playback when ending and releases the transport once', async () => {
    const { client, factory } = makeFactory()
    const onBargeIn = vi.fn()

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled,
          onBargeIn,
          onFatalError: vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId: 's1'
        }),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    await act(async () => result.current.end())
    rerender({ enabled: false })

    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('stops canonical playback on fatal voice failure without leaking stop errors', async () => {
    const { client, factory, fail } = makeFactory()
    const transportError = new Error('voice failed')
    const stopError = new Error('stop failed')
    const onFatalError = vi.fn()
    let blockedDuringStop = false
    let resultRef: ReturnType<typeof useRealtimeConversation> | null = null

    const onBargeIn = vi.fn(() => {
      blockedDuringStop = resultRef?.isNarrationBlocked() ?? false
      throw stopError
    })

    renderHook(() => {
      const conversation = useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })

      resultRef = conversation

      return conversation
    })

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => fail(transportError))

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(transportError))
    expect(blockedDuringStop).toBe(true)
    expect(onBargeIn).toHaveBeenCalledTimes(1)
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
    expect(result.current.userSpeaking).toBe(true)
    act(() => emit('assistant-speaking'))
    expect(result.current.status).toBe('speaking')
    expect(result.current.userSpeaking).toBe(false)
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

  it('clears stale speaking state when the committed lifecycle changes', async () => {
    const { client, emit, factory } = makeFactory()

    const { result, rerender } = renderHook(
      ({ enabled, sessionId }) =>
        useRealtimeConversation({
          createClient: factory,
          enabled,
          onFatalError: vi.fn(),
          onUserTranscript: vi.fn(),
          sessionId
        }),
      { initialProps: { enabled: true, sessionId: 's1' } }
    )

    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    act(() => emit('assistant-speaking'))
    expect(result.current.status).toBe('speaking')

    rerender({ enabled: true, sessionId: 's2' })
    expect(result.current.status).toBe('idle')

    act(() => emit('user-speaking', 1))
    expect(result.current.userSpeaking).toBe(true)
    expect(result.current.isUserSpeaking()).toBe(true)

    rerender({ enabled: false, sessionId: 's2' })
    expect(result.current.status).toBe('idle')
    expect(result.current.userSpeaking).toBe(false)
    expect(result.current.isUserSpeaking()).toBe(false)
  })

  it('fails closed with an actionable error and stops playback when no factory is available', async () => {
    const onFatalError = vi.fn()
    let blockedDuringStop = false
    let resultRef: ReturnType<typeof useRealtimeConversation> | null = null

    const onBargeIn = vi.fn(() => {
      blockedDuringStop = resultRef?.isNarrationBlocked() ?? false
    })

    const { result } = renderHook(() => {
      const conversation = useRealtimeConversation({
        createClient: undefined,
        enabled: true,
        onBargeIn,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })

      resultRef = conversation

      return conversation
    })

    await waitFor(() => expect(onFatalError).toHaveBeenCalled())
    expect(String(onFatalError.mock.calls[0][0])).toMatch(/[Rr]ealtime voice/)
    expect(blockedDuringStop).toBe(true)
    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(result.current.isNarrationBlocked()).toBe(true)
    expect(result.current.status).toBe('idle')
  })

  it('fails closed and stops playback when no session is selected', async () => {
    const { factory } = makeFactory()
    const onFatalError = vi.fn()
    let blockedDuringStop = false
    let resultRef: ReturnType<typeof useRealtimeConversation> | null = null

    const onBargeIn = vi.fn(() => {
      blockedDuringStop = resultRef?.isNarrationBlocked() ?? false
    })

    const { result } = renderHook(() => {
      const conversation = useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: null
      })

      resultRef = conversation

      return conversation
    })

    await waitFor(() => expect(onFatalError).toHaveBeenCalled())
    expect(String(onFatalError.mock.calls[0][0])).toMatch(/conversation/)
    expect(factory).not.toHaveBeenCalled()
    expect(blockedDuringStop).toBe(true)
    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(result.current.isNarrationBlocked()).toBe(true)
  })

  it('fails closed when the client factory throws synchronously', async () => {
    const error = new Error('factory failed')
    const onFatalError = vi.fn()
    const onBargeIn = vi.fn()

    const factory = vi.fn(() => {
      throw error
    })

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(result.current.isNarrationBlocked()).toBe(true)
  })

  it('owns and closes a client returned after a synchronous factory fatal callback', async () => {
    const error = new Error('fatal during factory')
    const onFatalError = vi.fn()
    const onBargeIn = vi.fn()
    const { client } = makeFactory()

    const factory: RealtimeVoiceFactory = vi.fn(options => {
      ;(options as typeof options & { onFatalError: (error: unknown) => void }).onFatalError(error)

      return client
    })

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(client.start).not.toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(result.current.isNarrationBlocked()).toBe(true)
  })

  it('fails closed when start throws synchronously', async () => {
    const { client, factory } = makeFactory()
    const error = new Error('start failed synchronously')
    const onFatalError = vi.fn()

    const onBargeIn = vi.fn()

    ;(client.start as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw error
    })

    const { result } = renderHook(() =>
      useRealtimeConversation({
        createClient: factory,
        enabled: true,
        onBargeIn,
        onFatalError,
        onUserTranscript: vi.fn(),
        sessionId: 's1'
      })
    )

    await waitFor(() => expect(onFatalError).toHaveBeenCalledWith(error))
    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(result.current.isNarrationBlocked()).toBe(true)
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

  it('surfaces terminal transport failures even when end throws synchronously', async () => {
    const { client, factory, fail } = makeFactory()
    const onFatalError = vi.fn()

    const error = new Error('Transcript could not be saved')

    ;(client.end as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('end failed synchronously')
    })

    const { result } = renderHook(() =>
      useRealtimeConversation({ createClient: factory, enabled: true, onFatalError, onUserTranscript: vi.fn(), sessionId: 's1' })
    )

    await waitFor(() => expect(client.start).toHaveBeenCalled())
    expect(() => act(() => fail(error))).not.toThrow()

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
