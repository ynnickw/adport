import type { Act } from '../kit/act'
import { Collapse } from '../kit/motion/Collapse'
import { Count } from '../kit/motion/Count'
import { States } from '../kit/motion/States'
import { Check } from '../kit/parts/Check'
import { Spinner } from '../kit/parts/Spinner'
import { Stage } from '../kit/stage'
import { Bar, Window } from '../kit/window'
import { PiCheckCircle, PiFolders, PiShieldCheck, PiSquaresFour, PiStack, PiTerminalWindow } from 'react-icons/pi'
import { PlatformMark } from './marks'
import './look.css'
import './gate-hero.css'

// The product's one story, told for whichever platform and assistant the
// headline is naming: the agent proposes in its session, the diff lands in
// Approvals with nothing changed, and only the exact apply call runs and reaches
// History. A system story, no cursor. Each loop moves to the next platform and
// assistant behind a fade of both bodies, so no data rewinds in view.

export type Scenario = {
  /** Provider id, as in its tools (`google` for google_set_budget). */
  id: string
  platform: string
  campaign: string
  currency: string
  from: number
  to: number
  /** The platform's mark as SVG markup; the host page passes the artwork it already draws. */
  markHtml?: string
}

export type Agent = { name: string; markHtml?: string }

export const SCENARIOS: Scenario[] = [
  { id: 'google', platform: 'Google Ads', campaign: 'Brand Search US', currency: '$', from: 40, to: 48 },
  { id: 'meta', platform: 'Meta Ads', campaign: 'Retargeting EU', currency: '€', from: 25, to: 30 },
  { id: 'tiktok', platform: 'TikTok Ads', campaign: 'Spark test', currency: '$', from: 50, to: 55 },
  { id: 'apple', platform: 'Apple Ads', campaign: 'Search Match US', currency: '$', from: 80, to: 100 },
  { id: 'microsoft', platform: 'Microsoft Ads', campaign: 'Brand Exact', currency: '$', from: 30, to: 36 },
  { id: 'reddit', platform: 'Reddit Ads', campaign: 'r/gaming promo', currency: '$', from: 50, to: 60 },
  { id: 'snapchat', platform: 'Snapchat Ads', campaign: 'Story ads UK', currency: '£', from: 40, to: 48 },
  { id: 'spotify', platform: 'Spotify Ads', campaign: 'Podcast reach', currency: '$', from: 100, to: 120 },
  { id: 'pinterest', platform: 'Pinterest Ads', campaign: 'Holiday pins', currency: '$', from: 35, to: 42 },
  { id: 'linkedin', platform: 'LinkedIn Ads', campaign: 'B2B leads EU', currency: '€', from: 60, to: 72 },
  { id: 'x', platform: 'X Ads', campaign: 'Launch week', currency: '$', from: 45, to: 54 },
]

const AGENTS: Agent[] = [{ name: 'Claude Code' }]

type Run = 'off' | 'run' | 'ok'
type S = {
  k: number
  ask: string
  preview: Run
  ready: boolean
  pending: boolean
  apply: string
  applyRun: Run
  applied: boolean
  validated: boolean
  logged: boolean
  done: boolean
  away: boolean
}

const START: S = { k: 0, ask: '', preview: 'off', ready: false, pending: false, apply: '', applyRun: 'off', applied: false, validated: false, logged: false, done: false, away: false }
const CONFIRM = 'Apply it'
const money = (c: string, n: number) => `${c}${n.toFixed(2)}`
const delta = (s: Scenario) => `+${(((s.to - s.from) / s.from) * 100).toFixed(1)}%`
const askFor = (s: Scenario) => `Raise ${s.campaign} to ${s.currency}${s.to}/day`

const NAV = [
  ['Overview', PiSquaresFour],
  ['AI assistants', PiTerminalWindow],
  ['Accounts', PiStack],
  ['Approvals', PiCheckCircle],
  ['Projects', PiFolders],
  ['Policies', PiShieldCheck],
] as const

