import { Grid } from '../shared/grid.js'

/** Builds a synthetic 1 m grid from a height function, for tests. */
export function gridFrom(
  w: number,
  h: number,
  height: (e: number, n: number) => number,
): Grid {
  const g = Grid.filled(w, h, 0, h, 1)
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      g.data[row * w + col] = height(col + 0.5, h - row - 0.5)
    }
  }
  return g
}
