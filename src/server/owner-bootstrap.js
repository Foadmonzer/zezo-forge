import { randomBytes, scryptSync } from 'node:crypto';

const usernamePattern = /^[a-z0-9._-]{3,40}$/;

function cleanText(value, max) {
  return String(value ?? '').trim().replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, max);
}

export async function provisionFirstOwner({ client, name, username, email = '', password }) {
  const fullName = cleanText(name, 80);
  const normalizedUsername = cleanText(username, 40).toLowerCase();
  const normalizedEmail = cleanText(email, 150).toLowerCase();
  const secret = String(password ?? '');
  if (!client?.query) throw new Error('A PostgreSQL client is required.');
  if (fullName.length < 2 || !usernamePattern.test(normalizedUsername)) throw new Error('Enter a valid Owner name and username.');
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('Enter a valid email address or leave it blank.');
  if (secret.length < 12 || secret.length > 200) throw new Error('The bootstrap password must be 12–200 characters.');

  await client.query('BEGIN');
  try {
    // Dedicated lock for one-time bootstrap; no public route can invoke this code.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 2]);
    const owners = await client.query("SELECT 1 FROM user_accounts WHERE role = 'admin' LIMIT 1");
    if (owners.rowCount) throw new Error('Owner bootstrap is closed because an Owner account already exists.');

    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(secret, salt, 64).toString('hex');
    const accountId = `usr_${randomBytes(18).toString('base64url')}`;
    const createdAt = new Date();
    const accountData = { name: fullName, salt, mustChangePassword: true, department: 'executive', permissionOverrides: {} };
    await client.query(
      `INSERT INTO user_accounts (id, email, username, role, active, "fullName", "passwordHash", data, "createdAt", "updatedAt")
       VALUES ($1, NULLIF($2, ''), $3, 'admin', TRUE, $4, $5, $6::jsonb, $7, $7)`,
      [accountId, normalizedEmail, normalizedUsername, fullName, passwordHash, JSON.stringify(accountData), createdAt]
    );
    await client.query(
      `INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
       VALUES ($1, NULL, 'admin_owner_provisioned', $2, $3::jsonb, $4)`,
      [`evt_${randomBytes(18).toString('base64url')}`, accountId, JSON.stringify({ actor: 'bootstrap-cli', role: 'system', detail: 'First Owner provisioned by private administrative CLI' }), createdAt]
    );
    await client.query('COMMIT');
    return { id: accountId, username: normalizedUsername, email: normalizedEmail, mustChangePassword: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
