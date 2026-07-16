import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Composer-side adapter for the full-duplex Realtime voice transport.
 *
 * Structural mirror of the transport surface published by hermes-sol at
 * `lib/realtime-voice-client.ts` (COLLAB-LOG 2026-07-16T05:12Z). The
 * transport module itself is not touched here; the concrete factory is
 * injected by the composition layer, so this hook compiles and tests
 * against the contract alone.
 *
 * Product rules enforced here (slice 1R, Step B):
 * - stopTurn is BARGE-IN: interrupt assistant speech only. It must never
 *   end the session, close the mic, or touch durable work.
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
  onStatus: (status: RealtimeVoiceStatus) => void
}

export type RealtimeVoiceFactory = (options: RealtimeVoiceFactoryOptions) => RealtimeVoiceClientLike

interface UseRealtimeConversationArgs {
  createClient: RealtimeVoiceFactory | undefined
  enabled: boolean
  onFatalError: (error: unknown) => void
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

export function useRealtimeConversation({
  createClient,
  enabled,
  onFatalError,
  sessionId
}: UseRealtimeConversationArgs) {
  const [status, setStatus] = useState<ConversationStatus>('idle')
  const [muted, setMuted] = useState(false)
  const clientRef = useRef<RealtimeVoiceClientLike | null>(null)
  const mutedRef = useRef(false)
  // Latest-ref: a non-memoized error callback must not tear down and
  // recreate the live audio session on every parent render.
  const onFatalErrorRef = useRef(onFatalError)
  onFatalErrorRef.current = onFatalError
  // Exactly-once end per session: explicit end() and the effect cleanup
  // both reach the same client (Sol's adapter-lifecycle finding). Each
  // session's effect creates one once-guarded closure shared by both paths.
  const endActiveRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    if (!createClient) {
      onFatalErrorRef.current(
        new Error(
          'Realtime voice is not configured for this build. Connect the voice gateway (voice.session.create) and try again.'
        )
      )

      return
    }

    if (!sessionId) {
      onFatalErrorRef.current(new Error('Start or select a conversation before starting voice.'))

      return
    }

    let cancelled = false
    let ended = false

    const client = createClient({
      onStatus: providerStatus => {
        if (!cancelled) {
          setStatus(STATUS_MAP[providerStatus] ?? 'idle')
        }
      },
      sessionId
    })

    const endOnce = (): Promise<void> => {
      if (ended) {
        return Promise.resolve()
      }

      ended = true

      return client.end()
    }

    clientRef.current = client
    endActiveRef.current = endOnce
    mutedRef.current = false
    setMuted(false)

    client.start().catch((error: unknown) => {
      if (!cancelled) {
        setStatus('idle')
        clientRef.current = null
        onFatalErrorRef.current(error)
      }
    })

    return () => {
      cancelled = true
      clientRef.current = null

      if (endActiveRef.current === endOnce) {
        endActiveRef.current = null
      }

      setStatus('idle')
      void endOnce()
    }
  }, [createClient, enabled, sessionId])

  // Barge-in: pause assistant speech, keep everything else alive.
  const stopTurn = useCallback(() => {
    clientRef.current?.interrupt()
  }, [])

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

    if (endActive) {
      await endActive()
    }
  }, [])

  return {
    end,
    // The Realtime transport carries no analyzer level yet; speaking states
    // drive the visualization instead. A future level feed slots in here.
    level: 0,
    muted,
    status,
    stopTurn,
    toggleMute
  }
}
