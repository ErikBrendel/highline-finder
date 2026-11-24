import { useEffect, useRef, useState } from 'react'
import type { RigHeights } from '../shared/plan.js'
import type { LineSpec } from './planPoints.js'
import {
  defaultLineName, exportText, findLine, isShell, loadLibrary, merged, newId, normalized, opened, rebased, sameAnchors,
  sameLines, sealedForm, spotOfText, spotText, storeLibrary, watchLibrary, type ExportFile, type Library, type Spot,
  type SpotLine,
} from './spots.js'
import { report } from './report.js'
import {
  loadSealed, loadVault, newVault, openVault, seal, storeSealed, storeVault, unseal, watchVault, type Vault,
} from './vault.js'

/**
 * What the planner has open, and whether it may change it.
 *
 * Looking and editing are kept apart. A found line, a linked one, a saved one and the lines of a
 * shared spot are only looked at: their anchors and rig heights stay put, and the sag is a what-if
 * that is never stored. Only the draft line and a saved line opened for editing are written to.
 *
 * In a spot, `line` null is the spot with no line open. A new line is always placed as the draft
 * line, never straight into a spot, so one can never land in the spot that happened to be open.
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

/** The library without the secret spots, unless they are shown. A shell is never shown. */
export const visibleOf = (lib: Library, shown: boolean): Library => ({
  ...lib,
  spots: lib.spots.filter((s) => !s.secret || (shown && !isShell(s))),
})

/** Where a line of a spot can be moved: the draft line, a spot of its own, or another spot. */
export type MoveTarget = { kind: 'draft' } | { kind: 'own' } | { kind: 'spot'; id: string }

/**
 * A line taken out of its spot, to the draft line, a spot of its own or another spot, and what to
 * open afterwards: the line where it now is. A spot left empty goes. Null where the move cannot be
 * made, which includes onto a draft line already there, since that would replace it.
 */
export function movedLine(lib: Library, from: string, index: number, to: MoveTarget): { lib: Library; open: Open } | null {
  const source = lib.spots.find((s) => s.id === from)
  const moved = source?.lines[index]
  if (!source || !moved || (to.kind === 'draft' && lib.draft)) return null
  if (to.kind === 'spot' && (to.id === from || !lib.spots.some((s) => s.id === to.id))) return null
  const now = Date.now()
  const rest = source.lines.filter((_, i) => i !== index)
  let spots = lib.spots.flatMap((s) => (s.id !== from ? [s] : rest.length ? [{ ...s, lines: rest, edited: now }] : []))
  if (to.kind === 'draft') return { lib: { spots, draft: moved }, open: { kind: 'draft' } }
  if (to.kind === 'own') {
    const own: Spot = { id: newId(), name: '', lines: [moved], edited: now, secret: source.secret }
    return { lib: { ...lib, spots: [...spots, own] }, open: { kind: 'spot', spot: own.id, line: 0, editing: false } }
  }
  spots = spots.map((s) => (s.id === to.id ? { ...s, lines: [...s.lines, moved], edited: now } : s))
  const line = spots.find((s) => s.id === to.id)!.lines.length - 1
  return { lib: { ...lib, spots }, open: { kind: 'spot', spot: to.id, line, editing: false } }
}

/** What an import did, or what it needs first. */
export type Imported =
  | { added: number; skipped: number }
  | 'password'
  | 'wrong password'

/** Asks every other tab to hide its secret spots too: a hide that leaves one tab showing is no hide. */
const HIDE_CHANNEL = 'highline-finder.hide-secrets'

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
 * the other tab's version.
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
  if (!held) return { open: { ...o, line: null, editing: false }, reload: false }
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
 *
 * Secret spots are left out of everything this hands out until they are shown, and every page load
 * starts with them hidden. With a password set they are sealed on disk and opened only in memory,
 * after the password; hiding them drops both the key and what was opened. See vault.ts.
 */
