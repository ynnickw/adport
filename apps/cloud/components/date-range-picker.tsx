'use client';

import { useId, useState } from 'react';
import { PiCalendarBlank, PiCaretDown } from 'react-icons/pi';
import { resolveDateRange } from '@adport/core/dates';
import { Button, Input } from './controls';
import { Dialog } from './dialog';
import { OVERVIEW_RANGE_OPTIONS, overviewRangeLabel, validateOverviewRange, type OverviewRange } from '@/lib/overview-range';

export function DateRangePicker({ value, onChange }: { value: OverviewRange; onChange: (value: OverviewRange) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" className="button secondary date-range-trigger" aria-label={`Date range: ${overviewRangeLabel(value)}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <PiCalendarBlank aria-hidden="true" /><span>{overviewRangeLabel(value)}</span><PiCaretDown aria-hidden="true" />
    </Button>
    {open ? <RangeDialog value={value} onApply={range => { onChange(range); setOpen(false); }} onClose={() => setOpen(false)} /> : null}
  </>;
}

function RangeDialog({ value, onApply, onClose }: { value: OverviewRange; onApply: (value: OverviewRange) => void; onClose: () => void }) {
  const id = useId();
  const [preset, setPreset] = useState(typeof value === 'string' ? value : 'custom');
  const initial = resolveDateRange(value);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [error, setError] = useState<string>();
  const today = new Date().toISOString().slice(0, 10);
  function choose(next: string) {
    setPreset(next); setError(undefined);
    if (next !== 'custom') {
      const resolved = resolveDateRange(next as Exclude<OverviewRange, object>);
      setStart(resolved.start); setEnd(resolved.end);
    }
  }
  return <Dialog title="Date range" onClose={onClose} className="date-range-dialog" portal>
    <form className="stack" onSubmit={event => {
      event.preventDefault();
      const range = preset === 'custom' ? { start, end } : preset as Exclude<OverviewRange, object>;
      try { validateOverviewRange(range); setError(undefined); onApply(range); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Choose a valid date range.'); }
    }}>
      <div className="date-range-presets" role="group" aria-label="Quick date ranges">
        {OVERVIEW_RANGE_OPTIONS.map((option, index) => <Button key={option.value} type="button" className="button secondary" aria-pressed={preset === option.value} data-autofocus={index === 0 ? '' : undefined} onClick={() => choose(option.value)}>{option.label}</Button>)}
      </div>
      <div className="date-range-inputs">
        <div className="field"><label htmlFor={`${id}-from`} className="field-label">From</label><Input id={`${id}-from`} type="date" value={start} max={today} required aria-describedby={`${id}-hint`} onChange={event => { setStart(event.target.value); setPreset('custom'); setError(undefined); }} /></div>
        <div className="field"><label htmlFor={`${id}-to`} className="field-label">To</label><Input id={`${id}-to`} type="date" value={end} min={start || undefined} max={today} required aria-describedby={`${id}-hint`} onChange={event => { setEnd(event.target.value); setPreset('custom'); setError(undefined); }} /></div>
      </div>
      <p id={`${id}-hint`} className="field-hint">Both dates are included. Last 7 and 30 days exclude today. Presets use UTC dates; platforms report in each ad account’s timezone.</p>
      {error ? <p className="error-callout" role="alert">{error}</p> : null}
      <div className="date-range-actions"><Button type="button" className="button secondary" onClick={onClose}>Cancel</Button><Button type="submit" className="button">Apply range</Button></div>
    </form>
  </Dialog>;
}
