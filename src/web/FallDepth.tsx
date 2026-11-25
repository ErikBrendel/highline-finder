import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  depths, HARNESS_ABOVE_M, LEASH_M, REFERENCE_WALKER_KG, REFERENCE_WEBBING, referencePretension, WEBBINGS, type Rig,
} from './rig.js'
import { Slider } from './Slider.js'

const MAX_PCT = 25

/**
 * The one rigging control a line has: how deep the line goes at midspan, as a share of its span.
 *
 * Walking sag, a leash fall and a backup fall all come out close to a fixed fraction of span for a
 * given rig, so one number stands for the whole rig. Turning a rig into it is the calculator's job,
 * behind the "?", and kept off the line view on purpose.
 */
export function FallDepthSlider({ value, min, lengthM, onChange }: {
  value: number; min: number
  /** The open line's span, which the calculator starts from. */
  lengthM: number | null
  onChange: (pct: number) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Slider
        label="Fall depth"
        value={value}
        min={min}
        max={MAX_PCT}
        step={0.5}
        unit=" % of span"
        format={(v) => v.toFixed(1)}
        onHelp={() => setOpen(true)}
        onChange={onChange}
      />
      {open && createPortal(
        <RigCalculator
          pct={value}
          lengthM={lengthM}
          onPlan={(pct) => {
            onChange(Math.min(MAX_PCT, Math.max(min, Math.round(pct * 2) / 2)))
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />,
        document.body,
      )}
    </>
  )
}

const stretchText = (curve: [number, number][]) => curve.map(([kn, pct]) => `${pct} % @ ${kn} kN`).join(', ')

function RigCalculator({ pct, lengthM, onPlan, onClose }: {
  pct: number; lengthM: number | null
  onPlan: (pct: number) => void
  onClose: () => void
}) {
  const start = Math.round(lengthM ?? 150)
  const [webbing, setWebbing] = useState(REFERENCE_WEBBING)
  const [pretensionKn, setPretension] = useState(Math.round(referencePretension(start) * 2) / 2)
  const [walkerKg, setWalker] = useState(REFERENCE_WALKER_KG)
  const [length, setLength] = useState(start)
  const [slack, setSlack] = useState(Math.max(1, Math.round(start * 0.02)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rig: Omit<Rig, 'webbing'> = { pretensionKn, walkerKg, lengthM: length, backupSlackM: slack }
  const mine = useMemo(() => depths({ ...rig, webbing }), [webbing, pretensionKn, walkerKg, length, slack])
  const leashFalls = useMemo(
    () => new Map(WEBBINGS.map((w) => [w.name, depths({ ...rig, webbing: w }).leashFall])),
    [pretensionKn, walkerKg, length, slack],
  )
  const share = (m: number) => (100 * m) / length
  const cases = [
    { what: 'Walking', m: mine.walking, note: 'standing at midspan' },
    { what: 'Leash fall', m: mine.leashFall, note: 'the usual thing to plan for' },
    { what: 'Backup fall', m: mine.backupFall, note: 'the mainline failing' },
  ]

  return (
    <div className="guidewrap" onClick={onClose}>
      <div className="guide rigcalc" role="dialog" aria-modal="true" aria-label="Rig calculator" onClick={(e) => e.stopPropagation()}>
        <div className="head">
          <strong>Rig calculator</strong>
          <button className="close" onClick={onClose}>close</button>
        </div>
        <div className="body">
          <p>
            The fall depth is how far below the straight anchor-to-anchor line the webbing goes at
            midspan, as a share of span. The ground has to stay 3 m below that, for the walker
            hanging under it. Yours is at <b>{pct.toFixed(1)} %</b>. Describe a rig here to see what
            it should be.
          </p>
          <p>
            A line starts at the leash fall of {REFERENCE_WEBBING.name} at the pretension its span is
            usually rigged at, which is where this opens: about 2 kN for 50 m lines, 6 kN at 250 m
            and 12 kN from 600 m. Only the short end is measured; the rest is pieced together from
            grip ratings, record reports and LineGrip's figures for lines over 500 m.
          </p>

          <label className="rigpick">
            <span>Webbing</span>
            <select value={webbing.name} onChange={(e) => setWebbing(WEBBINGS.find((w) => w.name === e.target.value)!)}>
              {WEBBINGS.map((w) => (
                <option key={w.name} value={w.name}>{w.name} ({w.maker}, {w.material})</option>
              ))}
            </select>
          </label>
          <Slider label="Pretension" value={pretensionKn} min={0.5} max={20} step={0.5} unit=" kN" format={(v) => v.toFixed(1)} onChange={setPretension} />
          <Slider label="Walker" value={walkerKg} min={40} max={120} step={1} unit=" kg" onChange={setWalker} />
          <Slider label="Span" value={length} min={20} max={1500} step={10} unit=" m" onChange={setLength} />
          <Slider label="Backup slack" value={slack} min={0} max={Math.max(10, Math.round(length * 0.08))} step={0.5} unit=" m longer than span" onChange={setSlack} />

          <table className="rigcases">
            <tbody>
              {cases.map((c) => (
                <tr key={c.what}>
                  <td><b>{c.what}</b><br /><span>{c.note}</span></td>
                  <td>{share(c.m).toFixed(1)} %</td>
                  <td>{c.m.toFixed(1)} m</td>
                  <td><button onClick={() => onPlan(share(c.m))}>plan for this</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>What sets it</h3>
          <ul>
            <li>
              <b>Pretension and span</b> do most of it. Longer lines are rigged tighter, so the
              default falls from about 8 % at 50 m to about 3 % from 600 m.
            </li>
            <li>
              <b>Material</b> barely does once the pretension is set. Makers give Dyneema, hybrid,
              Vectran and polyester webbings overlapping tension ranges (Balance: 1-4.5 kN for Blue
              and Spider Silk MK4/MK5, 1.5-6 kN for Mantra), and over those ranges their leash falls
              overlap almost completely.
            </li>
            <li>
              <b>Nylon</b> is the exception: rigged softer (about 2 kN) and stretchier, it falls
              roughly half as deep again. It is a short-line webbing, sold for lines up to about 250 m.
            </li>
          </ul>

          <h3>Webbings</h3>
          <p>
            Stretch as the retailer publishes it. The last column is the leash fall at the pretension,
            walker and span above. Pick a row to use it.
          </p>
          <div className="rigtablewrap">
            <table className="rigwebbings">
              <thead>
                <tr><th>Webbing</th><th>Made of</th><th>g/m</th><th>Stretch</th><th>Leash fall</th></tr>
              </thead>
              <tbody>
                {WEBBINGS.map((w) => (
                  <tr key={w.name} data-active={w === webbing || undefined} onClick={() => setWebbing(w)}>
                    <td>
                      <a href={w.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{w.name}</a>
                      <br /><span>{w.maker}</span>
                    </td>
                    <td>{w.makeup}</td>
                    <td>{w.gPerM}</td>
                    <td>{stretchText(w.curve)}</td>
                    <td>{share(leashFalls.get(w.name)!).toFixed(1)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>What this leaves out</h3>
          <ul>
            <li>
              Falls lose nothing here, so they are worst cases: real webbing turns part of a fall into
              heat. The leash fall drops the harness from {HARNESS_ABOVE_M} m above the webbing to{' '}
              {LEASH_M} m below it.
            </li>
            <li>
              Stretch between and beyond the published points is drawn as straight lines from zero,
              which is rough where a maker gives one point. Sky Diamond's maker claims under 3 % at
              10 kN against the 3.8 % listed here.
            </li>
            <li>
              The webbing's own weight counts as half of it hung at midspan, which is exact for the
              sag and rough for the falls.
            </li>
            <li>
              The backup is taken to be the same webbing as the mainline, and the line a single
              webbing end to end.
            </li>
            <li>
              For a full backup fall model with segments, use the ISA's{' '}
              <a href="https://data.slacklineinternational.org/publications/highline/backup-fall/" target="_blank" rel="noreferrer">
                backup fall simulator
              </a>.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
