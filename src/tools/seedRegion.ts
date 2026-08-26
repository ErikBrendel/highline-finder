import { readRegion, regionId, writeRegion } from '../pipeline/regionCache.js'
import { workAreas } from '../pipeline/regions.js'
import { DEFAULT_AOIS, DEFAULT_PARAMS } from '../pipeline/params.js'
import { LINE_KINDS } from '../shared/types.js'

/**
 * Writes an empty result for any area that has never been searched.
 *
 * For working towards statewide coverage a chunk at a time. Adding the areas is cheap and says
 * where the search is *going* to go; actually searching one is tens of minutes of downloading. This
 * fills the gap between the two, so the whole intended footprint can be looked at on the map --
 * region boxes, vintages, which ground is claimed and which is not -- before any of it is paid for.
 *
 * A seeded region is not a claim that the ground holds nothing. It is a claim that nothing has
 * looked, and it says so in the one field no real search could produce: `anchorsScanned: 0`. A real
 * 256 km2 area scans about eleven million points. Nothing else in the file distinguishes them, so
 * that field is the tell.
 *
 * Because a computed region is kept until a run is told to rebuild it, seeding one means later runs
 * will keep serving the empty answer. Recompute it by naming its ground on the command line, which
 * is the same thing you would do to refresh any other region.
 *
 * Usage: npx tsx src/tools/seedRegion.ts [hoursAgo]
 */

const hoursAgo = Number(process.argv[2] ?? 0)

const empty = () => ({ e: [] as number[], n: [] as number[], count: [] as number[], score: [] as number[] })

async function main() {
  const p = DEFAULT_PARAMS
  const areas = workAreas(DEFAULT_AOIS, p.maxLength)
  const stamp = new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  let seeded = 0

  for (const area of areas) {
    if (await readRegion(area.aois)) continue
    const { bbox } = area
    const value = {
      region: {
        aois: area.aois,
        bbox25833: bbox,
        width: Math.round(bbox.maxE - bbox.minE),
        height: Math.round(bbox.maxN - bbox.minN),
        // Nothing was loaded, so there is no terrain range to report. Readers key off
        // anchorsScanned rather than trying to tell a real zero from this one.
        groundMin: 0,
        groundMax: 0,
        anchorsScanned: 0,
        anchorsKept: 0,
        generatedAt: '',
      },
      mask: { res: p.maskExportRes, sourceRes: p.maskRes, minDrop: p.maskMinDrop, lat: [], lon: [], drop: [] },
      tiles: { size: 1000, lat: [], lon: [], terrain: [], surface: [], anchors: [], roofCells: [], roadKills: [] },
      anchors: { lat: [], lon: [], ground: [], drop: [], open: [] },
      spots: Object.fromEntries(LINE_KINDS.map((k) => [k, empty()])),
      endpointsFeasible: 0,
      endpointsWalkable: 0,
      candidates: [],
      improved: 0,
      totalGain: 0,
      find: {
        pairsInRange: 0,
        pairsSectorPassed: 0,
        pairsLevelEnough: 0,
        pairsFeasible: 0,
        candidatesAfterDedup: 0,
      },
    }
    await writeRegion(area.aois, p, value, stamp)
    seeded++
    console.log(
      `  seeded ${regionId(area.aois)}: ${area.aois.length} aoi(s), ` +
        `${(((bbox.maxE - bbox.minE) * (bbox.maxN - bbox.minN)) / 1e6).toFixed(0)} km2, ` +
        `${area.aois.map((a) => `${a.south},${a.west}`).join(' + ')}`,
    )
  }
  console.log(
    seeded
      ? `\n${seeded} region(s) seeded empty, stamped ${stamp}.\n` +
          `Name their ground on the command line to search them for real.`
      : 'every region already has results; nothing to seed',
  )
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
