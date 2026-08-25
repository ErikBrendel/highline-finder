import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { PbfReader } from 'pbf'

/**
 * Reads an OpenStreetMap PBF extract.
 *
 * The file is a flat sequence of length-prefixed blobs. Each blob inflates to a PrimitiveBlock
 * holding a string table and some groups of nodes, ways or relations. Coordinates are stored as
 * running differences in nanodegrees, scaled by the block's own granularity -- so nothing can be
 * read out of order and every block has to be walked in full.
 *
 * Why this rather than Overpass. The public Overpass API is a shared service with a rate limit, and
 * asking it for the road network of a whole state got this project's machine refused outright. An
 * extract is one download, has no limit, is the same OpenStreetMap database, and once reduced to
 * what the search needs it can be committed and shipped -- so the deployed site depends on nothing
 * at run time. See src/tools/osmRefresh.ts.
 *
 * Why this rather than the Geofabrik shapefile, which needs no protobuf at all: the free shapefile
 * drops `lanes`, `width`, `tracktype` and `service`, which are exactly the tags the width rule and
 * the track rule read, and that loss would be permanent.
 *
 * The protobuf primitives come from Mapbox's `pbf` rather than from a reader written here. A hand
 * written one worked and was tested, and the argument against keeping it is what a bug in it looks
 * like: not an exception, but roads placed silently in the wrong spot. `pbf` decodes every vector
 * tile on the web. The OSM-specific half below is domain code either way.
 */

/** A way, with its tags resolved and its node references still unresolved. */
export interface PbfWay {
  id: number
  tags: Record<string, string>
  refs: number[]
}

/** A relation's members, enough to stitch a multipolygon outline out of its member ways. */
export interface PbfRelation {
  id: number
  tags: Record<string, string>
  members: { ref: number; type: number; role: string }[]
}

export type NodeVisitor = (id: number, lat: number, lon: number) => void

/** Relation member types, as PBF numbers them. */
export const MEMBER_WAY = 1

/**
 * Every OSMData blob in the file, inflated, one at a time.
 *
 * The whole file is read into one buffer and walked with a cursor rather than streamed. Streaming
 * meant re-concatenating the pending bytes on every chunk, which is quadratic and turned a
 * six-second pass into one that had not finished after ten minutes. 285 MB in a Buffer sits off the
 * JS heap and costs nothing to hold; only one inflated block exists at a time, which is the part
 * that actually matters.
 */
function* blocks(path: string): Generator<Uint8Array> {
  const buf = readFileSync(path)
  let at = 0
  while (at + 4 <= buf.length) {
    const headerLen = buf.readUInt32BE(at)
    at += 4
    const header = readBlobHeader(buf.subarray(at, at + headerLen))
    at += headerLen
    const blob = buf.subarray(at, at + header.size)
    at += header.size
    if (header.type === 'OSMData') yield inflateBlob(blob)
  }
}

/** BlobHeader: 1 = type (string), 3 = datasize (int32). */
function readBlobHeader(buf: Uint8Array): { type: string; size: number } {
  return new PbfReader(buf).readFields(
    (tag: number, out: { type: string; size: number }, p: PbfReader) => {
      if (tag === 1) out.type = p.readString()
      else if (tag === 3) out.size = p.readVarint()
    },
    { type: '', size: 0 },
  )
}

/** Blob: 1 = raw bytes, 3 = zlib-compressed bytes. Bulk producers always compress. */
function inflateBlob(buf: Uint8Array): Uint8Array {
  const out = new PbfReader(buf).readFields<{ raw: Uint8Array | null }>(
    (tag: number, o: { raw: Uint8Array | null }, p: PbfReader) => {
      if (tag === 1) o.raw = p.readBytes()
      else if (tag === 3) o.raw = inflateSync(p.readBytes())
    },
    { raw: null },
  )
  if (!out.raw) throw new Error('blob has neither raw nor zlib payload')
  return out.raw
}

interface Block {
  strings: string[]
  /** Byte ranges of each PrimitiveGroup within the block, walked after the string table is known. */
  groups: [number, number][]
  granularity: number
  latOffset: number
  lonOffset: number
  buf: Uint8Array
}

/**
 * PrimitiveBlock: 1 = stringtable, 2 = groups, 17 = granularity, 19/20 = coordinate offsets.
 *
 * Groups are recorded as offsets rather than decoded in place, because a group cannot be read until
 * the string table is, and protobuf fields may arrive in any order.
 */
function readBlock(buf: Uint8Array): Block {
  const out: Block = {
    strings: [],
    groups: [],
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
    buf,
  }
  new PbfReader(buf).readFields((tag: number, o: Block, p: PbfReader) => {
    if (tag === 1) {
      p.readMessage((t: number, table: string[], q: PbfReader) => {
        if (t === 1) table.push(q.readString())
      }, o.strings)
    } else if (tag === 2) {
      const len = p.readVarint()
      o.groups.push([p.pos, p.pos + len])
      p.pos += len
    } else if (tag === 17) o.granularity = p.readVarint()
    // int64, so signed. `pbf` handles the ten-byte two's-complement form; every bulk producer
    // writes 0 here anyway, and the refresh script checks the coordinates against the bounds.
    else if (tag === 19) o.latOffset = p.readVarint(true)
    else if (tag === 20) o.lonOffset = p.readVarint(true)
    else p.skip(p.type)
  }, out)
  return out
}

