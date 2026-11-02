import { createRoot } from 'react-dom/client'
import type { ReactElement } from 'react'
import { CapCard, CreateCard, GateHero, KeywordsCard, PauseCard, SCENARIOS, type Agent, type Scenario } from './index'

// adport.dev is static: scenes mount into [data-stage] slots. Any semantic markup
// already in a slot stays in the document for screen readers and no-JS readers,
// visually hidden once the illustration, which is aria-hidden, takes over.

// The hero tells its story for the platform and assistant the headline names, using
// the marks the headline already draws, and moves both rotators as it changes.
function heroScene(): ReactElement {
  const marks = [...document.querySelectorAll('.provider-rotator .provider-mark')].map((mark) => mark.innerHTML)
  const scenarios: Scenario[] = SCENARIOS.map((scenario, i) => ({ ...scenario, markHtml: marks[i] }))
  const agents: Agent[] = [...document.querySelectorAll('.agent-rotator .agent')].map((agent) => ({
    name: agent.textContent?.trim().replace(/^any /, '') || 'MCP client',
    markHtml: agent.querySelector('svg')?.outerHTML,
  }))
  const onScenario = (index: number) =>
    window.dispatchEvent(new CustomEvent('adport:scenario', { detail: { provider: index % scenarios.length, agent: index % Math.max(agents.length, 1) } }))
  return <GateHero scenarios={scenarios} agents={agents.length ? agents : undefined} onScenario={onScenario} />
}

const scenes: Record<string, () => ReactElement> = {
  hero: heroScene,
  create: () => <CreateCard />,
  pause: () => <PauseCard />,
  cap: () => <CapCard />,
  keywords: () => <KeywordsCard />,
}

document.querySelectorAll<HTMLElement>('[data-stage]').forEach((slot) => {
  const scene = scenes[slot.dataset.stage ?? '']
  if (!scene) return
  const mount = document.createElement('div')
  mount.className = 'stage-mount'
  mount.setAttribute('aria-hidden', 'true')
  slot.append(mount)
  slot.classList.add('is-live')
  createRoot(mount).render(scene())
})
