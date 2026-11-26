export default function AccountSelectionLoading() {
  return <main className="page account-selection-loading" aria-busy="true">
    <h1 role="status">Opening account selection…</h1>
    <p>Next, choose the accounts to add to your project.</p>
    <div className="card account-selection-skeleton" aria-hidden="true">
      <span /><span /><span /><span />
    </div>
  </main>;
}
