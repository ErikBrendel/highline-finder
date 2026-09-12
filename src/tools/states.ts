import { writeFile } from 'node:fs/promises'
import { simplify } from './simplify.js'

/**
 * The coarse outline of every German state, and of the country, for deciding who to ask.
 *
 * Run by hand and about never: `npm run states`. The output is committed and bundled rather than
 * fetched, because both things that read it need an answer before anything has loaded and need it
 * synchronously -- which survey holds a point, and which square of the info map is being hovered.
 *
 * A hint and never an authority. A source asked about ground it does not hold declines and the next
 * one is asked, so a shortcut across a bend costs one wasted request; what it buys is not offering
 * a window over Halle to Brandenburg first. The tolerance below has to stay under the margin the
 * coverage test allows around these rings -- see SOURCE_MARGIN -- so that a shortcut can never put
 * real ground *outside* the source that holds it.
 */

const OUT = new URL('../web/states.json', import.meta.url).pathname

/**
 * The federal boundary dataset, asked for as GeoJSON rather than downloaded as a shapefile.
 *
 * VG2500 is the 1:2 500 000 generalisation, which is the right scale for something simplified to
 * kilometres anyway, and it is open data under dl-de/by-2-0. Taking it from the survey rather than
 * from a convenient copy on GitHub matters here: the copies are mostly GADM-derived, of unstated
 * vintage, and this is what decides which survey gets asked about a point.
 */
const VG2500 =
  'https://sgx.geodatenzentrum.de/wfs_vg2500?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
  '&TYPENAMES=vg2500:vg2500_lan&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326'

/**
 * The outline of the ground the German OpenStreetMap extracts cover, from Geofabrik's own clipping
 * polygon.
 *
 * Not a political border and better than one for this purpose: it is the shape that decides what is
 * in a German extract, which is the shape of what the republisher of the state surveys can possibly
 * hold. Forty kilobytes of text and one ring, where the country's real boundary relation is a
 * four-gigabyte download away.
 *
 * The format is a header line, a section name, then coordinate pairs until END.
 */
const GERMANY_POLY = 'https://download.geofabrik.de/europe/germany.poly'

/** See the note on the tolerance above, and SOURCE_MARGIN in coverage.ts. */
const TOLERANCE_M = 2500

const DEGREE_M = 111_320

/** Two-letter codes, in the order the info map should read them. Also the licence plate order. */
const CODES: Record<string, string> = {
  'Baden-Württemberg': 'BW',
  Bayern: 'BY',
  Berlin: 'BE',
  Brandenburg: 'BB',
  Bremen: 'HB',
  Hamburg: 'HH',
  Hessen: 'HE',
  'Mecklenburg-Vorpommern': 'MV',
  Niedersachsen: 'NI',
  'Nordrhein-Westfalen': 'NW',
  'Rheinland-Pfalz': 'RP',
  Saarland: 'SL',
  Sachsen: 'SN',
  'Sachsen-Anhalt': 'ST',
  'Schleswig-Holstein': 'SH',
  Thüringen: 'TH',
}

const coarsen = (ring: number[][]): number[][] =>
  simplify(ring, TOLERANCE_M / DEGREE_M).map(([lon, lat]) => [
    Math.round(lon! * 1e3) / 1e3,
    Math.round(lat! * 1e3) / 1e3,
  ])

/**
 * Rings worth keeping, outer rings only.
 *
 * Holes are dropped deliberately, and Brandenburg is why: Berlin is a hole in it, and both are
 * ground the same survey answers for. A registry that honoured the hole would decline every window
 * over Berlin from the service that holds it. What the hole is actually needed for -- colouring
 * Berlin as itself on the info map -- Berlin's own ring already provides, drawn over its neighbour.
 *
 * A ring that simplification has reduced to a triangle is an island a couple of kilometres across,
 * which at this tolerance is a shape invented rather than measured.
 */
function ringsOf(geometry: { type: string; coordinates: unknown }): number[][][] {
  const polygons = (
    geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  ) as number[][][][]
  return polygons
    .map((poly) => coarsen(poly[0]!))
    .filter((ring) => ring.length >= 5)
}

interface Feature {
  properties: { gen: string; gf: number }
  geometry: { type: string; coordinates: unknown }
}

async function states(): Promise<{ code: string; name: string; rings: number[][][] }[]> {
  console.log(`downloading ${VG2500.slice(0, 60)}...`)
  const res = await fetch(VG2500, { headers: { 'User-Agent': 'highline-finder/0.1' } })
  if (!res.ok) throw new Error(`VG2500 failed: HTTP ${res.status}`)
  const body = (await res.json()) as { features: Feature[] }

  const out = []
  for (const [name, code] of Object.entries(CODES)) {
    // gf 9 is the whole state; the other geometries on the same key are its water bodies broken
    // out, which is a second polygon of the Bodensee rather than a second Baden-Wuerttemberg.
    const feature = body.features.find((f) => f.properties.gen === name && f.properties.gf === 9)
    if (!feature) throw new Error(`VG2500 has no gf=9 feature named ${name}`)
    const rings = ringsOf(feature.geometry)
    out.push({ code, name, rings })
    console.log(`  ${code} ${name.padEnd(23)} ${rings.length} ring(s), ${rings.reduce((n, r) => n + r.length, 0)} points`)
  }
  return out
}

async function germany(): Promise<number[][]> {
  console.log(`downloading ${GERMANY_POLY}`)
  const res = await fetch(GERMANY_POLY, { headers: { 'User-Agent': 'highline-finder/0.1' } })
  if (!res.ok) throw new Error(`germany.poly failed: HTTP ${res.status}`)
  const ring: number[][] = []
  for (const line of (await res.text()).split('\n')) {
    const pair = line.trim().split(/\s+/).map(Number)
    if (pair.length === 2 && pair.every((v) => Number.isFinite(v))) ring.push(pair)
  }
  if (ring.length < 100) throw new Error(`germany.poly parsed as ${ring.length} points`)
  const coarse = coarsen(ring)
  console.log(`  DE Germany${' '.repeat(16)}1 ring, ${coarse.length} of ${ring.length} points`)
  return coarse
}

async function main() {
  const all = [...(await states()), { code: 'DE', name: 'Germany', rings: [await germany()] }]
  const text = JSON.stringify(all)
  await writeFile(OUT, `${text}\n`)
  console.log(`\nwrote states.json: ${all.length} outlines, ${(text.length / 1024).toFixed(1)} KB`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