function Mark({ s, size }: { s: Scenario; size: number }) {
  if (s.markHtml) return <span className="gh-mark" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: s.markHtml }} />
  return <PlatformMark name={s.id as 'google'} size={size} />
}

// The assistant's composer line: no shell path, since a chat app has none.
function Ask({ children }: { children: string }) {
  return (
    <div className="gh-ask">
      <span className="gh-ask__sigil">❯</span>
      <span>{children}</span>
    </div>
  )
}

function ToolLine({ tool, kind, run }: { tool: string; kind: string; run: Run }) {
  return (
    <div className="gh-tool">
      <span className="gh-tool__mark">
        <States value={run === 'ok' ? 'ok' : 'run'} states={{ run: <Spinner size={11} />, ok: <span className="ok">●</span> }} />
      </span>
      <span>{tool}</span>
      <span className="dim">{kind}</span>
    </div>
  )
}

function Session({ s, sc, agent }: { s: S; sc: Scenario; agent: Agent }) {
  const tool = `${sc.id}_set_budget`
  return (
    <Window chrome="terminal" title="adport MCP" className="gh-term" data-away={s.away || undefined}>
      <div className="gh-term__body">
        <div className="gh-agent">
          {agent.markHtml ? <span className="gh-agent__mark" dangerouslySetInnerHTML={{ __html: agent.markHtml }} /> : null}
          <span>{agent.name}</span>
          <span className="dim">connected</span>
        </div>
        <Ask>{s.ask}</Ask>
        <Collapse open={s.preview !== 'off'}><ToolLine tool={tool} kind="preview" run={s.preview} /></Collapse>
        <Collapse open={s.ready}><div className="gh-out dim">Nothing changed yet.</div></Collapse>
        <Collapse open={s.ready}><Ask>{s.apply}</Ask></Collapse>
        <Collapse open={s.applyRun !== 'off'}><ToolLine tool={tool} kind="apply" run={s.applyRun} /></Collapse>
        <Collapse open={s.done}><div className="gh-out ok">Done. {money(sc.currency, sc.to)} a day, logged.</div></Collapse>
      </div>
    </Window>
  )
}

export function Ticket({ sc = SCENARIOS[0], applied }: { sc?: Scenario; applied: boolean }) {
  return (
    <div className="gh-ticket" data-target="ticket">
      <div className="gh-ticket__top">
        <Mark s={sc} size={16} />
        <span className="gh-ticket__name">{sc.campaign} daily budget</span>
        <span className="gh-ticket__platform">{sc.platform}</span>
      </div>
      <div className="gh-diff">
        <s className="gh-diff__from">{money(sc.currency, sc.from)}</s>
        <span className="gh-diff__arrow" aria-hidden />
        <span className="gh-diff__to">{money(sc.currency, sc.to)}</span>
        <span className="gh-diff__delta">{delta(sc)}</span>
      </div>
      <div className="gh-checks">
        <div className="gh-check"><Check on size={14} />Inside the 25% change cap</div>
        <div className="gh-check"><Check on size={14} />Account is not protected</div>
      </div>
      <div className="gh-state">
        <States
          align="start"
          value={applied ? 'applied' : 'pending'}
          states={{
            pending: <span className="gh-state__pending"><i aria-hidden />Preview, not applied</span>,
            applied: <span className="gh-state__applied"><i aria-hidden />Applied</span>,
          }}
        />
      </div>
    </div>
  )
}

export function EventRow({ event, tone, summary, when }: { event: string; tone?: string; summary: string; when: string }) {
  return (
    <div className="gh-event">
      <span className="gh-event__tag" data-tone={tone}>{event}</span>
      <span className="gh-event__summary">{summary}</span>
      <span className="gh-event__when">{when}</span>
    </div>
  )
}

