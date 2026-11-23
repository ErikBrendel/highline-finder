import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { spanGeometry, type LatLon } from './planPoints.js'
import {
  exportText, nearbySpots, parseExport, spotHash, spotTitle, titleOf, type Spot,
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

function SaveSheet({ spots, onDone }: { spots: Spots; onDone: () => void }) {
  const { draft } = spots.lib
  const single = draft.lines.length === 1
  const active = draft.lines[Math.min(spots.working.line, draft.lines.length - 1)]
  const nearby = nearbySpots(spots.lib.spots, draft.lines.flatMap((l) => [l.a, l.b]))
  const [name, setName] = useState(single ? (active?.name ?? '') : draft.name)
  const [into, setInto] = useState<string | null>(nearby.length === 1 ? nearby[0]!.spot.id : null)
  const target = nearby.find((n) => n.spot.id === into)?.spot
  const needsSpotName = !!target && target.lines.length === 1 && !titleOf(target.name)
  const [spotName, setSpotName] = useState('')
  useEffect(() => {
    if (needsSpotName) setSpotName(titleOf(target.lines[0]!.name))
  }, [needsSpotName, target])

  const save = () => {
    spots.save({
      into,
      lineName: single ? name : undefined,
      spotName: !into && !single ? name : needsSpotName ? spotName : undefined,
    })
    onDone()
  }

  return (
    <div className="savesheet">
      <label>
        {single ? 'Name' : `Name for these ${draft.lines.length} lines`}
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

export function SpotsPanel({ spots, centre, saving, onSaving, onLit, onFocus, onAddLine, onClose }: {
  spots: Spots
  /** Where the map is looking, to sort the list by. */
  centre: LatLon | null
  saving: boolean
  onSaving: (on: boolean) => void
  onLit: (lit: Lit | null) => void
  onFocus: (spot: Spot) => void
  onAddLine: () => void
  onClose: () => void
}) {
  const [inSpot, setInSpot] = useState(saving || spots.working.spot !== spots.lib.draft.id || spots.spot.lines.length > 1)
  const [note, setNote] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (saving) setInSpot(true)
  }, [saving])
  useEffect(() => () => onLit(null), [onLit])

  const { lib, spot, isDraft, working } = spots
  const sorted = centre
    ? lib.spots
        .map((s) => ({ s, metres: spanGeometry(centre, centreOf(s)).length }))
        .sort((p, q) => p.metres - q.metres)
    : lib.spots.map((s) => ({ s, metres: null })).sort((p, q) => q.s.edited - p.s.edited)

  const openSpot = (s: Spot) => {
    spots.open(s.id, s.id === working.spot ? working.line : 0)
    setInSpot(true)
    if (s.lines.length) onFocus(s)
  }

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

  const list = (
    <>
      <div className="spotshead">
        <strong>My lines</strong>
        <button className="close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      <ul className="spotlist">
        {lib.draft.lines.length > 0 && (
          <li>
            <button
              data-active={isDraft || undefined}
              onClick={() => openSpot(lib.draft)}
              onMouseEnter={() => onLit({ spot: lib.draft.id, line: null })}
              onMouseLeave={() => onLit(null)}
            >
              <span className="title">{spotTitle(lib.draft)}</span>
              <span className="sub">
                <span className="unsaved">not saved</span>
                {lib.draft.lines.length > 1 && ` · ${lib.draft.lines.length} lines`}
              </span>
            </button>
          </li>
        )}
        {sorted.map(({ s, metres }) => (
          <li key={s.id}>
            <button
              data-active={s.id === working.spot || undefined}
              onClick={() => openSpot(s)}
              onMouseEnter={() => onLit({ spot: s.id, line: null })}
              onMouseLeave={() => onLit(null)}
            >
              <span className="title">{spotTitle(s)}</span>
              <span className="sub">
                {s.lines.length > 1 ? `${s.lines.length} lines` : `${Math.round(spanGeometry(s.lines[0]!.a, s.lines[0]!.b).length)} m`}
                {metres !== null && ` · ${km(metres)} away`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!lib.spots.length && !lib.draft.lines.length && (
        <p className="note">Nothing kept yet. Pick or place a line, then save it from its panel.</p>
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
    </>
  )

  if (!inSpot) return <aside className="spots">{list}</aside>

  const active = spot.lines[working.line]
  return (
    <aside className="spots">
      <div className="spotshead">
        <button className="back" onClick={() => { onSaving(false); setInSpot(false) }} aria-label="All spots">&larr;</button>
        <strong>{spotTitle(spot)}</strong>
        {isDraft && <span className="unsaved">not saved</span>}
        <button className="close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      {saving && isDraft && spot.lines.length > 0 ? (
        <SaveSheet spots={spots} onDone={() => onSaving(false)} />
      ) : (
        <>
          {!isDraft && spot.lines.length > 1 && (
            <label className="spotname">
              Spot
              <Grow value={spot.name} onChange={(v) => spots.renameSpot(spot.id, v)} placeholder="Name of this spot" />
            </label>
          )}
          <ul className="spotlist lines">
            {spot.lines.map((l, i) => (
              <li key={l.id}>
                <button
                  data-active={i === working.line || undefined}
                  onClick={() => spots.open(spot.id, i)}
                  onMouseEnter={() => onLit({ spot: spot.id, line: i })}
                  onMouseLeave={() => onLit(null)}
                >
                  <span className="title">{titleOf(l.name) || 'Untitled'}</span>
                  <span className="sub">{Math.round(spanGeometry(l.a, l.b).length)} m</span>
                </button>
                <Confirm label="&times;" sure="delete" onConfirm={() => spots.removeLine(spot.id, i)} />
              </li>
            ))}
            {working.line >= spot.lines.length && (
              <li><span className="placing">new line &mdash; place A and B on the map</span></li>
            )}
          </ul>
          {active && (
            <label className="linename">
              Line
              <Grow value={active.name} onChange={(v) => spots.renameLine(spot.id, working.line, v)} placeholder="Name, and notes under it" />
            </label>
          )}
          <div className="row">
            <button onClick={onAddLine} title="Place another line in this spot">+ line</button>
            <button onClick={spots.undo} disabled={!spots.canUndo} title="Undo (Ctrl+Z)">undo</button>
            <button onClick={spots.redo} disabled={!spots.canRedo} title="Redo (Ctrl+Shift+Z)">redo</button>
          </div>
          {spot.lines.length > 0 && (
            <div className="row">
              {active && <ShareButton label="share line" title="Send a link to this line, with its name and notes" />}
              {spot.lines.length > 1 && (
                <ShareButton
                  label="share spot"
                  title="Send a link to all lines of this spot; it opens as a copy the other person can save"
                  url={() => `${location.origin}${location.pathname}#${spotHash(spot)}`}
                />
              )}
            </div>
          )}
          {isDraft ? (
            spot.lines.length > 0 && (
              <div className="row">
                <button className="primary" onClick={() => onSaving(true)}>Save&hellip;</button>
                <Confirm label="Discard" sure="discard all" onConfirm={spots.discardDraft} />
              </div>
            )
          ) : (
            <div className="row">
              <button onClick={() => { spots.toDraft(); setInSpot(false) }} title="Leave this spot; it stays saved">Close spot</button>
              <Confirm label="Delete spot" sure="delete for good" onConfirm={() => { spots.removeSpot(spot.id); setInSpot(false) }} />
            </div>
          )}
        </>
      )}
    </aside>
  )
}
