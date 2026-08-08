import { beforeEach, describe, expect, it } from 'vitest'

import { $realtimeAudioSessions, acquireRealtimeAudio, isRealtimeAudioOwned } from './realtime-audio'

beforeEach(() => {
  $realtimeAudioSessions.set(0)
})

describe('realtime audio ownership', () => {
  it('is unowned until a session acquires and owned until the last release', () => {
    expect(isRealtimeAudioOwned()).toBe(false)

    const releaseA = acquireRealtimeAudio()
    const releaseB = acquireRealtimeAudio()

    expect(isRealtimeAudioOwned()).toBe(true)
    releaseA()
    expect(isRealtimeAudioOwned()).toBe(true)
    releaseB()
    expect(isRealtimeAudioOwned()).toBe(false)
  })

  it('guards each release to exactly once so double-close cannot underflow', () => {
    const releaseA = acquireRealtimeAudio()
    const releaseB = acquireRealtimeAudio()

    releaseA()
    releaseA()
    releaseA()

    expect(isRealtimeAudioOwned()).toBe(true)
    releaseB()
    expect(isRealtimeAudioOwned()).toBe(false)
    expect($realtimeAudioSessions.get()).toBe(0)
  })
})
