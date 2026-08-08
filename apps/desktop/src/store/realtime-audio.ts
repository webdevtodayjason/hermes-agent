import { atom } from 'nanostores'

/**
 * Global Realtime audio ownership (RED-4).
 *
 * While any Realtime voice session is live, the provider (marin) owns the
 * app's speech output and every generic auto-TTS path must stay silent so
 * there is exactly one speaker. The composer's local conversation state is
 * not enough: a session driven by another surface (the desktop controller's
 * factory path in the acceptance app) never flips that local state, which is
 * how standalone auto-speak narrated over the provider live.
 *
 * Sessions register here for their full lifetime, connect-attempt included.
 * The count survives multiple concurrent sessions; release is once-guarded
 * per acquisition so double-close lifecycles cannot underflow.
 */
export const $realtimeAudioSessions = atom(0)

export function acquireRealtimeAudio(): () => void {
  $realtimeAudioSessions.set($realtimeAudioSessions.get() + 1)

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    $realtimeAudioSessions.set(Math.max(0, $realtimeAudioSessions.get() - 1))
  }
}

/** Synchronous check for event-time guards that must not wait for a render. */
export function isRealtimeAudioOwned(): boolean {
  return $realtimeAudioSessions.get() > 0
}
