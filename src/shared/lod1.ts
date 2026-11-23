import { fillPolygon, type Grid } from './grid.js'

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
 * Even-odd scanline fill on cell centres -- see fillPolygon, which water shares -- so a cell belongs
 * to the building if the building covers the middle of it. Buildings narrower than a cell can fall
 * between the scanlines and vanish, which at 1 m means a shed the size of a desk.
 *
 * Cells outside a face keep whatever they had, so a grid pre-filled with NaN comes back as a
 * roofs-only overlay that a `max` blit can merge into terrain without touching the rest.
 */
export function rasteriseFaces(faces: LevelFace[], into: Grid): number {
  let cells = 0
  for (const { ring, z } of faces) {
    fillPolygon(ring, into, (at) => {
      const cur = into.data[at]!
      if (!Number.isNaN(cur) && z <= cur) return
      if (Number.isNaN(cur)) cells++
      into.data[at] = z
    })
  }
  return cells
}


/** How far past its footprint a building may be grown, in cells. */
const EAVES_REACH = 4
/** How much a cell may read above the roof cell it grows from: survey noise, not a step up. */
const EAVES_NOISE = 0.5
/**
 * How far under the footprint's own roof a grown cell may read and still be roof: eaves and the
 * tops of loggias, which the surface model sees about two metres down. Further down is facade.
 */
const EAVES_DROP = 3
/** Below this over the terrain a cell is open ground, as `CANOPY_FROM` has it in the 3D view. */
const STANDING = 2

/**
 * Grows each roof into what the surface model shows standing against it, and marks which of the
 * grown cells are facade.
 *
 * A footprint is the wall line from the cadastre. The surface model also sees what sticks out of
 * it -- eaves, loggias and balconies, a metre to several out -- and the cells straddling the outer
 * wall, which read somewhere between roof and street. None of that is on a footprint, so all of it
 * stood two metres and more above the terrain off any building, which is what canopy is: a row of
 * trees hugging every facade, and in the 3D view a green wall down each one. On a Leipzig
 * Plattenbau the footprint stopped four metres short of the loggias.
 *
 * Grown outwards from the footprint through cells that stand and never rise above the cell they
 * are reached from: a building steps down from its roof to the street, where a tree beside it
 * climbs again to its own crown, and that climb is where the growing stops. Only the cover changes;
 * the height drawn and measured there stays the surface model's own.
 *
 * A grown cell reading more than `EAVES_DROP` under the footprint roof it was reached from is a
 * wall seen from above, not roof. It stays building, so it draws no canopy, but goes into `facade`:
 * whether one is caught depends on where the wall happens to cross the cell grid, so treated as roof
 * it put a one-metre notch into the outline every few cells along an otherwise straight wall.
 */
export function growRoofs(roof: Grid, surface: Grid, ground: Grid, facade: Grid): number {
  const { w, h } = roof
  const footprintTop = roof.data.map((z, i) => (Number.isNaN(z) ? NaN : Number.isNaN(surface.data[i]!) ? z : surface.data[i]!))
  let grown = 0
  for (let pass = 0; pass < EAVES_REACH; pass++) {
    const before = roof.data.slice()
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = row * w + col
        const top = surface.data[i]!
        if (!Number.isNaN(before[i]!) || !(top - ground.data[i]! >= STANDING)) continue
        for (const j of [i - w, i + w, col > 0 ? i - 1 : -1, col + 1 < w ? i + 1 : -1]) {
          if (j < 0 || j >= w * h || Number.isNaN(before[j]!)) continue
          if (top > surface.data[j]! + EAVES_NOISE) continue
          roof.data[i] = before[j]!
          footprintTop[i] = footprintTop[j]!
          if (!(top >= footprintTop[j]! - EAVES_DROP)) facade.data[i] = 1
          grown++
          break
        }
      }
    }
  }
  return grown
}
