import { Captions, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import type { ConversationStatus } from './hooks/use-realtime-conversation'

interface VoiceCaptionsProps {
  active: boolean
  status: ConversationStatus
  transcript: string
}

const EMPTY_CAPTION: Record<ConversationStatus, string> = {
  idle: 'Starting live captions…',
  listening: 'Listening for your voice…',
  speaking: 'Listening while Hermes speaks…',
  thinking: 'Connecting live captions…',
  transcribing: 'Transcribing…'
}

/**
 * Ephemeral Spoke captions. This surface never submits or persists text; the
 * finalized transcript still enters the thread through the canonical composer
 * handoff and renders as the normal user message.
 */
export function VoiceCaptions({ active, status, transcript }: VoiceCaptionsProps) {
  const [expanded, setExpanded] = useState(true)
  const wasActiveRef = useRef(false)

  useEffect(() => {
    if (active && !wasActiveRef.current) {
      setExpanded(true)
    }

    wasActiveRef.current = active
  }, [active])

  if (!active) {
    return null
  }

  const caption = transcript.trim() || EMPTY_CAPTION[status]

  return (
    <div
      className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--dt-composer-ring)_28%,transparent)] bg-accent/12"
      data-slot="voice-captions"
    >
      <button
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse live captions' : 'Expand live captions'}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[0.68rem] font-medium text-muted-foreground/90 transition-colors hover:text-foreground"
        onClick={() => setExpanded(value => !value)}
        type="button"
      >
        <Captions aria-hidden className="size-3.5 shrink-0" />
        <span className="flex-1">Live captions</span>
        <ChevronDown
          aria-hidden
          className={cn('size-3.5 shrink-0 transition-transform', !expanded && '-rotate-90')}
        />
      </button>
      {expanded && (
        <div
          aria-atomic="true"
          aria-live="polite"
          className={cn(
            'max-h-16 overflow-y-auto border-t border-[color-mix(in_srgb,var(--dt-composer-ring)_20%,transparent)] px-2 py-1.5 text-xs leading-relaxed',
            transcript.trim() ? 'text-foreground/90' : 'italic text-muted-foreground/70'
          )}
          role="status"
        >
          {caption}
        </div>
      )}
    </div>
  )
}