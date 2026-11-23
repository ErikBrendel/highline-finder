import { useRef, useState } from 'react'
import type { RigHeights } from '../shared/plan.js'
import type { LineSpec } from './planPoints.js'
import {
  defaultLineName, emptySpot, findLine, loadLibrary, merged, newId, sameAnchors, storeLibrary,
  type Library, type Spot, type SpotLine,
} from './spots.js'

/** The spot being worked in, and which of its lines; `lines.length` is a line not placed yet. */
export interface Working {
  spot: string
  line: number
}

/** Edits closer together than this are one step of undo, so a drag is undone whole. */
const COALESCE_MS = 800

interface History {
  past: Spot[]
  future: Spot[]
  at: number
}

const sameRig = (p: RigHeights | null, q: RigHeights | null) =>
  p === q || (!!p && !!q && p.a === q.a && p.b === q.b)

/**
 * Where the page starts: on the saved line the URL names, or in the draft.
 *
 * A line in the URL that is nowhere saved replaces the draft, and the draft it replaced is the first
 * step of undo.
 */
export function startingPoint(lib: Library, url: LineSpec): { lib: Library; working: Working; replaced: Spot | null } {
  const { a, b } = url
  if (a && b) {
    const saved = findLine(lib.spots, a, b)
    if (saved) return { lib, working: { spot: saved.spot.id, line: saved.index }, replaced: null }
    const inDraft = lib.draft.lines.findIndex((l) => sameAnchors(l, a, b))
    if (inDraft >= 0) return { lib, working: { spot: lib.draft.id, line: inDraft }, replaced: null }
    if (!lib.draft.lines.length) return { lib, working: { spot: lib.draft.id, line: 0 }, replaced: null }
    const draft = { ...emptySpot(), id: lib.draft.id }
    return { lib: { ...lib, draft }, working: { spot: draft.id, line: 0 }, replaced: lib.draft }
  }
  return { lib, working: { spot: lib.draft.id, line: Math.max(0, lib.draft.lines.length - 1) }, replaced: null }
}

/**
 * The spots, the one being worked in, and undo per spot.
 *
 * `load` puts a line into the planner: the hook owns which line is active, the App owns the planner's
 * state, and every switch of line goes through here so the two cannot disagree. Everything the
 * planner then does to the line comes back through `sync`.
 */
