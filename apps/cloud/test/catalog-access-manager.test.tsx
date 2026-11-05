// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogAccessManager } from '@/app/dashboard/accounts/catalog-access-manager';

const project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', account = { accountId: '123', name: 'QA TikTok', ready: true }, fetchMock = vi.fn();
const grants = Array.from({ length: 14 }, (_, index) => ({ scope: { accountId: '123', businessId: '456', resourceId: String(700 + index), kind: 'catalog' }, mode: 'read', hash: 'a'.repeat(64) }));
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);fetchMock.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') { const params = new URLSearchParams(_url.split('?')[1]);return Response.json({ grants, organizationId: params.get('organizationId'), account_id: params.get('account_id') }); }
    const args = JSON.parse(String(init.body));
    if (args.pending_operation_id) return Response.json({ result: { applied: true } });
    return Response.json({ arguments: { ...args, expected_access_hash: 'b'.repeat(64) }, result: { pending_operation_id: 'pending-one', preview: { review: { subject: 'QA <catalog>', fields: [{ label: 'Business Center', after: 'QA BC' }, { label: 'Project access', before: 'none', after: args.mode }] } } } });
  });
});
afterEach(() => { cleanup();vi.unstubAllGlobals(); });
async function open() { const summary = screen.getByText('TikTok catalog access').closest('summary')!;if (!summary.closest('details')!.open) fireEvent.click(summary);fireEvent.click(screen.getByRole('button', { name: 'Manage catalog access' }));await screen.findByText('Catalog 700'); }
describe('compact owner catalog access UI', () => {
  it('defers reads until opened and expands its local list without remounting existing rows', async () => {
    render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[account]} />);expect(fetchMock).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull();await open();
    const first = screen.getByText('Catalog 700');expect(screen.queryByText('Catalog 713')).toBeNull();fireEvent.click(screen.getByText('Load more'));expect(screen.getByText('Catalog 713')).toBeDefined();expect(screen.getByText('Catalog 700')).toBe(first);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reviews before saving, applies exact bound arguments and leaves the library/dialog mounted', async () => {
    render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[account]} />);await open();const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByLabelText('Business Center ID'), { target: { value: '456' } });fireEvent.change(screen.getByLabelText('Catalog ID'), { target: { value: '789' } });fireEvent.change(screen.getByLabelText('Project access'), { target: { value: 'write' } });fireEvent.click(screen.getByText('Review access'));
    await screen.findByText('QA <catalog>');expect(dialog.querySelector('catalog')).toBeNull();expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);expect(JSON.parse(fetchMock.mock.calls.find(call => call[1]?.method === 'POST')![1].body)).not.toHaveProperty('pending_operation_id');
    fireEvent.click(screen.getByText('Confirm access'));await screen.findByText('Catalog access updated.');expect(screen.getByRole('dialog')).toBe(dialog);const writes = fetchMock.mock.calls.filter(call => call[1]?.method === 'POST');expect(writes).toHaveLength(2);expect(JSON.parse(writes[1]![1].body)).toEqual({ organizationId: project, account_id: '123', bc_id: '456', catalog_id: '789', mode: 'write', expected_access_hash: 'b'.repeat(64), pending_operation_id: 'pending-one' });
  });
  it('reviews and applies new-catalog delegation without a catalog ID and resets approval on resource changes', async () => {
    render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[account]} />);await open();fireEvent.change(screen.getByLabelText('Business Center ID'), { target: { value: '456' } });fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'catalog_creation' } });expect(screen.queryByLabelText('Catalog ID')).toBeNull();expect((screen.getByLabelText('Project access') as HTMLSelectElement).value).toBe('create');expect(screen.getByText(/Existing catalogs are excluded/)).toBeDefined();fireEvent.click(screen.getByText('Review access'));await screen.findByText('Confirm access');
    const first = JSON.parse(fetchMock.mock.calls.find(call => call[1]?.method === 'POST')![1].body);expect(first).toEqual({ organizationId: project, account_id: '123', bc_id: '456', resource_kind: 'catalog_creation', mode: 'create' });fireEvent.click(screen.getByText('Confirm access'));await screen.findByText('Catalog access updated.');expect(JSON.parse(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')[1]![1].body)).toEqual({ ...first, expected_access_hash: 'b'.repeat(64), pending_operation_id: 'pending-one' });
    fireEvent.click(screen.getByText('Review access'));await screen.findByText('Confirm access');fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'catalog' } });expect(screen.queryByText('Confirm access')).toBeNull();expect(screen.getByLabelText('Catalog ID')).toBeDefined();
  });
  it('shows existing creation grants and can prepare their revocation without a ready advertiser', async () => {
    const normal = fetchMock.getMockImplementation()!;fetchMock.mockImplementation(async (url: string, init?: RequestInit) => { if (init?.method === 'POST') return normal(url, init);return Response.json({ organizationId: project, account_id: '123', grants: [...grants, { scope: { accountId: '123', businessId: '456', resourceId: '456', kind: 'catalog_creation' }, mode: 'create', hash: 'a'.repeat(64) }] }); });
    render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[{ ...account, ready: false }]} />);await open();fireEvent.click(screen.getByText('Load more'));fireEvent.click(screen.getByRole('button', { name: /New catalogs.*Business Center/ }));expect(screen.queryByLabelText('Catalog ID')).toBeNull();fireEvent.change(screen.getByLabelText('Project access'), { target: { value: 'none' } });fireEvent.click(screen.getByText('Review access'));await screen.findByText('Confirm access');expect(JSON.parse(fetchMock.mock.calls.find(call => call[1]?.method === 'POST')![1].body)).toEqual({ organizationId: project, account_id: '123', bc_id: '456', resource_kind: 'catalog_creation', mode: 'none' });
  });
  it('invalidates a prepared approval when the selected resource changes', async () => {
    render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[account]} />);await open();fireEvent.change(screen.getByLabelText('Business Center ID'), { target: { value: '456' } });fireEvent.change(screen.getByLabelText('Catalog ID'), { target: { value: '789' } });fireEvent.click(screen.getByText('Review access'));await screen.findByText('Confirm access');fireEvent.change(screen.getByLabelText('Catalog ID'), { target: { value: '790' } });expect(screen.queryByText('Confirm access')).toBeNull();expect(screen.getByText('Review access')).toBeDefined();
  });
  it('keeps revocation available while granting is disabled for a disconnected advertiser', async () => {
    render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[{ ...account, ready: false }]} />);await open();expect((screen.getByLabelText('Project access') as HTMLSelectElement).value).toBe('none');expect((screen.getByRole('option', { name: 'Read and write' }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Business Center ID'), { target: { value: '456' } });fireEvent.change(screen.getByLabelText('Catalog ID'), { target: { value: '789' } });fireEvent.click(screen.getByText('Review access'));await screen.findByText('Confirm access');const request = fetchMock.mock.calls.find(call => call[1]?.method === 'POST')!;expect(JSON.parse(request[1].body).mode).toBe('none');
  });
  it('rejects a mismatched project/resource preview and never submits its token', async () => {
    const normal = fetchMock.getMockImplementation()!;fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const response = await normal(url, init);if (init?.method !== 'POST') return response;const data = await response.json();return Response.json({ ...data, arguments: { ...data.arguments, organizationId: 'other-project' } });
    });render(<CatalogAccessManager organizationId={project} projectName="Adport" accounts={[account]} />);await open();fireEvent.change(screen.getByLabelText('Business Center ID'), { target: { value: '456' } });fireEvent.change(screen.getByLabelText('Catalog ID'), { target: { value: '789' } });fireEvent.click(screen.getByText('Review access'));await screen.findByRole('alert');expect(screen.queryByText('Confirm access')).toBeNull();expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('discards the old scope and aborts its load when the project changes', async () => {
    const view = render(<CatalogAccessManager key={project} organizationId={project} projectName="Adport" accounts={[account]} />);await open();const initialSignal = fetchMock.mock.calls[0]![1]?.signal as AbortSignal;
    view.rerender(<CatalogAccessManager key="new-project" organizationId="new-project" projectName="Other" accounts={[account]} />);expect(screen.queryByRole('dialog')).toBeNull();expect(initialSignal.aborted).toBe(true);await open();await waitFor(() => expect(fetchMock.mock.calls.at(-1)![0]).toContain('organizationId=new-project'));
  });
});
