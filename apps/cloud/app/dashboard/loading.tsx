export default function Loading() {
  return (
    <main className="page" aria-busy="true" aria-label="Loading workspace">
      <div className="page-head">
        <div style={{ flex: 1 }}>
          <div className="skeleton-line" style={{ width: '14rem', height: '1.7rem', marginBottom: '0.8rem' }} />
          <div className="skeleton-line" style={{ width: 'min(26rem, 100%)', height: '0.7rem' }} />
        </div>
      </div>
      <div className="metrics">
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton-card" key={i}>
            <div className="skeleton-line" style={{ width: '4.5rem', height: '0.55rem', marginBottom: '1rem' }} />
            <div className="skeleton-line" style={{ width: '6.5rem', height: '1.3rem', marginBottom: '0.6rem' }} />
            <div className="skeleton-line" style={{ width: '5.5rem', height: '0.5rem' }} />
          </div>
        ))}
      </div>
      <div className="skeleton-card">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="skeleton-line" style={{ width: '100%', height: '0.7rem', marginBottom: i === 4 ? 0 : '1.05rem', opacity: 1 - i * 0.15 }} key={i} />
        ))}
      </div>
    </main>
  );
}
