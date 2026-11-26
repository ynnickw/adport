import { RouteLoading } from '@/components/route-loading';

export default function Loading() {
  return <div className="onboarding-page"><div className="onboarding-shell">
    <RouteLoading title="Project setup" label="Loading your setup…" />
  </div></div>;
}
