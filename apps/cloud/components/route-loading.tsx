import { SkeletonRows } from './feedback';
import { PageHeader } from './ui';

export function RouteLoading({ title, label, layout = 'list' }: { title?: string; label: string; layout?: 'list' | 'grid' }) {
  return <main className="page">
    {title ? <PageHeader title={title} /> : null}
    <span className="sr-only" role="status">{label}</span>
    {layout === 'grid' ? <div className="route-loading-grid" aria-hidden="true">
      {[0, 1, 2, 3].map(index => <div className="skeleton-line" key={index} />)}
    </div> : <SkeletonRows className="skeleton-card route-loading-rows" secondary />}
  </main>;
}
