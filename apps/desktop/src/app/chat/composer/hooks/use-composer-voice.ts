import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { chatMessageText } from '@/lib/chat-messages'
import { stopVoicePlayback } from '@/lib/voice-playback'
import { notifyError } from '@/store/notifications'
import { $messages } from '@/store/session'
import { $autoSpeakReplies, setAutoSpeakReplies } from '@/store/voice-prefs'

import { onComposerVoiceToggleRequest } from '../focus'
import type { ChatBarProps } from '../types'

import { useAutoSpeakReplies } from './use-auto-speak-replies'
import { type RealtimeVoiceFactory, useRealtimeConversation } from './use-realtime-conversation'
import { useVoiceRecorder } from './use-voice-recorder'


interface UseComposerVoiceArgs {
  disabled: boolean
  focusInput: () => void
  insertText: (text: string) => void
  maxRecordingSeconds: number
  onUserTranscript: (text: string, itemId: string) => Promise<unknown> | void
  onTranscribeAudio: ChatBarProps['onTranscribeAudio']
  realtimeVoiceFactory?: RealtimeVoiceFactory
  sessionId: string | null | undefined
}

/**
 * The composer's voice engine: push-to-talk dictation (transcript → draft),
 * Realtime full-duplex Spoke, and canonical assistant-reply narration for
 * explicitly dispatched durable work. Casual provider speech never submits a
 * canonical text-session turn.
 */
export function useComposerVoice({
  disabled,
  focusInput,
  insertText,
  maxRecordingSeconds,
  onUserTranscript,
  onTranscribeAudio,
  realtimeVoiceFactory,
  sessionId
}: UseComposerVoiceArgs) {
  const { t } = useI18n()
  const [voiceConversationActive, setVoiceConversationActive] = useState(false)
  const lastSpokenIdRef = useRef<string | null>(null)


  const { dictate, voiceActivityState, voiceStatus } = useVoiceRecorder({
    focusInput,
    maxRecordingSeconds,
    onTranscript: insertText,
    onTranscribeAudio
  })

  const pendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (!last || last.id === lastSpokenIdRef.current) {
      return null
    }

    const text = chatMessageText(last).trim()

    if (!text) {
      return null
    }

    return {
      id: last.id,
      pending: Boolean(last.pending),
      text
    }
  }

  const consumePendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (last) {
      lastSpokenIdRef.current = last.id
    }
  }

  const onVoiceFatalError = useCallback(
    (error: unknown) => {
      setVoiceConversationActive(false)
      notifyError(error, t.composer.voiceConversationFailed)
    },
    [t]
  )


  const conversation = useRealtimeConversation({
    createClient: realtimeVoiceFactory,
    enabled: voiceConversationActive,
    onBargeIn: stopVoicePlayback,
    onFatalError: onVoiceFatalError,
    onUserTranscript,
    sessionId
  })

  const endConversation = useCallback(async () => {
    setVoiceConversationActive(false)
    await conversation.end()
  }, [conversation])

  // The `composer.voice` hotkey (Ctrl+B) toggles the conversation. Starting
  // without a configured Realtime factory fails closed with an actionable
  // notice rather than silently no-opping or falling back to the old loop.
  const toggleVoiceConversation = useCallback(() => {
    if (disabled) {
      return
    }

    if (voiceConversationActive) {
      void endConversation()
    } else {
      setVoiceConversationActive(true)
    }
  }, [disabled, endConversation, voiceConversationActive])

  useEffect(() => onComposerVoiceToggleRequest(toggleVoiceConversation), [toggleVoiceConversation])

  // Explicit start/end for the on-screen conversation controls (the hotkey uses
  // the gated toggle above).
  const startConversation = useCallback(() => setVoiceConversationActive(true), [])

  const handleToggleAutoSpeak = useCallback(() => {
    void setAutoSpeakReplies(!$autoSpeakReplies.get()).catch(error =>
      notifyError(error, t.settings.config.autosaveFailed)
    )
  }, [t])

  useAutoSpeakReplies({
    conversationActive: voiceConversationActive,
    failureLabel: t.assistant.thread.readAloudFailed,
    isNarrationBlocked: conversation.isNarrationBlocked,
    isUserSpeaking: conversation.isUserSpeaking,
    markSpoken: consumePendingResponse,
    pendingReply: pendingResponse,
    sessionId,
    userSpeaking: conversation.userSpeaking
  })

  return {
    conversation,
    dictate,
    endConversation,
    handleToggleAutoSpeak,
    liveTranscript: conversation.liveTranscript,
    startConversation,
    voiceActivityState,
    voiceConversationActive,
    voiceStatus
  }
}
