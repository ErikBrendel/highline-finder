import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { shipped } from '../pipeline/shipped.js'
import { LINE_KINDS, type ByKind, type Candidate, type Dataset } from '../shared/types.js'

/**
 * Rewrites a committed candidates.json into the shape the pipeline writes now, once.
 *
 * `npm run reshape`. Two conversions have landed since the file in the repository was generated,
 * and regenerating it the honest way means six and a half hours of searching to arrive at exactly
 * the same lines:
 *
 *   - numbers at the precision they are read at rather than the precision they were computed at,
 *     which is `shipped` and is described there;
 *   - the metadata split out into meta.json, so the filter panel and the planner are usable while
 *     the lines are still on the wire.
 *
 * Idempotent. Run against a file the current pipeline wrote, it finds no `meta` to move and no
 * digits to drop, and says so rather than doing damage.
 */

const OUT = new URL('../web/public/candidates.json', import.meta.url).pathname
const META_OUT = new URL('../web/public/meta.json', import.meta.url).pathname
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`
const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).byteLength

/** The largest value in the set, rounded up, never below `floor`. Mirrors `ceilOver` in run.ts. */
const ceilOver = (of: Candidate[], pick: (c: Candidate) => number, floor: number) =>
  Math.ceil(of.reduce((m, c) => Math.max(m, pick(c)), floor))

async function main() {
  const before = await readFile(OUT, 'utf8')
  const data = JSON.parse(before) as Dataset
  if (!data.meta) {
    console.log('candidates.json holds only lines already -- nothing to move into meta.json')
    return
  }

  const lines = {} as ByKind<Candidate[]>
  const all: Candidate[] = []
  for (const kind of LINE_KINDS) {
    lines[kind] = data.lines[kind].map((c) => shipped({ ...c, kind }) as Candidate)
    all.push(...lines[kind].map((c) => ({ ...c, kind })))
  }

  const meta: Dataset['meta'] = {
    ...data.meta,
    lineCounts: Object.fromEntries(
      LINE_KINDS.map((k) => [k, lines[k].length]),
    ) as ByKind<number>,
    ranges: {
      score: ceilOver(all, (c) => c.score, 1),
      length: ceilOver(all, (c) => c.length, 100),
      exposure: ceilOver(all, (c) => c.exposure, 10),
    },
  }

  const metaText = JSON.stringify(meta)
  const linesText = JSON.stringify({ lines })
  await writeFile(META_OUT, metaText)
  await writeFile(OUT, linesText)
  console.log(
    `${mb(before.length)} (${mb(gz(before))} gzipped) ->\n` +
      `  meta.json        ${mb(metaText.length)} (${mb(gz(metaText))} gzipped)\n` +
      `  candidates.json  ${mb(linesText.length)} (${mb(gz(linesText))} gzipped)`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