export function useSpots(url: LineSpec, load: (line: SpotLine | null) => void) {
  const [start] = useState(() => startingPoint(loadLibrary(), url))
  const [lib, setLib] = useState(start.lib)
  const [working, setWorking] = useState(start.working)
  const libRef = useRef(lib)
  const workingRef = useRef(working)
  const histories = useRef(new Map<string, History>(
    start.replaced ? [[start.lib.draft.id, { past: [start.replaced], future: [], at: 0 }]] : [],
  ))
  const [, setVersion] = useState(0)

  const commit = (next: Library) => {
    libRef.current = next
    setLib(next)
    storeLibrary(next)
  }
  const work = (next: Working) => {
    workingRef.current = next
    setWorking(next)
  }
  const spotOf = (id: string, from = libRef.current) =>
    id === from.draft.id ? from.draft : from.spots.find((s) => s.id === id)
  const replace = (from: Library, spot: Spot): Library =>
    spot.id === from.draft.id
      ? { ...from, draft: spot }
      : { ...from, spots: from.spots.map((s) => (s.id === spot.id ? spot : s)) }

  const historyOf = (id: string) => {
    let h = histories.current.get(id)
    if (!h) histories.current.set(id, (h = { past: [], future: [], at: 0 }))
    return h
  }

  /** Changes one spot, as a step of its undo unless it follows the last change closely. */
  const change = (id: string, edit: (s: Spot) => Spot, coalesce = false) => {
    const before = spotOf(id)
    if (!before) return
    const h = historyOf(id)
    const now = Date.now()
    if (!coalesce || now - h.at > COALESCE_MS) h.past.push(before)
    h.at = coalesce ? now : 0
    h.future = []
    commit(replace(libRef.current, { ...edit(before), edited: now }))
    setVersion((v) => v + 1)
  }

  const open = (spot: string, line: number) => {
    work({ spot, line })
    load(spotOf(spot)?.lines[line] ?? null)
  }

  /** What the planner did to the active line, written into its spot. */
  const sync = ({ a, b, rig, sag }: LineSpec) => {
    if (!a || !b) return
    const { spot: id, line: index } = workingRef.current
    const spot = spotOf(id)
    if (!spot) return
    const held = spot.lines[index]
    if (held && sameAnchors(held, a, b) && sameRig(held.rig, rig) && held.sag === sag) return
    change(id, (s) => {
      const lines = [...s.lines]
      const name = !held || held.name === defaultLineName(held.a, held.b) ? defaultLineName(a, b) : held.name
      lines[index] = { id: held?.id ?? newId(), name, a, b, rig, sag }
      return { ...s, lines }
    }, true)
  }

  const step = (back: boolean) => {
    const { spot: id, line } = workingRef.current
    const h = historyOf(id)
    const current = spotOf(id)
    const to = (back ? h.past : h.future).pop()
    if (!to || !current) return
    ;(back ? h.future : h.past).push(current)
    h.at = 0
    commit(replace(libRef.current, to))
    const index = Math.min(line, Math.max(0, to.lines.length - 1))
    work({ spot: id, line: index })
    load(to.lines[index] ?? null)
    setVersion((v) => v + 1)
  }

  const isDraft = working.spot === lib.draft.id
  const spot = spotOf(working.spot, lib) ?? lib.draft
  const h = histories.current.get(working.spot)

  return {
    lib,
    working,
    spot,
    isDraft,
    canUndo: !!h?.past.length,
    canRedo: !!h?.future.length,
    open,
    sync,
    undo: () => step(true),
    redo: () => step(false),
    /** Back to the draft, as it was left. */
    toDraft: () => {
      if (workingRef.current.spot === libRef.current.draft.id) return
      const draft = libRef.current.draft
      open(draft.id, Math.max(0, draft.lines.length - 1))
    },
    /** A new line in the spot being worked in, to be placed. */
    addLine: () => {
      const { spot: id } = workingRef.current
      work({ spot: id, line: spotOf(id)?.lines.length ?? 0 })
      load(null)
    },
    /** No line active, the spot still open. */
    deselect: () => {
      const { spot: id } = workingRef.current
      work({ spot: id, line: spotOf(id)?.lines.length ?? 0 })
    },
    renameLine: (id: string, index: number, name: string) =>
      change(id, (s) => ({ ...s, lines: s.lines.map((l, i) => (i === index ? { ...l, name } : l)) }), true),
    renameSpot: (id: string, name: string) => change(id, (s) => ({ ...s, name }), true),
    removeLine: (id: string, index: number) => {
      const s = spotOf(id)
      if (!s) return
      if (s.lines.length === 1 && id !== libRef.current.draft.id) return removeSpot(id)
      change(id, (sp) => ({ ...sp, lines: sp.lines.filter((_, i) => i !== index) }))
      const w = workingRef.current
      if (w.spot !== id) return
      const line = Math.max(0, Math.min(w.line > index ? w.line - 1 : w.line, s.lines.length - 2))
      open(id, line)
    },
    removeSpot,
    /** Empties the draft. Undoable. */
    discardDraft: () => {
      const id = libRef.current.draft.id
      change(id, (s) => ({ ...s, name: '', lines: [] }))
      if (workingRef.current.spot === id) open(id, 0)
    },
    /**
     * Keeps the draft: as a spot of its own, or added to `into`. The draft is emptied and the
     * saved spot is the one being worked in from then on.
     */
    save: ({ into, lineName, spotName }: { into: string | null; lineName?: string; spotName?: string }) => {
      const from = libRef.current
      const draft = from.draft
      if (!draft.lines.length) return
      const lines = draft.lines.map((l, i) =>
        lineName !== undefined && i === Math.min(workingRef.current.line, draft.lines.length - 1)
          ? { ...l, name: lineName }
          : l,
      )
      const target = into ? from.spots.find((s) => s.id === into) : undefined
      const offset = target?.lines.length ?? 0
      const saved: Spot = target
        ? { ...target, name: spotName ?? target.name, lines: [...target.lines, ...lines], edited: Date.now() }
        : { id: newId(), name: spotName ?? '', lines, edited: Date.now() }
      if (target) historyOf(target.id).past.push(target)
      historyOf(draft.id).past.push(draft)
      commit({
        spots: target ? from.spots.map((s) => (s.id === target.id ? saved : s)) : [...from.spots, saved],
        draft: { ...draft, name: '', lines: [], edited: Date.now() },
      })
      work({ spot: saved.id, line: offset + Math.min(workingRef.current.line, lines.length - 1) })
      setVersion((v) => v + 1)
    },
    /** Adds what is new among `spots`; see `merged`. Returns how many came in. */
    importSpots: (spots: Spot[]) => {
      const { spots: next, added } = merged(libRef.current.spots, spots)
      commit({ ...libRef.current, spots: next })
      return added
    },
  }

  function removeSpot(id: string) {
    commit({ ...libRef.current, spots: libRef.current.spots.filter((s) => s.id !== id) })
    histories.current.delete(id)
    if (workingRef.current.spot !== id) return
    const draft = libRef.current.draft
    open(draft.id, Math.max(0, draft.lines.length - 1))
  }
}

export type Spots = ReturnType<typeof useSpots>
