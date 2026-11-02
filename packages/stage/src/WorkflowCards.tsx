import type { Act } from '../kit/act'
import { Roll } from '../kit/motion/Roll'
import { States } from '../kit/motion/States'
import { Stage } from '../kit/stage'
import { Window } from '../kit/window'
import './look.css'
import './workflow-cards.css'

// The feature card for creating campaigns: the preview on a tile, its status
// coerced to paused by policy as it comes into view.

type Coerce = { paused: boolean }

async function coerce(a: Act<Coerce>) {
  await a.wait(1100)
  a.mark('coerce')
  await a.set({ paused: true })
}

export function CreateCard() {
  return (
    <Stage<Coerce> width={600} height={340} compact={{ below: 560, width: 358, height: 340 }} theme="light" greys="cool" fidelity="realistic" initial={{ paused: false }} poster={{ paused: true }} play="once" script={coerce} className="ap-look wf">
      {(s) => (
        <Window title="New campaign" className="wf-window wf-window--bleed">
          <div className="wf-body">
            <div className="wf-caption wf-caption--code">google_create_campaign · preview</div>
            <dl className="wf-form">
              <div><dt>Name</dt><dd>Autumn Sale 2026</dd></div>
              <div><dt>Daily budget</dt><dd>$60.00</dd></div>
              <div><dt>Network</dt><dd>Search</dd></div>
              <div><dt>Bidding</dt><dd>Maximize conversions</dd></div>
              <div className="wf-form__coerced" data-on={s.paused || undefined}>
                <dt>Status</dt>
                <dd><States align="start" value={s.paused ? 'paused' : 'enabled'} states={{ enabled: 'Enabled', paused: 'Paused' }} /></dd>
              </div>
            </dl>
            <div className="wf-note" data-on={s.paused || undefined}><Roll variant="fade">{s.paused ? 'Changed by policy paused_creation' : 'Checking policy'}</Roll></div>
          </div>
        </Window>
      )}
    </Stage>
  )
}

// The other examples share one shape: a preview window whose last row changes as it
// comes into view (a status set, a cap refusing the change), with the note that says why.

type Reveal = { done: boolean }

async function reveal(a: Act<Reveal>) {
  await a.wait(1100)
  a.mark('reveal')
  await a.set({ done: true })
}

type PreviewCardProps = {
  title: string
  tool: string
  rows: [string, string][]
  focus: { label: string; from: string; to: string }
  note: { from: string; to: string }
  tone?: 'accent' | 'stop'
}

function PreviewCard({ title, tool, rows, focus, note, tone = 'accent' }: PreviewCardProps) {
  return (
    <Stage<Reveal> width={600} height={300} compact={{ below: 560, width: 358, height: 300 }} theme="light" greys="cool" fidelity="realistic" initial={{ done: false }} poster={{ done: true }} play="once" script={reveal} className="ap-look wf">
      {(s) => (
        <Window title={title} className="wf-window wf-window--bleed">
          <div className="wf-body">
            <div className="wf-caption wf-caption--code">{tool}</div>
            <dl className="wf-form">
              {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              <div className="wf-form__coerced" data-tone={tone} data-on={s.done || undefined}>
                <dt>{focus.label}</dt>
                <dd><States align="start" value={s.done ? 'to' : 'from'} states={{ from: focus.from, to: focus.to }} /></dd>
              </div>
            </dl>
            <div className="wf-note" data-tone={tone} data-on={s.done || undefined}><Roll variant="fade">{s.done ? note.to : note.from}</Roll></div>
          </div>
        </Window>
      )}
    </Stage>
  )
}

export function PauseCard() {
  return (
    <PreviewCard
      title="Retargeting EU"
      tool="meta_set_campaign_status · preview"
      rows={[['Platform', 'Meta Ads'], ['Ad sets', '4 active'], ['Daily budget', '€25.00']]}
      focus={{ label: 'Status', from: 'Active', to: 'Paused' }}
      note={{ from: 'Checking with Meta', to: 'Meta validate_only accepted it' }}
    />
  )
}

export function CapCard() {
  return (
    <PreviewCard
      title="Spark test"
      tool="tiktok_set_budget"
      rows={[['Platform', 'TikTok Ads'], ['Daily budget', '$50.00 → $100.00'], ['Change', '+100.0%']]}
      focus={{ label: 'Result', from: 'Checking policy', to: 'Rejected' }}
      note={{ from: 'Checking the 25% change cap', to: 'Over the 25% cap. Nothing sent.' }}
      tone="stop"
    />
  )
}

const KEYWORDS: [string, string][] = [
  ['tent footprint', 'Exact'],
  ['ultralight 2 person tent', 'Phrase'],
  ['family camping tent', 'Broad'],
]

type Listed = { shown: number }

async function list(a: Act<Listed>) {
  await a.wait(700)
  a.mark('list')
  for (let shown = 1; shown <= KEYWORDS.length; shown++) {
    await a.set({ shown })
    await a.wait(260)
  }
}

export function KeywordsCard() {
  return (
    <Stage<Listed> width={600} height={300} compact={{ below: 560, width: 358, height: 300 }} theme="light" greys="cool" fidelity="realistic" initial={{ shown: 0 }} poster={{ shown: KEYWORDS.length }} play="once" script={list} className="ap-look wf">
      {(s) => (
        <Window title="Generic Tents" className="wf-window wf-window--bleed">
          <div className="wf-body">
            <div className="wf-caption wf-caption--code">google_add_keywords · preview</div>
            <div className="wf-kws">
              {KEYWORDS.map(([text, match], i) => (
                <div key={text} className="wf-kw" data-on={i < s.shown || undefined}>
                  <span className="wf-kw__plus" aria-hidden>+</span>
                  <span className="wf-kw__text">{text}</span>
                  <span className="wf-kw__match">{match}</span>
                </div>
              ))}
            </div>
            <div className="wf-note" data-on={s.shown === KEYWORDS.length || undefined}><Roll variant="fade">{s.shown === KEYWORDS.length ? 'Apply runs exactly these 3 keywords' : 'Building the preview'}</Roll></div>
          </div>
        </Window>
      )}
    </Stage>
  )
}
