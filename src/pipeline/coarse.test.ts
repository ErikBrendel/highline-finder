import { describe, expect, it } from 'vitest'
import { dropField, tilesWorthLoading } from './coarse.js'
import { Grid } from '../shared/grid.js'

/** A 3 x 1 km strip of 16 m cells, flat except where `steep` says otherwise. */
function strip(steep: (e: number, n: number) => number): Grid {
  const res = 16
  const w = 3000 / res
  const h = 1000 / res
  const g = Grid.filled(w, h, 400000, 5800000 + 1000, res)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = 400000 + (x + 0.5) * res
      const n = 5800000 + 1000 - (y + 0.5) * res
      g.data[y * w + x] = 50 - steep(e, n)
    }
  }
  return g
}

describe('tilesWorthLoading', () => {
  it('ignores a handful of steep cells in an otherwise flat tile', () => {
    // A single 32 m pothole in the middle tile: three cells deep enough, thousands not.
    const g = strip((e, n) => (Math.hypot(e - 401500, n - 5800500) < 24 ? 20 : 0))
    const drop = dropField(g, 32)
    expect(tilesWorthLoading(drop, 10, 0.02, 500).size).toBe(0)
    // With the old any-single-cell rule the pothole would have pulled in its neighbours too.
    expect(tilesWorthLoading(drop, 10, 0, 500).size).toBeGreaterThan(0)
  })

  it('takes a tile whose steep ground covers enough of it', () => {
    // The eastern third drops away as a slope, so most of that tile's cells qualify.
    const g = strip((e) => Math.max(0, (e - 402000) / 2))
    const tiles = tilesWorthLoading(dropField(g, 32), 10, 0.02, 500)
    expect(tiles.has('33402-5800')).toBe(true)
  })

  it('extends the margin from the steep cells, not from whole tiles', () => {
    // Steep ground only at the far east edge: the tile 2 km west is out of a line's reach.
    const g = strip((e) => Math.max(0, (e - 402000) / 2))
    const tiles = tilesWorthLoading(dropField(g, 32), 10, 0.02, 500)
    expect(tiles.has('33401-5800')).toBe(true)
    expect(tiles.has('33400-5800')).toBe(false)
  })

  it('keeps everything when the threshold is zero', () => {
    const g = strip(() => 0)
    expect(tilesWorthLoading(dropField(g, 32), 0, 0, 500).size).toBeGreaterThan(0)
  })
})
