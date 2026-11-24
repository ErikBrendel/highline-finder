import { useEffect, useRef, useState } from 'react'
import type { RigHeights } from '../shared/plan.js'
import type { LineSpec } from './planPoints.js'
import {
  defaultLineName, findLine, loadLibrary, merged, newId, normalized, rebased, sameAnchors, sameLines, storeLibrary,
  watchLibrary, type Library, type Spot, type SpotLine,
} from './spots.js'

/**
 * What the planner has open, and whether it may change it.
 *
 * Looking and editing are kept apart. A found line, a linked one, a saved one and the lines of a
 * shared spot are only looked at: their anchors and rig heights stay put, and the sag is a what-if
 * that is never stored. Only the draft line and a saved line opened for editing are written to.
 *
 * In a spot, `line` null is the spot with no line open, and `lines.length` a new one being placed.
 *
 * Editing a saved line holds it: until it is done, nothing else can be opened, so a change can never
 * land on a line other than the one the person set out to change. The draft line is editable without
 * holding anything, because it is never lost by looking elsewhere -- it stays stored and drawn.
 */
export type Open =
  | { kind: 'none' }
  | { kind: 'draft' }
  | { kind: 'found'; name: string | null }
  | { kind: 'spot'; spot: string; line: number | null; editing: boolean }
  | { kind: 'shared'; line: number | null }

/** What the link the page was opened with brings: a line, maybe named, and maybe a whole spot. */
export interface Arrival {
  line: LineSpec
  name: string | null
  spot: Spot | null
}

/** Edits closer together than this are one step of undo, so a drag is undone whole. */
const COALESCE_MS = 800

const DRAFT = 'draft'

type Snapshot = Spot | SpotLine | null

interface History {
  past: Snapshot[]
  future: Snapshot[]
  at: number
}

const sameRig = (p: RigHeights | null, q: RigHeights | null) =>
  p === q || (!!p && !!q && p.a === q.a && p.b === q.b)

/** Where the page starts: on what the link names, or back on the draft line. */
export function startingPoint(lib: Library, { line: { a, b }, name, spot: shared }: Arrival): {
  open: Open
  shared: Spot | null
} {
  const indexIn = (s: Spot) => {
    const i = a && b ? s.lines.findIndex((l) => sameAnchors(l, a, b)) : -1
    return i < 0 ? null : i
  }
  if (shared) {
    const held = lib.spots.find((s) => sameLines(s, shared))
    if (held) return { open: { kind: 'spot', spot: held.id, line: indexIn(held), editing: false }, shared: null }
    return { open: { kind: 'shared', line: indexIn(shared) }, shared }
  }
  if (a && b) {
    const saved = findLine(lib.spots, a, b)
    if (saved) return { open: { kind: 'spot', spot: saved.spot.id, line: saved.index, editing: false }, shared: null }
    if (lib.draft && sameAnchors(lib.draft, a, b)) return { open: { kind: 'draft' }, shared: null }
    return { open: { kind: 'found', name }, shared: null }
  }
  return { open: lib.draft ? { kind: 'draft' } : { kind: 'none' }, shared: null }
}

const same = (p: unknown, q: unknown) => JSON.stringify(p) === JSON.stringify(q)

/** The draft line and the spots whose stored state differs between two libraries. */
export function changedKeys(before: Library, after: Library): string[] {
  const ids = new Set([...before.spots, ...after.spots].map((s) => s.id))
  const spot = (lib: Library, id: string) => lib.spots.find((s) => s.id === id)
  return [
    ...(same(before.draft, after.draft) ? [] : [DRAFT]),
    ...[...ids].filter((id) => !same(spot(before, id), spot(after, id))),
  ]
}

/**
 * What stays open when another tab changes the library: the same line, found by its id since lines
 * before it may have come or gone. `reload` when the open line itself changed, so the planner shows
 * the other tab's version. A line being placed stays the one after the last.
 */
