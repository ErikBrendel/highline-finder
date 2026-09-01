import { describe, expect, it } from 'vitest'
import { locateFailure } from './locate.js'

const error = (code: number, message = ''): GeolocationPositionError =>
  ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as
    GeolocationPositionError

describe('locateFailure', () => {
  /**
   * The refusal message is the one that matters. A browser that has stored "denied" for a site does
   * not prompt again, it fails silently -- so telling someone to press the button again, without
   * telling them where the decision now lives, is advice that cannot work.
   */
  it('sends a refused request to the browser settings rather than back to the button', () => {
    const said = locateFailure(error(1))
    expect(said).toMatch(/settings/i)
  })

  it('tells the other two failures apart, and says something for a code it does not know', () => {
    const [unavailable, timeout] = [locateFailure(error(2)), locateFailure(error(3))]
    expect(unavailable).not.toEqual(timeout)
    expect(timeout).toMatch(/again/i)
    expect(locateFailure(error(9, 'something else'))).toBe('something else')
  })
})