function Page({ s, sc }: { s: S; sc: Scenario }) {
  const change = `${sc.campaign} to ${money(sc.currency, sc.to)}`
  return (
    <div className="gh-page">
      <section className="gh-card">
        <div className="gh-card__head">
          <span>Pending changes</span>
          <span className="gh-count" data-zero={s.pending && !s.applied ? undefined : true}><Count value={s.pending && !s.applied ? 1 : 0} /></span>
        </div>
        <Collapse open={!s.pending}><div className="gh-none">No changes awaiting approval</div></Collapse>
        <Collapse open={s.pending}><Ticket sc={sc} applied={s.applied} /></Collapse>
      </section>
      <section className="gh-card">
        <div className="gh-card__head"><span>History</span></div>
        <Collapse open={s.logged}><EventRow event="Applied" tone="go" summary={change} when="Now" /></Collapse>
        <Collapse open={s.validated}><EventRow event="Previewed" summary={change} when="Now" /></Collapse>
        <EventRow event="Rejected" tone="stop" summary="Budget +60% is over the 25% cap" when="1d" />
        <EventRow event="Applied" tone="go" summary="Campaign created paused" when="3d" />
        <EventRow event="Rejected" tone="stop" summary="Client account is protected" when="5d" />
        <div className="gh-event gh-event--filler"><Bar w={52} h={7} tone={2} /><Bar w={190} h={7} tone={2} /></div>
      </section>
    </div>
  )
}

export function GateHero({ scenarios = SCENARIOS, agents = AGENTS, onScenario }: { scenarios?: Scenario[]; agents?: Agent[]; onScenario?: (index: number) => void }) {
  async function script(a: Act<S>) {
    let k = 0
    await a.set((state) => { k = state.k; return {} })
    const sc = scenarios[k % scenarios.length]
    onScenario?.(k)
    await a.wait(600)
    a.mark('ask')
    await a.type('ask', askFor(sc))
    await a.wait(300)
    await a.set({ preview: 'run' })
    await a.wait(800)
    a.mark('diff')
    await a.set({ preview: 'ok', pending: true, validated: true })
    await a.wait(450)
    await a.set({ ready: true })
    await a.wait(1800)
    a.mark('apply')
    await a.type('apply', CONFIRM)
    await a.wait(250)
    await a.set({ applyRun: 'run' })
    await a.wait(700)
    a.mark('runs')
    await a.set({ applyRun: 'ok', applied: true, logged: true })
    await a.wait(450)
    await a.set({ done: true })
    await a.wait(2200)
    a.mark('reset')
    // The handled card and its rows leave as they would; the session clears behind a fade
    // while the next platform and assistant take over the headline.
    await a.set({ away: true, pending: false, validated: false, logged: false })
    await a.wait(300)
    await a.set({ preview: 'off', ready: false, applyRun: 'off', done: false })
    await a.wait(450)
    await a.snap({ ...START, k: (k + 1) % scenarios.length, away: true })
    await a.set({ away: false })
    await a.wait(250)
  }

  return (
    <Stage
      width={720}
      height={500}
      compact={{ below: 560, width: 358, height: 620 }}
      theme="light"
      greys="cool"
      fidelity="realistic"
      initial={START}
      poster={{ ...START, ask: askFor(scenarios[0]), preview: 'ok', ready: true, pending: true, apply: CONFIRM, applyRun: 'ok', applied: true, validated: true, logged: true, done: true }}
      script={script}
      className="ap-look gh"
    >
      {(s, _rect, layout) => {
        const sc = scenarios[s.k % scenarios.length]
        const agent = agents[s.k % agents.length]
        return layout === 'compact' ? (
          <>
            <Session s={s} sc={sc} agent={agent} />
            <div className="gh-fade"><Window title="Approvals" className="gh-window"><Page s={s} sc={sc} /></Window></div>
          </>
        ) : (
          <>
            <div className="gh-fade">
              <Window
                title="Approvals"
                className="gh-window"
                sidebarWidth={152}
                sidebar={
                  <nav className="gh-nav">
                    {NAV.map(([label, Glyph]) => (
                      <div key={label} className="gh-nav__item" data-on={label === 'Approvals' || undefined}>
                        <Glyph size={16} />
                        {label}
                      </div>
                    ))}
                  </nav>
                }
              >
                <Page s={s} sc={sc} />
              </Window>
            </div>
            <Session s={s} sc={sc} agent={agent} />
          </>
        )
      }}
    </Stage>
  )
}
