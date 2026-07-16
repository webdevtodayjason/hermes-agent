import { describe, expect, it } from 'vitest'

import { appViewForPath, routeSessionId, WORKHORSE_ROUTE } from './routes'

describe('workhorse app route', () => {
  it('registers /workhorse as an app section rather than a session id', () => {
    expect(WORKHORSE_ROUTE).toBe('/workhorse')
    expect(appViewForPath(WORKHORSE_ROUTE)).toBe('workhorse')
    expect(routeSessionId(WORKHORSE_ROUTE)).toBeNull()
  })
})
