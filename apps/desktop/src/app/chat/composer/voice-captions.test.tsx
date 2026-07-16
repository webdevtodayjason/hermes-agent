import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { VoiceCaptions } from './voice-captions'

afterEach(cleanup)

describe('VoiceCaptions', () => {
  it('is compact, default-expanded, and user-collapsible while Spoke is active', () => {
    render(<VoiceCaptions active status="listening" transcript="A live transcript" />)

    expect(screen.getByRole('button', { name: 'Collapse live captions' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('A live transcript')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse live captions' }))

    expect(screen.getByRole('button', { name: 'Expand live captions' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a listening placeholder and resets expanded state for each active conversation', () => {
    const view = render(<VoiceCaptions active status="listening" transcript="" />)

    expect(screen.getByRole('status').textContent).toContain('Listening for your voice…')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse live captions' }))
    view.rerender(<VoiceCaptions active={false} status="idle" transcript="" />)
    expect(screen.queryByText('Live captions')).toBeNull()

    view.rerender(<VoiceCaptions active status="listening" transcript="" />)
    expect(screen.getByRole('button', { name: 'Collapse live captions' }).getAttribute('aria-expanded')).toBe('true')
  })
})