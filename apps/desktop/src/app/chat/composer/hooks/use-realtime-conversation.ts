import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Composer-side adapter for the Realtime STT/VAD transport.
 *
 * Structural mirror of the transport surface published by hermes-sol at
 * `lib/realtime-voice-client.ts` (COLLAB-LOG 2026-07-16T05:12Z). The
 * transport module itself is not touched here; the concrete factory is
 * injected by the composition layer, so this hook compiles and tests
 * against the contract alone.
 *
 * Product rules enforced here (slice 1R, Step B):
 * - stopTurn is BARGE-IN: stop renderer narration and interrupt transport output
 *   only. It must never end the session, close the mic, or touch durable work.
 * - No automatic fallback to the serialized STT→submit→TTS loop. When
 *   Realtime is unavailable or fails, fail closed with an actionable
 *   error so the North Star failure is visible, not masked.
 */

/** The composer's conversation-state vocabulary (previously owned by the
 *  retired serialized loop). */
export type ConversationStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

export type RealtimeVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'assistant-speaking'
  | 'reconnecting'
  | 'error'

export interface RealtimeVoiceClientLike {
  start(): Promise<void>
  end(): Promise<void>
  setMuted(muted: boolean): void
  interrupt(): void
}

export interface RealtimeVoiceFactoryOptions {
  sessionId: string
  onFatalError: (error: unknown) => void
  onStatus: (status: RealtimeVoiceStatus) => void
  onUserTranscriptDelta?: (text: string, itemId: string) => void
  onUserTranscript: (text: string, itemId: string) => void
}

export type RealtimeVoiceFactory = (options: RealtimeVoiceFactoryOptions) => RealtimeVoiceClientLike

interface UseRealtimeConversationArgs {
  createClient: RealtimeVoiceFactory | undefined
  enabled: boolean
  /** Stops renderer-owned narration only; durable canonical work continues. */
  onBargeIn?: () => void
  onFatalError: (error: unknown) => void
  onUserTranscript: (text: string, itemId: string) => Promise<unknown> | void
  sessionId: string | null | undefined
}

const STATUS_MAP: Record<RealtimeVoiceStatus, ConversationStatus> = {
  idle: 'idle',
  connecting: 'thinking',
  listening: 'listening',
  'user-speaking': 'listening',
  'assistant-speaking': 'speaking',
  reconnecting: 'thinking',
  error: 'idle'
}

const MAX_RETIRED_CAPTION_ITEMS = 64

function retireCaptionItem(retired: Set<string>, itemId: string | null) {
  if (!itemId) {
    return
  }

  retired.add(itemId)

  while (retired.size > MAX_RETIRED_CAPTION_ITEMS) {
    const oldest = retired.values().next().value

    if (typeof oldest !== 'string') {
      break
    }

    retired.delete(oldest)
  }
}