function readWay(p: PbfReader, end: number, strings: string[]): PbfWay {
  const keys: number[] = []
  const vals: number[] = []
  const w: PbfWay = { id: 0, tags: {}, refs: [] }
  let acc = 0
  p.readFields(
    (tag: number, _o: null, q: PbfReader) => {
      if (tag === 1) w.id = q.readVarint()
      else if (tag === 2) q.readPackedVarint(keys)
      else if (tag === 3) q.readPackedVarint(vals)
      else if (tag === 8) {
        // Node references are stored as running differences.
        for (const d of q.readPackedSVarint()) {
          acc += d
          w.refs.push(acc)
        }
      } else q.skip(q.type)
    },
    null,
    end,
  )
  for (let i = 0; i < keys.length; i++) w.tags[strings[keys[i]!]!] = strings[vals[i]!]!
  return w
}

function readRelation(p: PbfReader, end: number, strings: string[]): PbfRelation {
  const keys: number[] = []
  const vals: number[] = []
  const roles: number[] = []
  const types: number[] = []
  const ids: number[] = []
  const rel: PbfRelation = { id: 0, tags: {}, members: [] }
  let acc = 0
  p.readFields(
    (tag: number, _o: null, q: PbfReader) => {
      if (tag === 1) rel.id = q.readVarint()
      else if (tag === 2) q.readPackedVarint(keys)
      else if (tag === 3) q.readPackedVarint(vals)
      else if (tag === 8) q.readPackedVarint(roles)
      else if (tag === 9) {
        for (const d of q.readPackedSVarint()) {
          acc += d
          ids.push(acc)
        }
      } else if (tag === 10) q.readPackedVarint(types)
      else q.skip(q.type)
    },
    null,
    end,
  )
  for (let i = 0; i < keys.length; i++) rel.tags[strings[keys[i]!]!] = strings[vals[i]!]!
  for (let i = 0; i < ids.length; i++) {
    rel.members.push({ ref: ids[i]!, type: types[i] ?? 0, role: strings[roles[i]!] ?? '' })
  }
  return rel
}

/**
 * One pass over every way and relation. Nodes are skipped entirely, which is most of the file.
 *
 * Nothing is buffered: whether a million roads need holding in memory is the caller's problem, and
 * the caller is the only one that knows which of them it wants.
 */
export function readWaysAndRelations(
  path: string,
  onWay: (w: PbfWay) => void,
  onRelation: (r: PbfRelation) => void,
): void {
  for (const raw of blocks(path)) {
    const block = readBlock(raw)
    for (const [from, to] of block.groups) {
      const p = new PbfReader(block.buf)
      p.pos = from
      while (p.pos < to) {
        const tag = p.readVarint()
        const field = tag >> 3
        if (field === 3) {
          const len = p.readVarint()
          const end = p.pos + len
          onWay(readWay(p, end, block.strings))
          p.pos = end
        } else if (field === 4) {
          const len = p.readVarint()
          const end = p.pos + len
          onRelation(readRelation(p, end, block.strings))
          p.pos = end
        } else p.skip(tag & 7)
      }
    }
  }
}

/**
 * One pass over every node.
 *
 * DenseNodes only. The plain Node message is legal PBF and no bulk producer emits it; if one ever
 * does the geometry would be silently incomplete, so the count of them is returned to be checked.
 */
export function readNodes(path: string, visit: NodeVisitor): { dense: number; plain: number } {
  let dense = 0
  let plain = 0
  for (const raw of blocks(path)) {
    const block = readBlock(raw)
    for (const [from, to] of block.groups) {
      const p = new PbfReader(block.buf)
      p.pos = from
      while (p.pos < to) {
        const tag = p.readVarint()
        const field = tag >> 3
        if (field === 1) {
          plain++
          p.skip(tag & 7)
        } else if (field === 2) {
          const len = p.readVarint()
          const end = p.pos + len
          dense += readDense(p, end, block, visit)
          p.pos = end
        } else p.skip(tag & 7)
      }
    }
  }
  return { dense, plain }
}

/** DenseNodes: 1 = packed delta ids, 8 = packed delta lat, 9 = packed delta lon. */
function readDense(p: PbfReader, end: number, block: Block, visit: NodeVisitor): number {
  const ids: number[] = []
  const lats: number[] = []
  const lons: number[] = []
  p.readFields(
    (tag: number, _o: null, q: PbfReader) => {
      if (tag === 1) accumulate(q.readPackedSVarint(), ids)
      else if (tag === 8) accumulate(q.readPackedSVarint(), lats)
      else if (tag === 9) accumulate(q.readPackedSVarint(), lons)
      else q.skip(q.type)
    },
    null,
    end,
  )
  // lat = 1e-9 * (lat_offset + granularity * delta), and the same for lon.
  const g = block.granularity
  for (let i = 0; i < ids.length; i++) {
    visit(ids[i]!, (block.latOffset + g * lats[i]!) * 1e-9, (block.lonOffset + g * lons[i]!) * 1e-9)
  }
  return ids.length
}

function accumulate(deltas: number[], into: number[]): void {
  let acc = 0
  for (const d of deltas) {
    acc += d
    into.push(acc)
  }
}