export function useSpots(arrival: Arrival, load: (line: LineSpec | null) => void) {
  const [start] = useState(() => {
    const lib = loadLibrary()
    return { lib, ...startingPoint(visibleOf(lib, false), arrival) }
  })
  const [lib, setLib] = useState(start.lib)
  const [open, setOpen] = useState<Open>(start.open)
  const [shared, setShared] = useState(start.shared)
  const libRef = useRef(lib)
  const openRef = useRef(open)
  const sharedRef = useRef(shared)
  const histories = useRef(new Map<string, History>())
  const [, setVersion] = useState(0)
  const [shown, setShown] = useState(false)
  const shownRef = useRef(false)
  const [vault, setVault] = useState(loadVault)
  const vaultRef = useRef(vault)
  const keyRef = useRef<CryptoKey | null>(null)
  /** The secret spots opened here since the last unlock, as last sealed or read. */
  const known = useRef(new Map<string, Spot>())
  /** The newest seal asked for per spot, so an older one finishing late cannot overwrite it. */
  const sealing = useRef(new Map<string, number>())
  const sealCount = useRef(0)

  const adopt = (next: Library) => {
    libRef.current = next
    setLib(next)
  }
  const setVaultTo = (v: Vault | null) => {
    vaultRef.current = v
    setVault(v)
  }
  const sealLater = (s: Spot, v: Vault) => {
    const key = keyRef.current
    const ticket = ++sealCount.current
    sealing.current.set(s.id, ticket)
    if (!key) return
    seal(key, spotText(s), s.id).then(
      (text) => {
        if (sealing.current.get(s.id) === ticket && vaultRef.current?.salt === v.salt) storeSealed(s.id, text)
      },
      (e: unknown) => report('sealing a secret spot', e),
    )
  }
  /** Writes the library, and with a password set, seals each secret spot that changed. */
  const persist = (l: Library) => {
    const v = vaultRef.current
    storeLibrary(l, !!v)
    if (!v) return
    const secret = new Map(l.spots.filter((s) => s.secret && !isShell(s)).map((s) => [s.id, s]))
    for (const id of known.current.keys()) {
      if (secret.has(id) || l.spots.some((s) => s.id === id && isShell(s))) continue
      known.current.delete(id)
      sealing.current.set(id, ++sealCount.current)
      storeSealed(id, null)
    }
    for (const s of secret.values()) {
      if (known.current.get(s.id) === s) continue
      known.current.set(s.id, s)
      sealLater(s, v)
    }
  }
  const commit = (next: Library) => {
    const stored = rebased(libRef.current, next, opened(loadLibrary(), known.current))
    adopt(stored)
    persist(stored)
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

  /** Takes in a library another tab stored, keeping the same line open. */
  const take = (theirs: Library) => {
    const before = normalized(libRef.current)
    for (const key of changedKeys(before, theirs)) histories.current.delete(key)
    adopt(theirs)
    const { open: next, reload } = reopened(openRef.current, before, theirs)
    if (reload) go(next)
    else show(next)
    setVersion((v) => v + 1)
  }

  /** Opens what is sealed of `ids` with `key`, into `known`. Unreadable ones stay shells. */
  const unsealInto = async (key: CryptoKey, ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        const text = loadSealed(id)
        if (!text) return
        try {
          const spot = spotOfText(await unseal(key, text, id))
          if (spot) known.current.set(id, { ...spot, id, secret: true })
        } catch (e) {
          report('opening a secret spot', e)
        }
      }),
    )
  }

  /** Hides the secret spots, and drops everything opened of them along with the key. */
  const conceal = (tellOthers: boolean) => {
    if (tellOthers) {
      try {
        const channel = new BroadcastChannel(HIDE_CHANNEL)
        channel.postMessage('hide')
        channel.close()
      } catch (e) {
        report('telling other tabs to hide secret spots', e)
      }
    }
    shownRef.current = false
    setShown(false)
    keyRef.current = null
    const o = openRef.current
    if (o.kind === 'spot' && spotOf(o.spot)?.secret) go({ kind: 'none' })
    for (const s of libRef.current.spots) if (s.secret) histories.current.delete(s.id)
    if (vaultRef.current) {
      known.current.clear()
      adopt(sealedForm(libRef.current))
    }
    setVersion((v) => v + 1)
  }

  useEffect(() => {
    const unwatch = watchLibrary((theirs) => take(opened(theirs, known.current)))
    const unwatchVault = watchVault(
      () => {
        setVaultTo(loadVault())
        conceal(false)
      },
      (id) => {
        const key = keyRef.current
        if (!key || !libRef.current.spots.some((s) => s.id === id)) return
        void unsealInto(key, [id]).then(() => {
          if (keyRef.current === key) take(opened(sealedForm(libRef.current), known.current))
        })
      },
    )
    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel(HIDE_CHANNEL)
      channel.onmessage = () => conceal(false)
    } catch (e) {
      report('listening for other tabs hiding secret spots', e)
    }
    return () => {
      unwatch()
      unwatchVault()
      channel?.close()
    }
  }, [])

  const held = () => {
    const o = openRef.current
    return o.kind === 'spot' && o.editing
  }

  const key = undoKey(open)
  const h = key ? histories.current.get(key) : undefined
  const view = visibleOf(lib, shown)
  const spot = open.kind === 'spot' ? spotOf(open.spot, lib) ?? null : open.kind === 'shared' ? shared : null
  const active =
    open.kind === 'draft' ? lib.draft
    : open.kind === 'spot' || open.kind === 'shared' ? (open.line === null ? null : spot?.lines[open.line] ?? null)
    : null

  return {
    /** The kept lines that may be on screen: without the secret spots unless they are shown. */
    lib: view,
    open,
    secrets: {
      shown,
      /** A password is set, and showing them asks for it. */
      locked: !!vault,
      /** Whether any are kept, so export can offer them. Only true while they are shown. */
      any: shown && view.spots.some((s) => s.secret),
      /** Shows them; with a password set, only the right one does. Resolves whether they are shown. */
      reveal: async (password: string): Promise<boolean> => {
        const v = vaultRef.current
        if (v) {
          const key = await openVault(v, password)
          if (!key) return false
          keyRef.current = key
          await unsealInto(key, libRef.current.spots.filter(isShell).map((s) => s.id))
          adopt(opened(libRef.current, known.current))
        }
        shownRef.current = true
        setShown(true)
        return true
      },
      hide: () => conceal(true),
      /** Seals every secret spot under a new password. Only while they are shown. */
      setPassword: async (password: string) => {
        if (vaultRef.current || !shownRef.current) return
        const { vault: v, key } = await newVault(password)
        const secret = libRef.current.spots.filter((s) => s.secret)
        for (const s of secret) storeSealed(s.id, await seal(key, spotText(s), s.id))
        keyRef.current = key
        for (const s of secret) known.current.set(s.id, s)
        setVaultTo(v)
        storeVault(v)
        persist(libRef.current)
      },
      /** Stores the secret spots unsealed again, given the password. Resolves whether it was right. */
      removePassword: async (password: string): Promise<boolean> => {
        const v = vaultRef.current
        if (!v || !shownRef.current || !(await openVault(v, password))) return false
        setVaultTo(null)
        keyRef.current = null
        storeLibrary(libRef.current, false)
        for (const id of known.current.keys()) {
          sealing.current.set(id, ++sealCount.current)
          storeSealed(id, null)
        }
        known.current.clear()
        storeVault(null)
        return true
      },
    },
    /**
     * An export of the spots on screen, open ones always and secret ones if asked for: sealed under
     * the password when one is set and `encrypted`, readable by anyone otherwise.
     */
    exportFile: async ({ secret, encrypted }: { secret: boolean; encrypted: boolean }) => {
      const all = visibleOf(libRef.current, shownRef.current).spots
      const open = all.filter((s) => !s.secret)
      const secrets = secret ? all.filter((s) => s.secret) : []
      const k = keyRef.current
      const v = vaultRef.current
      if (!encrypted || !k || !v || !secrets.length) return exportText([...open, ...secrets])
      const sealed = await Promise.all(secrets.map(async (s) => ({ id: s.id, data: await seal(k, spotText(s), s.id) })))
      return exportText(open, { vault: v, spots: sealed })
    },
    /**
     * Adds what is new in an export file; see `merged`. Encrypted secret spots need that file's
     * password, or `skip` to leave them out. Secret spots are only taken in while they are shown.
     */
    importFile: async (file: ExportFile, password: string | 'skip' | null): Promise<Imported> => {
      let unsealed: Spot[] = []
      if (file.sealed && password !== 'skip') {
        if (password === null) return 'password'
        const k = await openVault(file.sealed.vault, password)
        if (!k) return 'wrong password'
        const opened = await Promise.all(
          file.sealed.spots.map(async ({ id, data }) => {
            try {
              const s = spotOfText(await unseal(k, data, id))
              return s && s.lines.length ? [{ ...s, id, secret: true }] : []
            } catch (e) {
              report('opening an imported secret spot', e)
              return []
            }
          }),
        )
        unsealed = opened.flat()
      }
      const incoming = [...file.spots, ...unsealed]
      const taken = shownRef.current ? incoming : incoming.filter((s) => !s.secret)
      const { spots: next, added } = merged(libRef.current.spots, taken)
      commit({ ...libRef.current, spots: next })
      return { added, skipped: incoming.length - taken.length }
    },
    /** Makes a spot secret or open again. Only while secret spots are shown, so it stays in view. */
    setSecret: (id: string, secret: boolean) => {
      if (shownRef.current) changeSpot(id, (s) => ({ ...s, secret }))
    },
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
    /** The first point of a new line is down. It is the new draft line, kept in a spot only once saved. */
    beginNewLine: () => {
      if (libRef.current.draft) change(DRAFT, null)
      show({ kind: 'draft' })
    },
    /**
     * Takes a line out of its spot to wherever it should have gone, and opens it there; see
     * `movedLine`.
     *
     * Not a step of undo: it changes two places at once, and undo works on one. Their undo is
     * forgotten instead, and moving back is the way back.
     */
    moveLine: (from: string, index: number, to: MoveTarget) => {
      const moved = held() ? null : movedLine(libRef.current, from, index, to)
      if (!moved) return
      histories.current.delete(from)
      histories.current.delete(to.kind === 'spot' ? to.id : DRAFT)
      commit(moved.lib)
      go(moved.open)
      setVersion((v) => v + 1)
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
    save: (
      { into, lineName, spotName, secret }: { into: string | null; lineName: string; spotName?: string; secret: boolean },
      current: LineSpec,
    ) => {
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
      const saved: Spot = {
        id: newId(), name: spotName ?? '', lines: [line], edited: Date.now(), secret: secret && shownRef.current,
      }
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
  }
}

export type Spots = ReturnType<typeof useSpots>
