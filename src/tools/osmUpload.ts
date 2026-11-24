import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Publishes what `npm run osm` built in data/osm/ to the R2 bucket the proxy Worker serves as /osm/.
 *
 * Blocks first, under their build's version, then the index naming that version. Until the index is
 * replaced every browser reads the previous build whole, and after it the new one whole; a block is
 * never overwritten, so the year-long cache on it is safe.
 *
 * `--prune` then deletes every version but the newest two. The index is cached for five minutes, so
 * the one before is still being read by tabs opened just before the swap; prune on the next update.
 *
 * Talks to R2 through its S3 API with the aws CLI. See ROADMAP.md, "R2 for the OSM blocks".
 */

const BUCKET = 'highline-finder-osm'
/** The local aws profile holding an R2 API token's key pair, scoped to this bucket. */
const PROFILE = 'cloudflare-private-r2'
const ACCOUNT = '053ba900a5229724c70287fff3635098'
const DIR = new URL('../../data/osm/', import.meta.url).pathname
const S3 = `s3://${BUCKET}/osm`

const aws = (...args: string[]) =>
  execFileSync('aws', [...args, '--profile', PROFILE, '--endpoint-url', `https://${ACCOUNT}.r2.cloudflarestorage.com`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

async function main(): Promise<void> {
  const index = JSON.parse(await readFile(join(DIR, 'index.json'), 'utf8')) as { version: string; blocks: string[] }
  const files = new Set(await readdir(join(DIR, index.version)))
  const missing = index.blocks.filter((key) => !files.has(`${key}.bin`))
  if (missing.length || files.size !== index.blocks.length) {
    throw new Error(`data/osm/ does not match its index (${missing.length} missing, ${files.size} files): rebuild it`)
  }

  console.log(`uploading ${files.size} blocks of ${index.version}`)
  aws('s3', 'sync', join(DIR, index.version), `${S3}/${index.version}/`, '--only-show-errors',
    '--content-type', 'application/octet-stream', '--cache-control', 'public, max-age=31536000, immutable')
  aws('s3', 'cp', join(DIR, 'index.json'), `${S3}/index.json`, '--only-show-errors',
    '--content-type', 'application/json', '--cache-control', 'public, max-age=300')
  console.log(`index now names ${index.version}`)

  if (!process.argv.includes('--prune')) return
  const versions = aws('s3', 'ls', `${S3}/`)
    .split('\n')
    .map((l) => /PRE (\S+)\/$/.exec(l.trim())?.[1])
    .filter((v): v is string => !!v)
    .sort()
  for (const old of versions.slice(0, -2)) {
    console.log(`pruning ${old}`)
    aws('s3', 'rm', `${S3}/${old}/`, '--recursive', '--only-show-errors')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
