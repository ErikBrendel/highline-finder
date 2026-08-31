import { describe, expect, it } from 'vitest'
import { logTrack } from './Slider.js'

/** The length filter's own range: the pipeline's floor to the longest line in the dataset. */
const track = logTrack(50, 500, 10)

describe('logTrack', () => {
  it('pins both ends exactly, so a thumb parked at one turns the filter off', () => {
    expect(track.toValue(track.min)).toBe(50)
    expect(track.toValue(track.max)).toBe(500)
  })

  it('gives the short end the room the linear track spent on the long one', () => {
    const share = (a: number, b: number) => (track.toPos(b) - track.toPos(a)) / track.max
    // 60-90 m is 6 % of a 0-500 m linear track and has to be pickable.
    expect(share(60, 90)).toBeGreaterThan(0.15)
    // A decade is a decade: 50-158 and 158-500 are the same width.
    expect(share(50, 158)).toBeCloseTo(share(158, 500), 1)
  })

  it('lands back within a per cent of the value a thumb was set from', () => {
    for (const v of [50, 60, 75, 90, 120, 250, 400, 500]) {
      expect(Math.abs(track.toValue(track.toPos(v)) - v) / v).toBeLessThan(0.01)
    }
  })

  it('falls back to a linear track where no ratio exists', () => {
    // An empty dataset gives a zero floor, a single-valued one gives no width.
    for (const t of [logTrack(0, 500, 10), logTrack(50, 50, 10)]) {
      expect(t.toValue(123)).toBe(123)
      expect(t.step).toBe(10)
    }
  })
})
