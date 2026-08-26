import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failureText, onFailure, report } from './report.js'

describe('report', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined))

  it('tells whoever is listening, and counts a repeat rather than repeating it', () => {
    const heard: { what: string; count: number }[] = []
    const stop = onFailure((f) => heard.push({ what: f.what, count: f.count }))
    report('fetching a thing', new Error('boom'))
    report('fetching a thing', new Error('boom'))
    report('fetching another thing', new Error('bang'))
    stop()
    report('fetching a thing', new Error('boom'))

    expect(heard).toEqual([
      { what: 'fetching a thing', count: 1 },
      { what: 'fetching a thing', count: 2 },
      { what: 'fetching another thing', count: 1 },
    ])
    // The console gets the first of each, not one per repeat -- dragging across ground the
    // elevation service refuses would otherwise emit a line per window per frame.
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('describes a thrown non-Error as well as an Error', () => {
    expect(failureText(new TypeError('nope'))).toBe('TypeError: nope')
    expect(failureText('just a string')).toBe('just a string')
  })
})