export function reopened(o: Open, before: Library, after: Library): { open: Open; reload: boolean } {
  if (o.kind === 'draft') {
    if (same(before.draft, after.draft)) return { open: o, reload: false }
    return { open: after.draft ? o : { kind: 'none' }, reload: true }
  }
  if (o.kind !== 'spot') return { open: o, reload: false }
  const was = before.spots.find((s) => s.id === o.spot)
  const now = after.spots.find((s) => s.id === o.spot)
  if (!now) return { open: { kind: 'none' }, reload: true }
  if (o.line === null || !was) return { open: o, reload: false }
  const held = was.lines[o.line]
  if (!held) return { open: { ...o, line: now.lines.length }, reload: false }
  const line = now.lines.findIndex((l) => l.id === held.id)
  if (line < 0) return { open: { ...o, line: null, editing: false }, reload: true }
  return { open: { ...o, line }, reload: !same(held, now.lines[line]) }
}

/**
 * The kept lines, what is open, and undo per spot and for the draft line.
 *
 * Other tabs keep the same library. Each write takes only this tab's change onto what is stored now,
 * and what another tab stores is taken in here as it happens. Undo of a spot or draft line another
 * tab changed is forgotten, so undoing here can never bring back what was overwritten there.
 *
 * `load` puts a line into the planner: the hook owns which line is open, the App owns the planner's
 * state, and every switch of line goes through here so the two cannot disagree. Everything the
 * planner then does to an editable line comes back through `sync`.
 */
