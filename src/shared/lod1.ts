import type { Grid } from './grid.js'

/**
 * Building outlines and heights, from the survey's LoD1 city model.
 *
 * The terrain model is bare earth and runs straight through a house; the surface model knows
 * something is there but cannot tell a roof from a tree. This is the source that answers the
 * question directly: `3d_gebaeude/lod1_gml` publishes one CityGML file per 1 km tile -- the same
 * tiling as the elevation products -- holding every building as a solid with absolute heights in
 * the same ETRS89 / DHHN2016 frame as everything else.
 *
 * It is also, by a wide margin, the cheap way to do it. A tile is 5-50 KB zipped against 33 MB for
 * the surface model, and a tile with no buildings simply has no file, so a 404 is the emptiness
 * test. Deriving roof heights from the surface model instead meant fetching 33 MB for any tile
 * with a single farmhouse on it -- and in Brandenburg three quarters of tiles have one.
 *
 * A LoD1 building is an extruded footprint: a flat floor at the ground, a flat roof at
 * `measuredHeight` above it, and vertical walls between. So the two horizontal faces of each solid
 * carry everything needed -- the outline in x/y and the height in z -- and no building geometry
 * has to be understood beyond "this ring is level".
 *
 * What it is not: a real roof. LoD1 flattens a pitched roof to a single height, which the ADV
 * specification puts at the eaves, the ridge, or an area-weighted point between them depending on
 * the state's `BezugspunktDach`. So a roof anchor derived from this is accurate to a metre or two
 * on a house and exact on a flat-roofed block -- and unlike the surface model it never reports a
 * tree growing beside a building, or a crane that was standing there in 2024, as part of it.
 */

/** One level face of a building solid: its outline as `[e, n, e, n, ...]`, at height `z`. */
export interface LevelFace {
  ring: number[]
  z: number
}

/** Below this, a ring's corners count as being at one height. Real LoD1 faces are exactly level. */
const LEVEL_TOLERANCE = 1e-6

const POSLIST = /<gml:posList[^>]*>([^<]+)<\/gml:posList>/g

/**
 * Every level face in a CityGML tile, floors as well as roofs.
 *
 * Deliberately not grouped by building, and deliberately keeping the floors. Rasterising takes the
 * greatest height per cell and the ground is then merged with `max`, so a floor face lands at or
 * below the terrain and changes nothing -- which means neither building parts nor stepped roofs
 * nor floor-versus-roof need to be told apart. Reading the file as a flat list of rings makes the
 * whole parser a scan for one tag.
 */
export function levelFaces(gml: string): LevelFace[] {
  const out: LevelFace[] = []
  for (const [, body] of gml.matchAll(POSLIST)) {
    const v = body!.trim().split(/\s+/)
    if (v.length < 12 || v.length % 3 !== 0) continue
    const z = Number(v[2])
    let level = true
    const ring: number[] = []
    for (let i = 0; i < v.length; i += 3) {
      if (Math.abs(Number(v[i + 2]) - z) > LEVEL_TOLERANCE) {
        level = false
        break
      }
      ring.push(Number(v[i]), Number(v[i + 1]))
    }
    if (level) out.push({ ring, z })
  }
  return out
}

/**
 * Draws level faces into a grid, keeping the greatest height where they overlap.
 *
 * Even-odd scanline fill on cell centres, which is the same rule a cadastre raster would use: a
 * cell belongs to the building if the building covers the middle of it. Buildings narrower than a
 * cell can fall between the scanlines and vanish, which at 1 m means a shed the size of a desk.
 *
 * Cells outside a face keep whatever they had, so a grid pre-filled with NaN comes back as a
 * roofs-only overlay that a `max` blit can merge into terrain without touching the rest.
 */
export function rasteriseFaces(faces: LevelFace[], into: Grid): number {
  let cells = 0
  for (const { ring, z } of faces) {
    let minN = Infinity
    let maxN = -Infinity
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i]! < minN) minN = ring[i]!
      if (ring[i]! > maxN) maxN = ring[i]!
    }
    const rowOf = (n: number) => (into.n1 - n) / into.res - 0.5
    const row0 = Math.max(0, Math.ceil(rowOf(maxN)))
    const row1 = Math.min(into.h - 1, Math.floor(rowOf(minN)))

    for (let row = row0; row <= row1; row++) {
      const n = into.n1 - (row + 0.5) * into.res
      const crossings: number[] = []
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const ay = ring[i + 1]!
        const by = ring[j + 1]!
        if (ay > n === by > n) continue
        crossings.push(ring[i]! + ((n - ay) / (by - ay)) * (ring[j]! - ring[i]!))
      }
      crossings.sort((a, b) => a - b)
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const colOf = (e: number) => (e - into.e0) / into.res - 0.5
        const col0 = Math.max(0, Math.ceil(colOf(crossings[k]!)))
        const col1 = Math.min(into.w - 1, Math.floor(colOf(crossings[k + 1]!)))
        for (let col = col0; col <= col1; col++) {
          const at = row * into.w + col
          const cur = into.data[at]!
          if (Number.isNaN(cur) || z > cur) {
            if (Number.isNaN(cur)) cells++
            into.data[at] = z
          }
        }
      }
    }
  }
  return cells
}
