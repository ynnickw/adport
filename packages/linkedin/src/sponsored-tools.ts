import { creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsProvider } from './provider.js';
import { leadBinding } from './lead-creatives.js';
import { creativeUrn, imageUrn } from './creative-tools.js';
import { linkedinId, NON_POLITICAL_CONSENT } from './schemas.js';

export const postUrn = z.string().regex(/^urn:li:(?:share|ugcPost):[1-9]\d*$/);
export const organizationUrn = z.string().regex(/^urn:li:organization:[1-9]\d*$/);
const href = z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP(S) URL without embedded credentials');
export const postCta = z.enum(['APPLY', 'DOWNLOAD', 'VIEW_QUOTE', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'REGISTER', 'JOIN', 'ATTEND', 'REQUEST_DEMO', 'SEE_MORE', 'BUY_NOW', 'SHOP_NOW']);
const title = z.string().min(1).max(399), alt = z.string().max(4085), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sponsoredContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('TEXT') }).strict(),
  z.object({ type: z.literal('IMAGE'), image_id: imageUrn, title, alt_text: alt.optional() }).strict(),
  z.object({ type: z.literal('VIDEO'), video_id: z.string().regex(/^urn:li:video:[A-Za-z0-9_-]+$/), title, alt_text: alt.optional() }).strict(),
  z.object({ type: z.literal('DOCUMENT'), document_id: z.string().regex(/^urn:li:document:[A-Za-z0-9_-]+$/), title }).strict(),
  z.object({ type: z.literal('ARTICLE'), source: href, title, description: z.string().max(400).optional(), thumbnail: imageUrn.optional() }).strict(),
  z.object({ type: z.literal('CAROUSEL'), cards: z.array(z.object({ image_id: imageUrn, title, alt_text: alt.optional(), landing_page: href }).strict()).min(2).max(10) }).strict(),
]);
const createBase = { campaign_id: linkedinId, name: z.string().trim().min(1).max(200), status: z.enum(['PAUSED', 'ACTIVE', 'DRAFT']).default('PAUSED'), non_political_consent: z.literal(true).describe(NON_POLITICAL_CONSENT), lead_form: leadBinding.optional() };
export const createSponsored = z.object({ ...createBase, author_organization: organizationUrn, commentary: z.string().min(1).max(3000), content: sponsoredContent, landing_page: href.optional(), call_to_action: postCta.optional() }).strict();
export const createReference = z.object({ ...createBase, source_creative_id: creativeUrn }).strict();
export const postSelection = z.object({ creative_id: creativeUrn.optional(), post_id: postUrn.optional(), author_organization: organizationUrn.optional(), campaign_id: linkedinId.optional() }).strict().refine(value => value.creative_id ? !value.post_id && !value.author_organization && !value.campaign_id : Boolean(value.post_id && value.author_organization), 'Choose creative_id alone, or post_id with author_organization and an optional owned campaign_id');
const postTarget = { post_id: postUrn, author_organization: organizationUrn, campaign_id: linkedinId.optional(), expected_post_hash: hash, expected_associations_hash: hash };
export const updateSponsoredPost = z.object({ ...postTarget, commentary: z.string().max(3000).optional(), landing_page: href.optional(), call_to_action: postCta.optional(), dsc_name: z.string().trim().min(1).max(200).optional() }).strict().refine(value => value.commentary !== undefined || value.landing_page !== undefined || value.call_to_action !== undefined || value.dsc_name !== undefined, 'Provide supported post changes');
export const archiveSponsoredPost = z.object(postTarget).strict();
export const deleteSponsoredPost = z.object(postTarget).strict();
export const LINKEDIN_SPONSORED_WRITES = new Set(['linkedin_create_sponsored_ad', 'linkedin_create_reference_ad', 'linkedin_update_sponsored_post', 'linkedin_archive_sponsored_post', 'linkedin_delete_sponsored_post']);

export function linkedinSponsoredTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_creative_preview', namespace: 'linkedin', description: 'Render an owned creative using native headline, introduction, body, landing page and primary asset metadata (single-creative API202610). Metadata is read-only; missing fields stay unavailable. Account/campaign ownership is checked.', input: z.object({ account_id: linkedinId, creative_id: creativeUrn }), output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.sponsored.preview(input.account_id, input.creative_id) }),
    defineTool({ name: 'linkedin_get_sponsored_post', namespace: 'linkedin', description: 'Read a creative’s actual post and referenced media, or an account-owned dark post, with content/association hashes. Posts reads additionally require native Page/social permissions. Only account-owned dark posts receive shared-copy edit forms.', input: postSelection.safeExtend({ account_id: linkedinId }), output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: ({ account_id, ...input }) => provider.sponsored.postContext(account_id, input) }),
    guardedWriteTool({ name: 'linkedin_create_sponsored_ad', namespace: 'linkedin', provider: 'linkedin', kind: 'create', description: 'Create a text, image, video, document, article or carousel creative and dark post. ACTIVE is coerced PAUSED by policy; DRAFT stays editable. For lead campaigns provide lead_form with current hashes and confirm_public_post. Fresh lead documents support gated preview pages; no document/post reuse. Uses AVAILABLE owned media and the parent campaign’s exact organization/format. Native post is PUBLISHED/PUBLIC but feedDistribution NONE and reshares disabled: accessible by URL, not an organic Page-feed post. Page authorization still applies; no server dry-run.', payload: createSponsored, destructive: false }),
    guardedWriteTool({ name: 'linkedin_create_reference_ad', namespace: 'linkedin', provider: 'linkedin', kind: 'create', description: 'Create a paused creative reusing the post of an existing creative in this same account, under a compatible owned campaign/Page. Does not publish another post or change the source ad. For lead campaigns supply lead_form with current form/campaign/source hashes; document lead ads require a fresh document through sponsored-ad creation.', payload: createReference, destructive: false }),
    guardedWriteTool({ name: 'linkedin_update_sponsored_post', namespace: 'linkedin', provider: 'linkedin', kind: 'update', description: 'Edit supplied commentary, destination, CTA or DSC name on an account-owned dark post. Affects all its creatives; preview enumerates and hash-binds them. Preserves media, author, distribution, post lifecycle and every creative delivery status. Native Page read/write permissions required.', payload: updateSponsoredPost }),
    guardedWriteTool({ name: 'linkedin_archive_sponsored_post', namespace: 'linkedin', provider: 'linkedin', kind: 'update', description: 'Irreversibly archive an account-owned dark post through adContext.dscStatus=ARCHIVED. Native LinkedIn cancels its linked creatives. Preview enumerates and hash-binds all associations; this cannot be undone. Requires native Page permissions.', payload: archiveSponsoredPost }),
    guardedWriteTool({ name: 'linkedin_delete_sponsored_post', namespace: 'linkedin', provider: 'linkedin', kind: 'remove', description: 'Permanently delete an account-owned dark post only after all selected-account creative references are REMOVED/CANCELED or absent. Complete bounded association lookup and exact content/association hashes are required. Does not delete uploaded media. Requires native Page permissions.', payload: deleteSponsoredPost }),
  ];
}