export function useSpots(arrival: Arrival, load: (line: LineSpec | null) => void) {
  const [start] = useState(() => {
    const lib = loadLibrary()
    return { lib, ...startingPoint(lib, arrival) }
  })
  const [lib, setLib] = useState(start.lib)
  const [open, setOpen] = useState<Open>(start.open)
  const [shared, setShared] = useState(start.shared)
  const libRef = useRef(lib)
  const openRef = useRef(open)
  const sharedRef = useRef(shared)
  const histories = useRef(new Map<string, History>())
  const [, setVersion] = useState(0)

  const adopt = (next: Library) => {
    libRef.current = next
    setLib(next)
  }
  const commit = (next: Library) => {
    const stored = rebased(libRef.current, next, loadLibrary())
    adopt(stored)
    storeLibrary(stored)
  }
  const show = (next: Open) => {
    openRef.current = next
    setOpen(next)
  }
  const share = (next: Spot | null) => {
    sharedRef.current = next
    setShared(next)
  }
  const spotOf = (id: string, from = libRef.current) => from.spots.find((s) => s.id === id)
  const read = (key: string): Snapshot => (key === DRAFT ? libRef.current.draft : spotOf(key) ?? null)
  const write = (from: Library, key: string, value: Snapshot): Library =>
    key === DRAFT
      ? { ...from, draft: value as SpotLine | null }
      : { ...from, spots: from.spots.map((s) => (s.id === key ? (value as Spot) : s)) }

  const historyOf = (key: string) => {
    let h = histories.current.get(key)
    if (!h) histories.current.set(key, (h = { past: [], future: [], at: 0 }))
    return h
  }

  /** Changes the draft line or one spot, as a step of its undo unless it follows the last change closely. */
  const change = (key: string, next: Snapshot, coalesce = false) => {
    const h = historyOf(key)
    const now = Date.now()
    if (!coalesce || now - h.at > COALESCE_MS) h.past.push(read(key))
    h.at = coalesce ? now : 0
    h.future = []
    commit(write(libRef.current, key, next && 'lines' in next ? { ...next, edited: now } : next))
    setVersion((v) => v + 1)
  }
  const changeSpot = (id: string, edit: (s: Spot) => Spot, coalesce = false) => {
    const s = spotOf(id)
    if (s) change(id, edit(s), coalesce)
  }

  /** The stored line `o` points at, if it points at one. */
  const lineOf = (o: Open): SpotLine | null => {
    if (o.kind === 'draft') return libRef.current.draft
    if (o.kind === 'spot') return o.line === null ? null : spotOf(o.spot)?.lines[o.line] ?? null
    if (o.kind === 'shared') return o.line === null ? null : sharedRef.current?.lines[o.line] ?? null
    return null
  }
  const go = (next: Open) => {
    show(next)
    load(lineOf(next))
  }

  const undoKey = (o: Open) => (o.kind === 'draft' ? DRAFT : o.kind === 'spot' ? o.spot : null)

  const step = (back: boolean) => {
    const o = openRef.current
    const key = undoKey(o)
    if (!key) return
    const h = historyOf(key)
    const to = (back ? h.past : h.future).pop()
    if (to === undefined) return
    ;(back ? h.future : h.past).push(read(key))
    h.at = 0
    commit(write(libRef.current, key, to))
    if (o.kind === 'spot' && o.line !== null) {
      const gone = o.line >= (to as Spot).lines.length
      go(gone ? { ...o, line: null, editing: false } : o)
    } else go(to ? o : { kind: 'none' })
    setVersion((v) => v + 1)
  }

  /** What the planner did to the open line, written where it lives if it may be changed. */
  const sync = ({ a, b, rig, sag }: LineSpec) => {
    if (!a || !b) return
    const o = openRef.current
    const held = lineOf(o)
    if (held && sameAnchors(held, a, b) && sameRig(held.rig, rig) && held.sag === sag) return
    const name = !held || held.name === defaultLineName(held.a, held.b) ? defaultLineName(a, b) : held.name
    const line: SpotLine = { id: held?.id ?? newId(), name, a, b, rig, sag }
    if (o.kind === 'draft') change(DRAFT, line, true)
    if (o.kind === 'spot' && o.editing && o.line !== null) {
      const at = o.line
      changeSpot(o.spot, (s) => {
        const lines = [...s.lines]
        lines[at] = line
        return { ...s, lines }
      }, true)
    }
  }

  function removeSpot(id: string) {
    commit({ ...libRef.current, spots: libRef.current.spots.filter((s) => s.id !== id) })
    histories.current.delete(id)
    const o = openRef.current
    if (o.kind === 'spot' && o.spot === id) go({ kind: 'none' })
  }

  useEffect(
    () =>
      watchLibrary((theirs) => {
        const before = normalized(libRef.current)
        for (const key of changedKeys(before, theirs)) histories.current.delete(key)
        adopt(theirs)
        const { open: next, reload } = reopened(openRef.current, before, theirs)
        if (reload) go(next)
        else show(next)
        setVersion((v) => v + 1)
      }),
    [],
  )

  const held = () => {
    const o = openRef.current
    return o.kind === 'spot' && o.editing
  }

  const key = undoKey(open)
  const h = key ? histories.current.get(key) : undefined
  const spot = open.kind === 'spot' ? spotOf(open.spot, lib) ?? null : open.kind === 'shared' ? shared : null
  const active =
    open.kind === 'draft' ? lib.draft
    : open.kind === 'spot' || open.kind === 'shared' ? (open.line === null ? null : spot?.lines[open.line] ?? null)
    : null

  return {
    lib,
    open,
    shared,
    /** The saved or shared spot that is open, if one is. */
    spot,
    /** The stored line that is open, if it is a stored one. */
    active,
    /** Whether the open line's anchors and rig may be changed, and its changes are kept. */
    editable: open.kind === 'draft' || (open.kind === 'spot' && open.editing),
    /** A saved line is being edited, and nothing else may be opened until that is done. */
    holding: open.kind === 'spot' && open.editing,
    canUndo: !!h?.past.length,
    canRedo: !!h?.future.length,
    sync,
    undo: () => step(true),
    redo: () => step(false),
    openDraft: () => {
      if (libRef.current.draft && !held()) go({ kind: 'draft' })
    },
    /** A found or linked line is being looked at; the planner already holds it. */
    viewFound: (name: string | null = null) => show({ kind: 'found', name }),
    openLine: (id: string, line: number) => {
      if (!held()) go({ kind: 'spot', spot: id, line, editing: false })
    },
    openSpot: (id: string) => {
      const o = openRef.current
      if (held() || (o.kind === 'spot' && o.spot === id)) return
      go({ kind: 'spot', spot: id, line: null, editing: false })
    },
    openShared: (line: number | null) => {
      if (!held()) go({ kind: 'shared', line })
    },
    /**
     * Starts changing what is open. A found line becomes the draft line, replacing it; a saved one
     * is changed where it is. `current` is the planner's line, so a what-if sag is kept.
     */
    edit: (current: LineSpec) => {
      const o = openRef.current
      if (o.kind === 'found' && current.a && current.b) {
        const { a, b, rig, sag } = current
        change(DRAFT, { id: newId(), name: o.name ?? defaultLineName(a, b), a, b, rig, sag })
        show({ kind: 'draft' })
        return
      }
      if (o.kind !== 'spot') return
      show({ ...o, editing: true })
      sync(current)
    },
    done: () => {
      const o = openRef.current
      if (o.kind === 'spot') show({ ...o, editing: false })
    },
    /** The first point of a new line is down: as a new line of the open spot, or as the new draft line. */
    beginNewLine: () => {
      const o = openRef.current
      if (o.kind === 'spot') return show({ ...o, line: spotOf(o.spot)?.lines.length ?? 0, editing: true })
      if (libRef.current.draft) change(DRAFT, null)
      show({ kind: 'draft' })
    },
    /** Closes the open line, deleting nothing: a kept line stays where it is, drawn on the map. */
    close: () => {
      const o = openRef.current
      if (held()) return
      go(o.kind === 'spot' || o.kind === 'shared' ? { ...o, line: null } : { kind: 'none' })
    },
    /** Empties the draft line. Undoable. */
    discardDraft: () => {
      if (!libRef.current.draft) return
      change(DRAFT, null)
      if (openRef.current.kind === 'draft') go({ kind: 'none' })
    },
    /** Out of the open spot or draft, with nothing open. */
    leaveSpot: () => {
      if (!held()) go({ kind: 'none' })
    },
    renameActive: (name: string) => {
      const o = openRef.current
      if (o.kind === 'found') return show({ ...o, name })
      if (o.kind === 'draft' && libRef.current.draft) return change(DRAFT, { ...libRef.current.draft, name }, true)
      if (o.kind === 'spot' && o.line !== null) {
        const at = o.line
        changeSpot(o.spot, (s) => ({ ...s, lines: s.lines.map((l, i) => (i === at ? { ...l, name } : l)) }), true)
      }
    },
    renameSpot: (id: string, name: string) => changeSpot(id, (s) => ({ ...s, name }), true),
    removeLine: (id: string, index: number) => {
      const s = spotOf(id)
      if (!s) return
      if (s.lines.length === 1) return removeSpot(id)
      changeSpot(id, (sp) => ({ ...sp, lines: sp.lines.filter((_, i) => i !== index) }))
      const o = openRef.current
      if (o.kind !== 'spot' || o.spot !== id || o.line === null) return
      go({ ...o, line: o.line === index ? null : o.line > index ? o.line - 1 : o.line })
    },
    removeSpot,
    /**
     * Keeps the open draft or found line: as a spot of its own, or added to `into`. A saved draft
     * line leaves the draft. The saved line is open afterwards, to look at.
     */
    save: ({ into, lineName, spotName }: { into: string | null; lineName: string; spotName?: string }, current: LineSpec) => {
      const o = openRef.current
      const { a, b, rig, sag } = current
      if ((o.kind !== 'draft' && o.kind !== 'found') || !a || !b) return
      const line: SpotLine = { id: newId(), name: lineName, a, b, rig, sag }
      if (o.kind === 'draft') change(DRAFT, null)
      const target = into ? spotOf(into) : undefined
      if (target) {
        changeSpot(target.id, (s) => ({ ...s, name: spotName ?? s.name, lines: [...s.lines, line] }))
        show({ kind: 'spot', spot: target.id, line: target.lines.length, editing: false })
        return
      }
      const saved: Spot = { id: newId(), name: spotName ?? '', lines: [line], edited: Date.now() }
      commit({ ...libRef.current, spots: [...libRef.current.spots, saved] })
      show({ kind: 'spot', spot: saved.id, line: 0, editing: false })
    },
    /** Keeps the shared spot as one of the saved ones. */
    saveShared: () => {
      const s = sharedRef.current
      const o = openRef.current
      if (!s) return
      const saved = { ...s, id: newId(), edited: Date.now() }
      commit({ ...libRef.current, spots: [...libRef.current.spots, saved] })
      share(null)
      show({ kind: 'spot', spot: saved.id, line: o.kind === 'shared' ? o.line : null, editing: false })
    },
    dismissShared: () => {
      share(null)
      if (openRef.current.kind === 'shared') go({ kind: 'none' })
    },
    /** Adds what is new among `spots`; see `merged`. Returns how many came in. */
    importSpots: (spots: Spot[]) => {
      const { spots: next, added } = merged(libRef.current.spots, spots)
      commit({ ...libRef.current, spots: next })
      return added
    },
  }
}

export type Spots = ReturnType<typeof useSpots>
