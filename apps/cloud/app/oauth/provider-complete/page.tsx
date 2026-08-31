import { popupDestination, validPopupId } from '@/lib/oauth-popup';
import { PopupComplete } from './popup-complete';

export const metadata = { title: 'Return to Adport' };
export const dynamic = 'force-dynamic';

export default async function ProviderCompletePage({ searchParams }: {
  searchParams: Promise<{ popup_id?: string; next?: string }>;
}) {
  const params = await searchParams;
  return <PopupComplete popupId={validPopupId(params.popup_id) ? params.popup_id : undefined}
    next={popupDestination(params.next) ?? '/dashboard/connections'} />;
}
