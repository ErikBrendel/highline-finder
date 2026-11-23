import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { spanGeometry, type LatLon, type LineSpec } from './planPoints.js'
import {
  defaultLineName, exportText, nearbySpots, parseExport, spotHash, spotTitle, titleOf, type Spot,
} from './spots.js'
import { ShareButton } from './ShareButton.js'
import type { Spots } from './useSpots.js'
import { failureText } from './report.js'

export interface Lit {
  spot: string
  line: number | null
}

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)

const centreOf = (s: Spot): LatLon => {
  const ends = s.lines.flatMap((l) => [l.a, l.b])
  return {
    lat: ends.reduce((sum, p) => sum + p.lat, 0) / ends.length,
    lon: ends.reduce((sum, p) => sum + p.lon, 0) / ends.length,
  }
}

/** Enter keeps, Shift+Enter starts a new line of notes. */
const enterTo = (done: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  done()
}

/** A text box as tall as what is in it, so a name with notes under it is all on screen. */
function Grow({ value, onChange, placeholder, onEnter, autoFocus }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  onEnter?: () => void
  autoFocus?: boolean
}) {
  return (
    <textarea
      className="grow"
      rows={Math.max(1, value.split('\n').length)}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? enterTo(onEnter) : undefined}
    />
  )
}

/** A button that asks once more before it does something that cannot be undone. */
function Confirm({ label, sure, onConfirm }: { label: string; sure: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    const timer = setTimeout(() => setAsking(false), 3000)
    return () => clearTimeout(timer)
  }, [asking])
  return (
    <button
      className="danger"
      data-asking={asking || undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (asking) onConfirm()
        setAsking(!asking)
      }}
      title={asking ? 'Click again to confirm' : label}
    >
      {asking ? sure : label}
    </button>
  )
}

