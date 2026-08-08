export interface VoiceIntentTerminalResult {
  correlationId: string
  deliveryId: string
  providerSessionId: string
  sessionId: string
  text: string
}

export interface VoiceIntentProgress {
  correlationId: string
  sessionId: string
  status: 'queued' | 'running' | 'approval_pending' | 'completed' | 'failed' | 'interrupted' | 'rejected'
}

type VoiceIntentTerminalListener = (result: VoiceIntentTerminalResult) => void

const listeners = new Set<VoiceIntentTerminalListener>()
const progressListeners = new Set<(progress: VoiceIntentProgress) => void>()

/** Publish a transient progress update. Durable state remains queryable from the gateway. */
export function publishVoiceIntentProgress(progress: VoiceIntentProgress) {
  for (const listener of progressListeners) {
    listener(progress)
  }
}

export function subscribeVoiceIntentProgress(listener: (progress: VoiceIntentProgress) => void) {
  progressListeners.add(listener)

  return () => {
    progressListeners.delete(listener)
  }
}

/** Publish a transient terminal result. Events are deliberately not replayed. */
export function publishVoiceIntentTerminal(result: VoiceIntentTerminalResult) {
  for (const listener of listeners) {
    listener(result)
  }
}

export function subscribeVoiceIntentTerminal(listener: VoiceIntentTerminalListener) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
