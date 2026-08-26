import { describe, expect, it } from 'vitest'
import { compact, phaseRows, record, reportLines } from './report.js'

describe('compact', () => {
  it('keeps small counts exact and abbreviates the ones that would not line up', () => {
    expect(compact(842)).toBe('842')
    expect(compact(9_999)).toBe('9,999')
    expect(compact(82_474_911)).toBe('82.5M')
    expect(compact(893_627_187)).toBe('894M')
  })
})

describe('the run report', () => {
  it('keeps stages in the order they ran and chains each step off the one above it', () => {
    // Ordering is the point of the table: sorting it by cost is what the old report did, and that
    // is the one arrangement in which a funnel cannot be read.
    record('openness scan', {
      from: [1000, 'points'],
      to: [40, 'anchors'],
      steps: [
        ['has a drop', 200],
        ['some direction open', 40],
      ],
    })
    record('pairing', { from: [40, 'anchors'], to: [4, 'pairs'] })

    const lines = reportLines()
    expect(lines.map((l) => l.label.replace(/^\s*\.? ?/, ''))).toEqual([
      'openness scan',
      'has a drop',
      'some direction open',
      'pairing',
    ])
    // The stage row is a share of what reached the stage; a step, of the step before it.
    expect(lines[0]!.kept).toBe('4.0%')
    expect(lines[1]!.kept).toBe('20%')
    expect(lines[2]!.kept).toBe('20%')
    expect(lines[1]!.to).toBe('200')
    expect(lines[3]!.kept).toBe('10%')
  })
})

describe('flow figures', () => {
  it('reads a fan-out as a multiplier and a unit conversion as nothing at all', () => {
    record('pairing', { from: [1_874, 'anchors'], to: [4_324, 'pairs'] })
    // 4 tiles into 1.2M cells is not a funnel, and "x297,395" is worse than a blank cell.
    record('rasters', { from: [4, 'tiles'], to: [1_189_580, 'cells'] })
    const byLabel = new Map(reportLines().map((l) => [l.label.trim(), l]))

    expect(byLabel.get('pairing')!.kept).toBe('x2.3')
    expect(byLabel.get('rasters')!.kept).toBe('')
  })
})

describe('phaseRows', () => {
  it('never reports a phase as costing more than the stage that contains it', () => {
    // The pair search as it actually came out of a run the laptop slept through: 128s of processor
    // time over 668s of clock, with a phase timed on the clock at 564s.
    const rows = phaseRows(128, 668, [['terrain gate', 564]])
    const gate = rows.find(([name]) => name === 'terrain gate')!
    expect(gate[1]).toBeCloseTo(108.1, 1)
    expect(rows.reduce((s, [, seconds]) => s + seconds, 0)).toBeCloseTo(128, 5)
  })

  it('names the part of a stage no phase covered rather than leaving it as a gap', () => {
    const rows = phaseRows(100, 100, [['profile', 60]])
    expect(rows).toEqual([
      ['profile', 60],
      ['everything else', 40],
    ])
  })

  it('leaves a fully accounted stage alone', () => {
    expect(phaseRows(100, 100, [['a', 60], ['b', 39]])).toEqual([['a', 60], ['b', 39]])
  })
})
