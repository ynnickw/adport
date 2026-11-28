import 'server-only';
import type postgres from 'postgres';
import { db } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { getOrganizationEntitlement } from './plans';

interface TransferInput {
  actorUserId: string;
  projectId: string;
  sourceOrganizationId: string;
  destinationOrganizationId: string;
}

interface TransferOrganization { id: string; name: string; defaultProjectId: string }

export async function transferProject({ actorUserId, projectId, sourceOrganizationId, destinationOrganizationId }: TransferInput) {
  if (sourceOrganizationId === destinationOrganizationId) throw new HttpError('Choose a different organization.', 400);

  return db().begin(async sql => {
    const organizationIds = [sourceOrganizationId, destinationOrganizationId];
    // Membership, billing, and account changes serialize on these same rows.
    await sql`select id from public.organization_groups where id in ${sql(organizationIds)} order by id for update`;
    const owned = await sql<TransferOrganization[]>`
      select company.id, company.name, company.default_project_id from public.organization_groups company
      join public.organization_group_memberships member on member.organization_group_id = company.id
      where company.id in ${sql(organizationIds)} and member.user_id = ${actorUserId} and member.role = 'owner'`;
    const source = owned.find(company => company.id === sourceOrganizationId);
    const destination = owned.find(company => company.id === destinationOrganizationId);
    if (!source || !destination) throw new HttpError('You must be an Owner in both organizations to transfer a project.', 403);

    const [project] = await sql<Array<{ name: string; archivedAt: Date | null }>>`
      select name, archived_at from public.organizations
      where id = ${projectId} and organization_group_id = ${source.id} for no key update`;
    if (!project) throw new HttpError('This project is no longer in the source organization.', 409);
    if (projectId === source.defaultProjectId) throw new HttpError('The default project is tied to organization billing and cannot be transferred.', 409);

    const { plan } = await getOrganizationEntitlement(destination.defaultProjectId, sql);
    if (!project.archivedAt && plan.maxActiveAccounts !== null) {
      const [accounts] = await sql<Array<{ destination: number; moving: number }>>`
        select (count(*) filter (where project.organization_group_id = ${destination.id}))::int as destination,
          (count(*) filter (where project.id = ${projectId}))::int as moving
        from public.organization_ad_accounts account join public.organizations project on project.id = account.organization_id
        where (project.organization_group_id = ${destination.id} or project.id = ${projectId})
          and project.archived_at is null and account.enabled and private.provider_uses_ad_account_slot(account.provider)`;
      const { destination: enabledAtDestination, moving: enabledOnProject } = accounts!;
      const total = enabledAtDestination + enabledOnProject;
      if (enabledOnProject && total > plan.maxActiveAccounts) throw new HttpError(
        `${destination.name} would have ${total} enabled ad accounts, and its ${plan.name} plan allows ${plan.maxActiveAccounts}. Disable accounts or upgrade the destination plan before transferring.`, 409,
      );
    }

    // Remove source grants before updating the parent so membership triggers
    // recalculate seats in the source organization.
    await clearProjectAccess(sql, projectId, source.id);
    await sql`update public.organizations set organization_group_id = ${destination.id} where id = ${projectId}`;
    await sql`update public.organization_settings set data_retention_days = ${plan.maxRetentionDays}
      where organization_id = ${projectId} and data_retention_days > ${plan.maxRetentionDays}`;

    const details = sql.json({ sourceOrganizationId: source.id, destinationOrganizationId: destination.id });
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary, details) values
      (${source.defaultProjectId}, ${actorUserId}, 'settings_updated', 'cloud', 'project_transfer', ${projectId},
        ${`Transferred ${project.name} to ${destination.name}`}, ${details}),
      (${projectId}, ${actorUserId}, 'settings_updated', 'cloud', 'project_transfer', ${projectId},
        ${`Transferred from ${source.name} to ${destination.name}`}, ${details})`;
    return { archived: Boolean(project.archivedAt), destinationProjectId: destination.defaultProjectId };
  });
}

async function clearProjectAccess(sql: postgres.TransactionSql, projectId: string, sourceOrganizationId: string) {
  await sql`delete from public.organization_memberships where organization_id = ${projectId}`;
  await sql`update private.member_invitations set canceled_at = now()
    where organization_group_id = ${sourceOrganizationId} and (project_id = ${projectId} or ${projectId} = any(project_ids))
      and accepted_at is null and canceled_at is null`;
  await sql`update public.api_keys set revoked_at = now() where organization_id = ${projectId} and revoked_at is null`;
  await sql`update private.mcp_oauth_authorization_codes set consumed_at = now()
    where organization_id = ${projectId} and organization_group_id is null and consumed_at is null`;
  await sql`update private.mcp_oauth_refresh_tokens set revoked_at = now()
    where organization_id = ${projectId} and organization_group_id is null and revoked_at is null`;
  await sql`update private.mcp_oauth_access_tokens set revoked_at = now()
    where organization_id = ${projectId} and organization_group_id is null and revoked_at is null`;
  await sql`update public.pending_operations set consumed_at = now() where organization_id = ${projectId} and consumed_at is null`;
  await sql`update private.oauth_transactions set consumed_at = now() where organization_id = ${projectId} and consumed_at is null`;
  // Keep the connection's selection marker so unverified grants stay disabled.
  await sql`delete from private.provider_account_selections where organization_id = ${projectId}`;
}
