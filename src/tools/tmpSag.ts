import { dropField, loadCoarse } from '../pipeline/coarse.js'
import { DEFAULT_PARAMS as p } from '../pipeline/params.js'

/**
 * Where could a line of length L even exist? It sags sagRatio*L at midspan, so the terrain has to
 * fall that far below the anchor within about L/2. Counted on the coarse grid, over a sample of the
 * state chosen to include its hilliest ground.
 */
const windows = [
  { minE: 416000, minN: 5824000, maxE: 448000, maxN: 5856000 }, // Eberswalde, the best relief we have
  { minE: 360000, minN: 5800000, maxE: 392000, maxN: 5832000 }, // west of Berlin
  { minE: 448000, minN: 5720000, maxE: 480000, maxN: 5752000 }, // Lausitz
]
for (const L of [500, 800, 1200, 2000, 3000]) {
  const need = p.sagRatio * L + p.minClearance
  let cells = 0
  let ok = 0
  for (const w of windows) {
    const grown = { minE: w.minE - L, minN: w.minN - L, maxE: w.maxE + L, maxN: w.maxN + L }
    const drop = dropField(await loadCoarse(grown, p.maskRes), L / 2)
    for (const v of drop.data) {
      if (Number.isNaN(v)) continue
      cells++
      if (v >= need) ok++
    }
  }
  console.log(
    `${String(L).padStart(4)} m span: sags ${(p.sagRatio * L).toFixed(0)} m, needs a ` +
      `${need.toFixed(0)} m fall within ${L / 2} m -> ${((ok / cells) * 100).toFixed(3)}% of ground ` +
      `(${ok.toLocaleString()} of ${cells.toLocaleString()} cells)`,
  )
}
