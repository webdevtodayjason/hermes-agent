import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { playSpeechText } from '@/lib/voice-playback'
import { notifyError } from '@/store/notifications'
import { $messages } from '@/store/session'
import { $voicePlayback } from '@/store/voice-playback'
import { $autoSpeakReplies } from '@/store/voice-prefs'

interface AutoSpeakReply {
  id: string
  pending: boolean
  text: string
}

interface UseAutoSpeakReplies {
  conversationActive: boolean
  failureLabel: string
  /** Synchronous close/manual-stop gate before playback-idle listeners can restart output. */
  isNarrationBlocked?: () => boolean
  /** Synchronous VAD ownership check before playback-idle listeners can start another clip. */
  isUserSpeaking?: () => boolean
  /** Mark the current last reply spoken — shared dedupe with the conversation consumer. */
  markSpoken: () => void
  /** Latest completed assistant reply, or null; `pending` true while still streaming. */
  pendingReply: () => AutoSpeakReply | null
  /** Re-arm on session switch so opening a chat never reads its existing last reply. */
  sessionId: string | null | undefined
  /** Hold canonical narration while Realtime VAD says the user is speaking. */
  userSpeaking?: boolean
}

/**
 * Narrate completed canonical assistant turns during active Spoke, or when the
 * standalone `voice.auto_tts` preference is enabled. Never overlaps clips: a
 * reply landing mid-playback is held until playback becomes idle. A backlog
 * collapses to the latest terminal reply.
 */
export function useAutoSpeakReplies({
  conversationActive,
  failureLabel,
  isNarrationBlocked,
  isUserSpeaking,
  markSpoken,
  pendingReply,
  sessionId,
  userSpeaking = false
}: UseAutoSpeakReplies) {
  const enabled = useStore($autoSpeakReplies)
  const mode = conversationActive ? 'spoke' : enabled ? 'standalone' : 'off'
  const lifecycleKey = `${sessionId ?? ''}:${mode}`

  const latest = useRef({
    conversationActive,
    failureLabel,
    isNarrationBlocked,
    isUserSpeaking,
    lifecycleKey,
    markSpoken,
    pendingReply,
    userSpeaking
  })

  // Keep the committed subscriber isolated from suspended/abandoned renders.
  // This still publishes before passive subscription cleanup/recreation.
  useLayoutEffect(() => {
    latest.current = {
      conversationActive,
      failureLabel,
      isNarrationBlocked,
      isUserSpeaking,
      lifecycleKey,
      markSpoken,
      pendingReply,
      userSpeaking
    }
  }, [
    conversationActive,
    failureLabel,
    isNarrationBlocked,
    isUserSpeaking,
    lifecycleKey,
    markSpoken,
    pendingReply,
    userSpeaking
  ])
  const speakLatestRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    const lifecycle = latest.current

    if (lifecycle.lifecycleKey !== lifecycleKey || mode === 'off') {
      return undefined
    }

    // Don't read whatever reply already sits at the bottom when narration is
    // activated (or a chat opens) — consume it so only later replies are spoken.
    lifecycle.markSpoken()

    const activeLifecycleKey = lifecycleKey

    const speakLatest = () => {
      const current = latest.current

      if (current.lifecycleKey !== activeLifecycleKey) {
        return
      }

      const {
        conversationActive,
        failureLabel,
        isNarrationBlocked,
        isUserSpeaking,
        markSpoken,
        pendingReply,
        userSpeaking
      } = current

      if (
        userSpeaking ||
        isNarrationBlocked?.() ||
        isUserSpeaking?.() ||
        $voicePlayback.get().status !== 'idle'
      ) {
        return
      }

      const reply = pendingReply()

      if (!reply || reply.pending) {
        return
      }

      markSpoken()
      void playSpeechText(reply.text, {
        messageId: reply.id,
        source: conversationActive ? 'voice-conversation' : 'read-aloud'
      }).catch(error => notifyError(error, failureLabel))
    }

    // Re-check on a reply completing ($messages) and on the prior clip ending
    // ($voicePlayback → idle), which frees us to read the next held reply.
    speakLatestRef.current = speakLatest
    const stops = [$messages.subscribe(speakLatest), $voicePlayback.listen(speakLatest)]

    return () => {
      stops.forEach(f => f())

      if (speakLatestRef.current === speakLatest) {
        speakLatestRef.current = () => undefined
      }
    }
  }, [lifecycleKey, mode])

  useEffect(() => {
    if (!userSpeaking) {
      speakLatestRef.current()
    }
  }, [userSpeaking])
}
