import { providerLabel } from './logos';
import { Disclosure } from './controls';

export function ReportCoverage({ warnings = [], limited = false }: { warnings?: Array<{ provider: string; message: string }>; limited?: boolean }) {
  if (!warnings.length && !limited) return null;
  const providers = [...new Set(warnings.map(warning => providerLabel(warning.provider)))];
  return <Disclosure className="report-coverage" label={<><span className="status warn">Partial results</span>{providers.length ? <span>{providers.join(', ')} unavailable</span> : null}</>}>
    {warnings.length ? <ul>{warnings.map(warning => <li key={warning.provider + ':' + warning.message}>{warning.message}</li>)}</ul> : null}
    {limited ? <p>Some campaign rows were not included. Totals may be incomplete.</p> : null}
  </Disclosure>;
}
