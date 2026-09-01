import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { shipped } from '../pipeline/shipped.js'
import { LINE_KINDS, type Candidate, type Dataset } from '../shared/types.js'

/**
 * Rewrites the committed candidates.json through `shipped`, once.
 *
 * `npm run shrink:dataset`. The pipeline now writes lines at the precision they are read at, but
 * the file in the repository was written before it did, and regenerating it the honest way means
 * six and a half hours of searching to arrive at the same lines with shorter numbers in them.
 *
 * Idempotent, and safe to run against a file the pipeline has already written: rounding a rounded
 * number is the same number, so a second run reports no change rather than doing damage.
 */

const OUT = new URL('../web/public/candidates.json', import.meta.url).pathname
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`

async function main() {
  const before = await readFile(OUT, 'utf8')
  const data = JSON.parse(before) as Dataset
  for (const kind of LINE_KINDS) {
    data.lines[kind] = data.lines[kind].map((c) => shipped({ ...c, kind }) as Candidate)
  }
  const after = JSON.stringify(data)
  await writeFile(OUT, after)
  const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).byteLength
  console.log(
    `candidates.json ${mb(before.length)} -> ${mb(after.length)}` +
      ` (gzipped ${mb(gz(before))} -> ${mb(gz(after))})`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
