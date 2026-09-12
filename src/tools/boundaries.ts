import { mkdir, writeFile } from 'node:fs/promises'
import { simplify } from './simplify.js'

/**
 * The border of every German state, for the map to draw.
 *
 * Run it by hand, about never: `npm run boundaries`. A state border moves less often than anything
 * else this project draws, and the output is committed, so the deployed site asks nothing of anyone
 * to know where a survey ends.
 *
 * All sixteen, not only the surveyed ones. What the map shows changes at a state line everywhere in
 * the country now -- the orthophoto goes from twenty centimetres to Sentinel-2's ten metres, the
 * relief from a metre to basemap.de's five -- and an unexplained seam in the imagery reads as a
 * rendering fault. The border is what turns it into a fact about who publishes what.
 *
 * This used to trace the boundary relations out of per-state OpenStreetMap extracts, which cost a
 * few hundred megabytes a state and a three-pass read of each, and still could not close a ring:
 * Geofabrik clips an extract at the state line, so the last way of the border is the one missing.
 * VG250 is the survey's own product, one request, closed rings, and the authority on the question --
 * where the two disagreed it was around BER, which OSM had not caught up with.
 */

const OUT = new URL('../web/public/boundaries.json', import.meta.url).pathname

/**
 * The federal boundary dataset at 1:250 000, asked for as GeoJSON. Open data, dl-de/by-2-0.
 *
 * Ten times finer than the VG2500 that `npm run states` routes by, which is the right difference:
 * that one decides which survey to ask and is allowed to cut corners, this one is looked at.
 */
const VG250 =
  'https://sgx.geodatenzentrum.de/wfs_vg250?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
  '&TYPENAMES=vg250:vg250_lan&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326'

/**
 * How far a drawn border may sit from the surveyed one.
 *
 * A hundred metres is under a pixel at every zoom the whole of a state is visible at, and about
 * three at the deepest zoom anyone reads a border at. The dataset is published to the field
 * boundary, which is four times more line than is ever seen.
 */
const TOLERANCE_M = 100

/** A ring shorter than this round is a sandbank, and at any zoom it draws as a dot. */
const MIN_RING_M = 1000

const DEGREE_M = 111_320

interface Feature {
  properties: { gen: string; gf: number }
  geometry: { type: string; coordinates: number[][][][] | number[][][] }
}

/**
 * One state's border as open lines, outer rings only.
 *
 * Holes are dropped because the state sitting in them draws the same line as its own outer ring:
 * Berlin is a hole in Brandenburg, Bremen two holes in Lower Saxony, and the handful of exclaves
 * elsewhere work the same way. Kept, every one of those borders would be drawn twice.
 *
 * Simplified in a flat metric local to the state rather than in a projection, because the country
 * is five UTM zones wide and this compares distances of a few hundred metres.
 */
function linesOf(feature: Feature): number[][][] {
  const polygons = (
    feature.geometry.type === 'MultiPolygon'
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates]
  ) as number[][][][]
  const lats = polygons.flat(2).map((p) => p[1]!)
  const cosLat = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180)
  const round = (v: number) => Math.round(v * 1e4) / 1e4

  const out: number[][][] = []
  for (const polygon of polygons) {
    const ring = polygon[0]!.map(([lon, lat]) => [lon! * cosLat * DEGREE_M, lat! * DEGREE_M])
    let round_m = 0
    for (let i = 1; i < ring.length; i++) {
      round_m += Math.hypot(ring[i]![0]! - ring[i - 1]![0]!, ring[i]![1]! - ring[i - 1]![1]!)
    }
    if (round_m < MIN_RING_M) continue
    out.push(
      simplify(ring, TOLERANCE_M).map(([x, y]) => [
        round(x! / cosLat / DEGREE_M),
        round(y! / DEGREE_M),
      ]),
    )
  }
  return out
}

async function main() {
  console.log(`downloading ${VG250.slice(0, 60)}...`)
  const res = await fetch(VG250, {
    headers: { 'User-Agent': 'highline-finder/0.1' },
  })
  if (!res.ok) throw new Error(`VG250 failed: HTTP ${res.status}`)
  // gf 4 is the land; the other geometries on the same name are its share of the North Sea, the
  // Baltic and the Bodensee, where no border is drawn because none is agreed.
  const land = ((await res.json()) as { features: Feature[] }).features.filter(
    (f) => f.properties.gf === 4,
  )
  if (land.length !== 16) throw new Error(`VG250 gave ${land.length} gf=4 states, expected 16`)

  const features = land.map((f) => {
    const lines = linesOf(f)
    const points = lines.reduce((n, r) => n + r.length, 0)
    console.log(`  ${f.properties.gen.padEnd(23)} ${lines.length} line(s), ${points} points`)
    return {
      type: 'Feature' as const,
      properties: { name: f.properties.gen },
      geometry: { type: 'MultiLineString' as const, coordinates: lines },
    }
  })

  const text = JSON.stringify({ type: 'FeatureCollection', features })
  await mkdir(new URL('.', `file://${OUT}`).pathname, { recursive: true })
  await writeFile(OUT, `${text}\n`)
  console.log(
    `\nwrote boundaries.json: ${features.length} states, ${(text.length / 1024).toFixed(0)} KB`,
  )
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