/** Keeps the open draft or found line, on its own or in a spot nearby. */
function SaveSheet({ spots, line, onDone }: { spots: Spots; line: LineSpec & { a: LatLon; b: LatLon }; onDone: () => void }) {
  const nearby = nearbySpots(spots.lib.spots, [line.a, line.b])
  const named = spots.open.kind === 'found' ? spots.open.name : spots.lib.draft?.name
  const [name, setName] = useState(named ?? defaultLineName(line.a, line.b))
  const [into, setInto] = useState<string | null>(nearby.length === 1 ? nearby[0]!.spot.id : null)
  const target = nearby.find((n) => n.spot.id === into)?.spot
  const needsSpotName = !!target && target.lines.length === 1 && !titleOf(target.name)
  const [spotName, setSpotName] = useState('')
  useEffect(() => {
    if (needsSpotName) setSpotName(titleOf(target.lines[0]!.name))
  }, [needsSpotName, target])

  const save = () => {
    spots.save({ into, lineName: name, spotName: needsSpotName ? spotName : undefined }, line)
    onDone()
  }

  return (
    <div className="savesheet">
      <label>
        Name
        <Grow value={name} onChange={setName} placeholder="Name, and notes under it" onEnter={save} autoFocus />
      </label>
      {nearby.length > 0 && (
        <div className="targets" role="radiogroup">
          {nearby.map(({ spot, metres }) => (
            <label key={spot.id}>
              <input type="radio" checked={into === spot.id} onChange={() => setInto(spot.id)} />
              Add to <b>{spotTitle(spot)}</b> <span className="sub">{km(metres)} away</span>
            </label>
          ))}
          <label>
            <input type="radio" checked={into === null} onChange={() => setInto(null)} />
            On its own
          </label>
        </div>
      )}
      {needsSpotName && (
        <label>
          Name for the spot, now it holds more than one line
          <Grow value={spotName} onChange={setSpotName} placeholder="Spot name" onEnter={save} />
        </label>
      )}
      <div className="row">
        <button className="primary" onClick={save}>Save</button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

const linkTo = (s: Spot) => `${location.origin}${location.pathname}#${spotHash(s)}`

export function SpotsPanel({ spots, line, centre, saving, onSaving, onLit, onFocus, onAddLine, onClose }: {
  spots: Spots
  /** The planner's line, which is what gets saved. */
  line: LineSpec
  /** Where the map is looking, to sort the list by. */
  centre: LatLon | null
  saving: boolean
  onSaving: (on: boolean) => void
  onLit: (lit: Lit | null) => void
  onFocus: (spot: Spot) => void
  onAddLine: () => void
  onClose: () => void
}) {
  const [browsing, setBrowsing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const { lib, spot, open, holding } = spots
  const spotKey = spot?.id ?? null
  useEffect(() => setBrowsing(false), [spotKey])
  useEffect(() => () => onLit(null), [onLit])

  const sorted = centre
    ? lib.spots
        .map((s) => ({ s, metres: spanGeometry(centre, centreOf(s)).length }))
        .sort((p, q) => p.metres - q.metres)
    : lib.spots.map((s) => ({ s, metres: null })).sort((p, q) => q.s.edited - p.s.edited)

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportText(lib.spots)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `highlines-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  const upload = async (f: File) => {
    try {
      const added = spots.importSpots(parseExport(await f.text()))
      setNote(added ? `${added} spot${added === 1 ? '' : 's'} added` : 'nothing new in that file')
    } catch (e: unknown) {
      setNote(`could not import: ${failureText(e)}`)
    }
  }

  const head = (title: string, back?: () => void, tag?: string) => (
    <div className="spotshead">
      {back && <button className="back" onClick={back} disabled={holding} aria-label="All spots">&larr;</button>}
      <strong>{title}</strong>
      {tag && <span className="unsaved">{tag}</span>}
      <button className="close" onClick={onClose} aria-label="Close">&times;</button>
    </div>
  )

  if (saving && line.a && line.b && (open.kind === 'draft' || open.kind === 'found')) {
    return (
      <aside className="spots">
        {head('Save line')}
        <SaveSheet spots={spots} line={{ ...line, a: line.a, b: line.b }} onDone={() => onSaving(false)} />
      </aside>
    )
  }

  if (!spot || browsing) {
    const row = (key: string, title: string, sub: ReactNode, active: boolean, onOpen: () => void, lit: Lit) => (
      <li key={key}>
        <button
          data-active={active || undefined}
          onClick={active ? spots.leaveSpot : onOpen}
          title={active ? 'Click again to close' : undefined}
          onMouseEnter={() => onLit(lit)}
          onMouseLeave={() => onLit(null)}
        >
          <span className="title">{title}</span>
          <span className="sub">{sub}</span>
        </button>
      </li>
    )
    return (
      <aside className="spots">
        {head('My lines')}
        <ul className="spotlist">
          {spots.shared && row('shared', spotTitle(spots.shared), <><span className="unsaved">shared</span> · {spots.shared.lines.length} lines</>,
            open.kind === 'shared', () => { spots.openShared(null); setBrowsing(false); onFocus(spots.shared!) }, { spot: 'shared', line: null })}
          {lib.draft && row('draft', titleOf(lib.draft.name) || 'Untitled', <span className="draft">draft</span>,
            open.kind === 'draft', spots.openDraft, { spot: 'draft', line: null })}
          {sorted.map(({ s, metres }) => row(
            s.id,
            spotTitle(s),
            <>
              {s.lines.length > 1 ? `${s.lines.length} lines` : `${Math.round(spanGeometry(s.lines[0]!.a, s.lines[0]!.b).length)} m`}
              {metres !== null && ` · ${km(metres)} away`}
            </>,
            s.id === spot?.id,
            () => { spots.openSpot(s.id); setBrowsing(false); onFocus(s) },
            { spot: s.id, line: null },
          ))}
        </ul>
        {!lib.spots.length && !lib.draft && (
          <p className="note">Nothing kept yet. Pick or plan a line, then save it from its panel.</p>
        )}
        <div className="spotsfoot">
          <button onClick={download} disabled={!lib.spots.length} title="Download every saved spot as a file">Export</button>
          <button onClick={() => file.current?.click()} title="Add the spots from an exported file; nothing here is overwritten">Import</button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void upload(f)
            }}
          />
          {note && <span className="sub">{note}</span>}
        </div>
      </aside>
    )
  }

  const isShared = open.kind === 'shared'
  const at = open.kind === 'spot' || open.kind === 'shared' ? open.line : null
  const active = spots.active
  return (
    <aside className="spots">
      {head(spotTitle(spot), () => setBrowsing(true), isShared ? 'shared, not saved' : undefined)}
      {!isShared && spot.lines.length > 1 && (
        <label className="spotname">
          Spot
          <Grow value={spot.name} onChange={(v) => spots.renameSpot(spot.id, v)} placeholder="Name of this spot" />
        </label>
      )}
      <ul className="spotlist lines">
        {spot.lines.map((l, i) => (
          <li key={l.id}>
            <button
              data-active={i === at || undefined}
              disabled={holding && i !== at}
              onClick={() => (i === at ? spots.close() : isShared ? spots.openShared(i) : spots.openLine(spot.id, i))}
              title={i === at ? 'Click again to close this line' : undefined}
              onMouseEnter={() => onLit({ spot: isShared ? 'shared' : spot.id, line: i })}
              onMouseLeave={() => onLit(null)}
            >
              <span className="title">{titleOf(l.name) || 'Untitled'}</span>
              <span className="sub">{Math.round(spanGeometry(l.a, l.b).length)} m</span>
            </button>
            {!isShared && !holding && <Confirm label="&times;" sure="delete" onConfirm={() => spots.removeLine(spot.id, i)} />}
          </li>
        ))}
        {at !== null && at >= spot.lines.length && (
          <li><span className="placing">new line &mdash; place A and B on the map</span></li>
        )}
      </ul>
      {active && !isShared && (
        <label className="linename">
          Line
          <Grow value={active.name} onChange={spots.renameActive} placeholder="Name, and notes under it" />
        </label>
      )}
      {isShared ? (
        <div className="row">
          <button className="primary" onClick={spots.saveShared}>Save spot</button>
          <button onClick={spots.dismissShared}>Dismiss</button>
        </div>
      ) : (
        <>
          <div className="row">
            <button onClick={onAddLine} disabled={holding} title="Place another line in this spot">+ line</button>
            <button onClick={spots.undo} disabled={!spots.canUndo} title="Undo (Ctrl+Z)">undo</button>
            <button onClick={spots.redo} disabled={!spots.canRedo} title="Redo (Ctrl+Shift+Z)">redo</button>
          </div>
          <div className="row">
            {active && <ShareButton label="share line" title="Send a link to this line, with its name and notes" />}
            {spot.lines.length > 1 && (
              <ShareButton label="share spot" title="Send a link to all lines of this spot" url={() => linkTo(spot)} />
            )}
          </div>
          <div className="row">
            <button onClick={spots.leaveSpot} disabled={holding} title="Leave this spot; it stays saved">Close spot</button>
            <Confirm label="Delete spot" sure="delete for good" onConfirm={() => spots.removeSpot(spot.id)} />
          </div>
        </>
      )}
    </aside>
  )
}