export function useRealtimeConversation({
  createClient,
  enabled,
  onBargeIn,
  onFatalError,
  onUserTranscript,
  sessionId
}: UseRealtimeConversationArgs) {
  const [status, setStatus] = useState<ConversationStatus>('idle')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [muted, setMuted] = useState(false)
  const [userSpeaking, setUserSpeaking] = useState(false)
  const liveTranscriptItemRef = useRef<string | null>(null)
  const retiredCaptionItemsRef = useRef(new Set<string>())
  const userSpeakingRef = useRef(false)
  const narrationBlockRef = useRef<{ generation: number } | null>(null)
  const playbackStopRef = useRef<{ generation: number } | null>(null)
  const clientRef = useRef<RealtimeVoiceClientLike | null>(null)
  const mutedRef = useRef(false)

  const clearLiveTranscript = useCallback(() => {
    setLiveTranscript('')
    liveTranscriptItemRef.current = null
    retiredCaptionItemsRef.current.clear()
  }, [])

  // Latest-ref: a non-memoized error callback must not tear down and
  // recreate the live audio session on every parent render.
  const onFatalErrorRef = useRef(onFatalError)

  const lifecycleRef = useRef({
    createClient,
    enabled,
    generation: 0,
    handler: onBargeIn,
    sessionId
  })

  const onUserTranscriptRef = useRef({ handler: onUserTranscript, sessionId })

  // Publish lifecycle ownership and callback freshness only after React commits.
  // A suspended/abandoned render must not poison the still-committed transport.
  // Layout effects run before passive cleanup/recreation, preserving the fence
  // against old callbacks in the commit-to-cleanup window.
  useLayoutEffect(() => {
    const current = lifecycleRef.current

    const lifecycleChanged =
      current.createClient !== createClient ||
      current.enabled !== enabled ||
      current.sessionId !== sessionId

    lifecycleRef.current = {
      createClient,
      enabled,
      generation: current.generation + (lifecycleChanged ? 1 : 0),
      handler: onBargeIn,
      sessionId
    }
    onFatalErrorRef.current = onFatalError
    onUserTranscriptRef.current = { handler: onUserTranscript, sessionId }

    if (lifecycleChanged) {
      clientRef.current = null
      mutedRef.current = false
      userSpeakingRef.current = false
      setMuted(false)
      setStatus('idle')
      clearLiveTranscript()
      setUserSpeaking(false)
    }
  }, [clearLiveTranscript, createClient, enabled, onBargeIn, onFatalError, onUserTranscript, sessionId])

  // Exactly-once end per session: explicit end() and the effect cleanup
  // both reach the same client (Sol's adapter-lifecycle finding). Each
  // session's effect creates one once-guarded closure shared by both paths.
  const endActiveRef = useRef<{
    close: (playbackAlreadyStopped?: boolean) => Promise<void>
    generation: number
  } | null>(null)

  const updateUserSpeaking = useCallback((speaking: boolean) => {
    userSpeakingRef.current = speaking
    setUserSpeaking(speaking)
  }, [])

  const isUserSpeaking = useCallback(() => userSpeakingRef.current, [])

  const isNarrationBlocked = useCallback(
    () => narrationBlockRef.current?.generation === lifecycleRef.current.generation,
    []
  )

  const blockNarration = useCallback((generation: number) => {
    const block = { generation }
    narrationBlockRef.current = block

    return block
  }, [])

  const invokePlaybackStop = useCallback((handler: (() => void) | undefined) => {
    try {
      handler?.()
    } catch {
      // Playback cleanup is best-effort and must never break transport lifecycle.
    }
  }, [])

  const stopPlayback = useCallback((expectedGeneration?: number) => {
    const current = lifecycleRef.current

    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) {
      return
    }

    invokePlaybackStop(current.handler)
  }, [invokePlaybackStop])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const activeGeneration = lifecycleRef.current.generation

    const failSetup = (error: Error) => {
      const closeBlock = blockNarration(activeGeneration)
      playbackStopRef.current = closeBlock
      stopPlayback(activeGeneration)
      setStatus('idle')
      updateUserSpeaking(false)
      onFatalErrorRef.current(error)
    }

    if (!createClient) {
      failSetup(
        new Error(
          'Realtime voice is not configured for this build. Connect the voice gateway (voice.session.create) and try again.'
        )
      )

      return
    }

    if (!sessionId) {
      failSetup(new Error('Start or select a conversation before starting voice.'))

      return
    }

    let cancelled = false
    let ended = false
    let playbackClosed = false
    let client: RealtimeVoiceClientLike | null = null
    let factorySettled = false
    let deferredFailure: unknown
    let hasDeferredFailure = false
    let vadPlaybackStop: { generation: number } | null = null
    const capturedPlaybackStop = lifecycleRef.current.handler
    const ownsLifecycle = () => lifecycleRef.current.generation === activeGeneration

    const stopPlaybackForClose = (playbackAlreadyStopped = false) => {
      if (playbackClosed) {
        return
      }

      const alreadyStopped =
        playbackAlreadyStopped || playbackStopRef.current?.generation === activeGeneration

      const closeBlock = blockNarration(activeGeneration)
      playbackStopRef.current = closeBlock
      playbackClosed = true

      if (alreadyStopped) {
        return
      }

      if (ownsLifecycle()) {
        stopPlayback(activeGeneration)
      } else {
        invokePlaybackStop(capturedPlaybackStop)
      }
    }

    const endOnce = (): Promise<void> => {
      if (ended) {
        return Promise.resolve()
      }

      ended = true

      try {
        return Promise.resolve(client?.end())
      } catch (error) {
        return Promise.reject(error)
      }
    }

    const closeOnce = (playbackAlreadyStopped = false): Promise<void> => {
      cancelled = true
      stopPlaybackForClose(playbackAlreadyStopped)

      return endOnce()
    }

    const failOnce = (error: unknown) => {
      if (!factorySettled) {
        if (!hasDeferredFailure) {
          deferredFailure = error
          hasDeferredFailure = true
        }

        return
      }

      if (cancelled || !ownsLifecycle()) {
        return
      }

      cancelled = true
      setStatus('idle')
      clearLiveTranscript()
      updateUserSpeaking(false)
      clientRef.current = null
      stopPlaybackForClose()
      void endOnce().catch(() => undefined)
      onFatalErrorRef.current(error)
    }

    try {
      client = createClient({
        onFatalError: failOnce,
        onStatus: providerStatus => {
          if (factorySettled && !cancelled && ownsLifecycle()) {
            setStatus(STATUS_MAP[providerStatus] ?? 'idle')
            updateUserSpeaking(providerStatus === 'user-speaking')

            if (providerStatus === 'user-speaking') {
              retireCaptionItem(retiredCaptionItemsRef.current, liveTranscriptItemRef.current)
              liveTranscriptItemRef.current = null
              setLiveTranscript('')
              vadPlaybackStop = { generation: activeGeneration }
              playbackStopRef.current = vadPlaybackStop
              stopPlayback(activeGeneration)
            } else if (vadPlaybackStop && playbackStopRef.current === vadPlaybackStop) {
              playbackStopRef.current = null
              vadPlaybackStop = null
            }
          }
        },
        onUserTranscriptDelta: (text, itemId) => {
          if (
            !factorySettled ||
            cancelled ||
            !ownsLifecycle() ||
            !itemId ||
            retiredCaptionItemsRef.current.has(itemId)
          ) {
            return
          }

          if (liveTranscriptItemRef.current !== itemId) {
            retireCaptionItem(retiredCaptionItemsRef.current, liveTranscriptItemRef.current)
            liveTranscriptItemRef.current = itemId
          }

          setLiveTranscript(text)
        },
        onUserTranscript: (text, itemId) => {
          const current = onUserTranscriptRef.current

          if (
            factorySettled &&
            !cancelled &&
            ownsLifecycle() &&
            current.sessionId === sessionId
          ) {
            try {
              void Promise.resolve(current.handler(text, itemId)).catch(failOnce)
            } catch (error) {
              failOnce(error)
            }
          }
        },
        sessionId
      })
    } catch (error) {
      factorySettled = true
      failOnce(error)

      return
    }

    factorySettled = true

    if (hasDeferredFailure) {
      failOnce(deferredFailure)

      return
    }

    clientRef.current = client
    endActiveRef.current = { close: closeOnce, generation: activeGeneration }
    mutedRef.current = false
    setMuted(false)
    updateUserSpeaking(false)

    try {
      client.start().catch((error: unknown) => {
        failOnce(error)
      })
    } catch (error) {
      failOnce(error)
    }

    return () => {
      if (clientRef.current === client) {
        clientRef.current = null
      }

      if (endActiveRef.current?.close === closeOnce) {
        endActiveRef.current = null
      }

      if (ownsLifecycle()) {
        setStatus('idle')
        clearLiveTranscript()
        updateUserSpeaking(false)
      }

      void closeOnce().catch(error => {
        if (ownsLifecycle()) {
          onFatalErrorRef.current(error)
        }
      })
    }
  }, [blockNarration, clearLiveTranscript, createClient, enabled, invokePlaybackStop, sessionId, stopPlayback, updateUserSpeaking])

  // Barge-in: stop canonical narration and provider output, keep durable work alive.
  const stopTurn = useCallback(() => {
    const client = clientRef.current

    if (client) {
      const generation = lifecycleRef.current.generation
      const manualBlock = blockNarration(generation)
      playbackStopRef.current = manualBlock
      stopPlayback(generation)

      try {
        client.interrupt()
      } catch (error) {
        setStatus('idle')
        updateUserSpeaking(false)
        clientRef.current = null

        const active = endActiveRef.current

        if (active?.generation === generation) {
          void active.close(true).catch(() => undefined)
        } else {
          blockNarration(generation)
        }

        if (lifecycleRef.current.generation === generation) {
          onFatalErrorRef.current(error)
        }

        return
      }

      queueMicrotask(() => {
        if (
          narrationBlockRef.current === manualBlock &&
          lifecycleRef.current.generation === generation
        ) {
          narrationBlockRef.current = null

          if (playbackStopRef.current === manualBlock) {
            playbackStopRef.current = null
          }
        }
      })
    }
  }, [blockNarration, stopPlayback, updateUserSpeaking])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    clientRef.current?.setMuted(next)
  }, [])

  const end = useCallback(async () => {
    const endActive = endActiveRef.current
    endActiveRef.current = null
    clientRef.current = null
    setStatus('idle')
    clearLiveTranscript()
    updateUserSpeaking(false)

    if (endActive) {
      try {
        await endActive.close()
      } catch (error) {
        if (lifecycleRef.current.generation === endActive.generation) {
          onFatalErrorRef.current(error)
        }
      }
    }
  }, [clearLiveTranscript, updateUserSpeaking])

  return {
    end,
    isNarrationBlocked,
    isUserSpeaking,
    // The Realtime transport carries no analyzer level yet; speaking states
    // drive the visualization instead. A future level feed slots in here.
    level: 0,
    liveTranscript,
    muted,
    status,
    stopTurn,
    toggleMute,
    userSpeaking
  }
}
