import type { ComposerAttachment } from '@/store/composer'

interface VoiceTranscriptHandoffArgs {
  activeQueueSessionKey: string | null
  busy: boolean
  enqueue: (
    key: string,
    payload: { text: string; attachments: ComposerAttachment[] }
  ) => object | null
  onSubmit: (
    text: string,
    options: { attachments: ComposerAttachment[] }
  ) => Promise<boolean> | boolean
  text: string
}

type VoiceTranscriptHandoffResult = 'ignored' | 'queued' | 'submitted'

export async function handoffFinalizedVoiceTranscript({
  activeQueueSessionKey,
  busy,
  enqueue,
  onSubmit,
  text
}: VoiceTranscriptHandoffArgs): Promise<VoiceTranscriptHandoffResult> {
  const trimmedText = text.trim()

  if (!trimmedText) {
    return 'ignored'
  }

  const enqueueCanonicalTurn = (): VoiceTranscriptHandoffResult => {
    if (!activeQueueSessionKey) {
      throw new Error('Cannot queue voice transcript without an active queue session.')
    }

    const queued = enqueue(activeQueueSessionKey, { text: trimmedText, attachments: [] })

    if (!queued) {
      throw new Error('Voice transcript could not be queued.')
    }

    return 'queued'
  }

  if (busy) {
    return enqueueCanonicalTurn()
  }

  const submitted = await onSubmit(trimmedText, { attachments: [] })

  if (!submitted) {
    return enqueueCanonicalTurn()
  }

  return 'submitted'
}
