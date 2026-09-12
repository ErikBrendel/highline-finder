import { describe, expect, it } from 'vitest'
import { ancestor, touches, type StackLayer } from './stacked.js'

/**
 * Which surveys get asked about a tile.
 *
 * A stacked basemap has four layers and a tile needs one or two of them; without this every tile
 * would ask every state in the country. Wrong in the generous direction is a wasted request, wrong
 * in the other is a hole in the map, so the edges are what matter.
 */
const mercator = (west: number, south: number, east: number, north: number) => {
  const R = 6378137
  const x = (lon: number) => (lon * Math.PI * R) / 180
  const y = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return `${x(west)},${y(south)},${x(east)},${y(north)}`
}

const saxony: StackLayer = { url: '', bbox: [11.8, 50.1, 15.1, 51.7] }
const everywhere: StackLayer = { url: '' }

describe('touches', () => {
  it('asks a survey about a tile over its own ground', () => {
    expect(touches(saxony, mercator(12.3, 51.3, 12.4, 51.4))).toBe(true)
  })

  it('does not ask it about a tile nowhere near', () => {
    // Cologne, on the other side of the country.
    expect(touches(saxony, mercator(6.9, 50.9, 7.0, 51.0))).toBe(false)
  })

  it('asks about a tile that only overlaps a corner, since half a tile is still a tile', () => {
    expect(touches(saxony, mercator(11.7, 51.6, 11.9, 51.8))).toBe(true)
  })

  it('always asks a layer that claims no bounds', () => {
    expect(touches(everywhere, mercator(6.9, 50.9, 7.0, 51.0))).toBe(true)
  })

  it('asks everyone when the bounding box is not a bounding box', () => {
    // Better a wasted request than a blank tile, if MapLibre ever hands over something odd.
    expect(touches(saxony, 'not,a,box')).toBe(true)
  })
})

/**
 * Where a layer stops holding tiles.
 *
 * EOX advertises a matrix set down to twenty-one and serves Sentinel-2 to eighteen, so three zoom
 * levels of every deep view were fetching 404s and reporting each as a survey failure. The crop is
 * what keeps the blown-up tile showing the right ground rather than the north-west corner of a
 * region.
 */
describe('ancestor', () => {
  const capped: StackLayer = { url: '', maxzoom: 18 }

  it('asks for the tile itself while the service still has it', () => {
    expect(ancestor(capped, 18, 140735, 90326)).toEqual({
      z: 18,
      x: 140735,
      y: 90326,
      crop: [0, 0, 1],
    })
  })

  it('walks up to the deepest level held and takes the quarter that is wanted', () => {
    // The tile the reports came from, two levels past what EOX answers.
    const { z, x, y, crop } = ancestor(capped, 20, 562943, 361307)
    expect([z, x, y]).toEqual([18, 140735, 90326])
    expect(crop).toEqual([0.75, 0.75, 0.25])
  })

  it('leaves a layer with no ceiling alone, however deep', () => {
    expect(ancestor(everywhere, 22, 7, 9)).toEqual({ z: 22, x: 7, y: 9, crop: [0, 0, 1] })
  })
})
