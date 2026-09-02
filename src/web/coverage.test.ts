import { describe, expect, it } from 'vitest'
import { nearState, SOURCE_MARGIN } from './coverage.js'

/**
 * Which survey gets asked, before anything is fetched.
 *
 * Wrong in the generous direction costs one request that comes back empty; wrong in the other costs
 * ground nobody can measure. So the margin is what these check hardest.
 */
const places = {
  potsdam: [13.0645, 52.3906],
  berlin: [13.405, 52.52],
  halle: [11.9705, 51.4825],
  leipzig: [12.3731, 51.3397],
  dresden: [13.7373, 51.0504],
  magdeburg: [11.6276, 52.1205],
  köln: [6.9603, 50.9375],
  münchen: [11.582, 48.135],
} as const
const at = (state: string, place: keyof typeof places) =>
  nearState(state, places[place][0], places[place][1])

describe('nearState', () => {
  it('claims its own ground', () => {
    expect(at('Brandenburg', 'potsdam')).toBe(true)
    expect(at('Sachsen', 'leipzig')).toBe(true)
    expect(at('Sachsen', 'dresden')).toBe(true)
    expect(at('Sachsen-Anhalt', 'halle')).toBe(true)
    expect(at('Sachsen-Anhalt', 'magdeburg')).toBe(true)
  })

  /** The whole point: Brandenburg's bounding box takes in Halle, and its outline does not. */
  it('does not claim a neighbour’s city that its bounding box would have', () => {
    expect(at('Brandenburg', 'halle')).toBe(false)
    expect(at('Brandenburg', 'leipzig')).toBe(false)
    expect(at('Sachsen', 'halle')).toBe(false)
    expect(at('Sachsen', 'potsdam')).toBe(false)
  })

  it('claims the hole in the middle of it, since the same survey answers there', () => {
    expect(at('Brandenburg', 'berlin')).toBe(true)
  })

  it('claims nothing on the other side of the country', () => {
    for (const state of ['Brandenburg', 'Sachsen', 'Sachsen-Anhalt']) {
      expect(at(state, 'köln')).toBe(false)
      expect(at(state, 'münchen')).toBe(false)
    }
  })

  it('reaches a little past its own border, because a survey usually does', () => {
    // Due west of Brandenburg's western edge, stepping out until the margin runs out.
    const [lon, lat] = [11.5, 52.6]
    expect(nearState('Brandenburg', lon, lat, 60_000)).toBe(true)
    expect(nearState('Brandenburg', lon, lat, 100)).toBe(false)
  })

  it('lets an unknown name cover everywhere, so a new source is never silently muted', () => {
    expect(nearState('Bayern', ...places.münchen)).toBe(true)
  })

  it('has a margin bigger than the simplification it forgives', () => {
    // outlines.json is cut at 2.5 km; a shortcut across a bend must not exclude real ground.
    expect(SOURCE_MARGIN).toBeGreaterThan(2500)
  })
})
