import { render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkhorseSection } from './index'

afterEach(cleanup)

describe('WorkhorseSection', () => {
  it('binds the panel to the real client for the active profile', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })

    render(<WorkhorseSection profile="research" request={request} />)

    expect(screen.getByText('Workhorse')).toBeTruthy()
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('work.recover', {
        session_id: 'desktop-workhorse:research'
      })
    )
  })
})
