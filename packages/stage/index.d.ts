// The public scenes. Consumers type-check against this, not the kit's source, so
// the vendored kit needn't meet each app's stricter compiler flags.
import type { ReactElement } from 'react';

export type Scenario = { id: string; platform: string; campaign: string; currency: string; from: number; to: number; markHtml?: string };
export type Agent = { name: string; markHtml?: string };
export const SCENARIOS: Scenario[];
export function GateHero(props: { scenarios?: Scenario[]; agents?: Agent[]; onScenario?: (index: number) => void }): ReactElement;
export function CreateCard(): ReactElement;
export function PauseCard(): ReactElement;
export function CapCard(): ReactElement;
export function KeywordsCard(): ReactElement;
