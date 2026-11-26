import { LoadingStatus, SkeletonRows } from './feedback';

export function RouteLoading({ title, label, layout = 'list' }: { title?: string; label: string; layout?: 'list' | 'grid' }) {
  return <main className="page">
    {title ? <h1 className="route-loading-title">{title}</h1> : null}
    <LoadingStatus className="route-loading-status">{label}</LoadingStatus>
    {layout === 'grid' ? <div className="route-loading-grid" aria-hidden="true">
      {[0, 1, 2, 3].map(index => <div className="skeleton-line" key={index} />)}
    </div> : <SkeletonRows className="skeleton-card route-loading-rows" secondary />}
  </main>;
}
