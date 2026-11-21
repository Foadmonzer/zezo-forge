import { randomBytes } from 'node:crypto';
import { withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const referralEnabled = role => role === 'marketer' || role === 'developer';
const newReferralCode = () => `Z${randomBytes(16).toString('hex').toUpperCase()}`;
const newId = prefix => `${prefix}_${randomBytes(9).toString('hex')}`;
const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

async function createReferralLink(client, { userId, code, month, kind, createdAt }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const nextCode = code || newReferralCode();
    const id = newId('rfl');
    const result = await client.query(`
      INSERT INTO referral_links (id, "userId", code, month, active, "createdAt", data)
      VALUES ($1, $2, $3, $4, TRUE, $5, $6::jsonb)
      ON CONFLICT (code) DO NOTHING
      RETURNING id, code
    `, [id, userId, nextCode, month, createdAt, JSON.stringify({ kind })]);
    if (result.rowCount) return result.rows[0];

    const existing = await client.query(
      'SELECT id, code FROM referral_links WHERE "userId" = $1 AND code = $2 LIMIT 1',
      [userId, nextCode]
    );
    if (existing.rowCount) return existing.rows[0];
    code = '';
  }
  throw new Error('Could not allocate a unique referral code.');
}

async function ensureReferralLinks(client, user, data, at) {
  if (!referralEnabled(user.role)) return data;

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zezo-referral-links:${user.id}`]);
  let referralCode = String(data.referralCode || '');
  let legacy = referralCode
    ? await client.query('SELECT id, code FROM referral_links WHERE "userId" = $1 AND code = $2 LIMIT 1', [user.id, referralCode])
    : { rowCount: 0, rows: [] };

  if (!legacy.rowCount) {
    legacy = await createReferralLink(client, {
      userId: user.id, code: referralCode, month: 'legacy', kind: 'legacy', createdAt: data.createdAt || at
    }).then(row => ({ rowCount: 1, rows: [row] }));
    referralCode = legacy.rows[0].code;
  }

  const month = at.slice(0, 7);
  const current = await client.query(`
    SELECT id, code FROM referral_links
    WHERE "userId" = $1 AND month = $2 AND data->>'kind' = 'monthly'
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1 FOR UPDATE
  `, [user.id, month]);
  const monthly = current.rowCount ? current.rows[0] : await createReferralLink(client, {
    userId: user.id, code: '', month, kind: 'monthly', createdAt: at
  });

  return {
    ...data,
    referralCode,
    currentReferralCode: monthly.code,
    currentReferralLinkId: monthly.id
  };
}

/** Atomically consumes one employee invite token, provisions a DB-backed session, and audits activation. */
export async function activatePostgresEmployeeInvitation({
  activationHash, credential, sessionHash, sessionExpiresAt, auditId, at
}) {
  return withPostgresScopedTransaction(async client => {
    const selected = await client.query(`
      SELECT id, email, username, role, active, "fullName", "passwordHash", data, "createdAt"
      FROM user_accounts
      WHERE data->>'activationHash' = $1
      LIMIT 1
      FOR UPDATE
    `, [activationHash]);
    const row = selected.rows[0];
    if (!row) return { kind: 'invalid' };

    const data = object(row.data);
    if (row.active || row.passwordHash || data.passwordHash || data.inviteStatus === 'accepted') return { kind: 'already_active' };
    if (data.inviteStatus === 'revoked' || data.inviteStatus === 'expired') return { kind: 'invalid' };
    if (data.inviteApprovalStatus === 'pending_approval') return { kind: 'awaiting_approval' };
    if (!['pending', 'pending_approval'].includes(data.inviteStatus)) return { kind: 'invalid' };

    const invitationId = String(data.invitationId || `invitation_${row.id}`);
    const invitationResult = await client.query(`
      SELECT id, status, "expiresAt"
      FROM employee_invitations
      WHERE id = $1 AND data->>'employeeId' = $2
      FOR UPDATE
    `, [invitationId, row.id]);
    const invitation = invitationResult.rows[0];
    if (!invitation || !['pending', 'pending_approval'].includes(invitation.status)) return { kind: 'invalid' };

    const expiresAt = Number(data.activationExpires || 0) || new Date(invitation.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(at)) {
      const expiredData = { ...data, activationHash: null, activationExpires: 0, inviteStatus: 'expired' };
      await client.query('UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1', [row.id, JSON.stringify(expiredData), at]);
      await client.query('UPDATE employee_invitations SET status = \'expired\' WHERE id = $1', [invitation.id]);
      return { kind: 'expired' };
    }

    const user = {
      ...data,
      id: row.id,
      email: row.email || '',
      username: row.username || '',
      role: row.role,
      active: true,
      name: row.fullName || data.name || '',
      createdAt: iso(row.createdAt),
      ...credential,
      inviteStatus: 'accepted',
      inviteAcceptedAt: at,
      activationHash: null,
      activationExpires: 0
    };
    const activatedData = await ensureReferralLinks(client, user, user, at);

    await client.query(`
      UPDATE user_accounts
      SET active = TRUE, "passwordHash" = $2, data = $3::jsonb, "updatedAt" = $4
      WHERE id = $1
    `, [row.id, credential.passwordHash, JSON.stringify(activatedData), at]);
    await client.query(`
      UPDATE employee_invitations SET status = 'accepted'
      WHERE id = $1 AND data->>'employeeId' = $2 AND status IN ('pending', 'pending_approval')
    `, [invitation.id, row.id]);
    await client.query(
      'INSERT INTO auth_sessions (id, "userId", "expiresAt", data) VALUES ($1, $2, $3, $4::jsonb)',
      [sessionHash, row.id, sessionExpiresAt, '{}']
    );
    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, 'account_activated', $2, $3::jsonb, $4)
    `, [auditId, row.id, JSON.stringify({ actor: user.username, role: user.role, detail: '' }), at]);

    const managers = await client.query(`
      SELECT id, role FROM user_accounts
      WHERE active = TRUE AND role IN ('admin', 'hr_manager') AND id <> $1
    `, [row.id]);
    for (const manager of managers.rows) {
      const tab = manager.role === 'admin' ? 'team' : 'people';
      const notificationId = newId('ntf');
      const notification = {
        eventKey: `audit:${auditId}`,
        type: 'team', importance: 'normal',
        titleAr: 'فعّل موظف حسابه', titleEn: 'An employee activated an account',
        descriptionAr: 'أكمل الموظف تفعيل الحساب.', descriptionEn: 'The employee completed account activation.',
        createdAt: at, readAt: '', target: { tab, id: row.id, kind: 'employee' }
      };
      await client.query(`
        INSERT INTO system_notifications (id, "userId", type, "readAt", data, "createdAt")
        SELECT $1, $2, 'team', NULL, $3::jsonb, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM system_notifications existing
          WHERE existing."userId" = $2 AND existing.data->>'eventKey' = $5
        )
      `, [notificationId, manager.id, JSON.stringify(notification), at, notification.eventKey]);
    }

    return { kind: 'activated', user: activatedData };
  });
}
