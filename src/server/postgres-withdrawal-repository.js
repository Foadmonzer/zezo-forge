import { randomBytes } from 'node:crypto';
import { withPostgresScopedTransaction } from './postgres-runtime.js';

const activeStatuses = ['pending', 'under_review', 'approved', 'awaiting_transfer', 'requested'];
const moneyCents = value => Math.round((Number(value) || 0) * 100);
const ils = cents => Number((cents / 100).toFixed(2));
const clean = (value, max) => String(value ?? '').trim().replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, max);
const rowId = prefix => `${prefix}_${randomBytes(18).toString('base64url')}`;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function allocatedFor(withdrawal, requestId, kind, outstanding) {
  const data = object(withdrawal.data);
  const items = Array.isArray(data.commissionItems) ? data.commissionItems : [];
  const matches = items.filter(item => item?.leadId === requestId && (item.kind || 'referral') === kind);
  if (matches.length) {
    if (matches.some(item => !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0)) return outstanding;
    return matches.reduce((sum, item) => sum + moneyCents(item.amount), 0);
  }
  // Legacy requests without commissionItems reserve the whole referenced item.
  return !items.length && Array.isArray(data.commissionIds) && data.commissionIds.includes(requestId) && kind === 'referral'
    ? outstanding
    : 0;
}

function reservedFor(row, withdrawals) {
  const detail = object(row.data);
  const paidKey = row.kind === 'developer' ? 'developerCommissionPaidAmount' : 'commissionPaidAmount';
  const outstanding = Math.max(0, moneyCents(row.amount) - moneyCents(detail[paidKey]));
  const reserved = withdrawals.reduce((sum, withdrawal) => sum + allocatedFor(withdrawal, row.requestId, row.kind, outstanding), 0);
  return Math.min(outstanding, reserved);
}

export async function createPostgresWithdrawalRequest({ sessionHash, body = {}, now = new Date() }) {
  return withPostgresScopedTransaction(async client => {
    // Legacy whole-store writers use SHARE ROW EXCLUSIVE on this same set before
    // loading their snapshot. Scoped requests use compatible locks and row locks,
    // so independent employees no longer wait for the global queue while old
    // writers cannot overwrite a withdrawal committed here.
    await client.query(`LOCK TABLE app_settings, user_accounts, project_requests, commissions,
      withdrawal_requests, finance_ledger_entries, system_notifications, audit_entries, outbox_messages
      IN ROW EXCLUSIVE MODE`);

    const sessionResult = await client.query(`
      SELECT s.id AS session_id, s."expiresAt", u.id, u.email, u.username, u.role, u.active,
        u."fullName", u.data
      FROM auth_sessions s JOIN user_accounts u ON u.id = s."userId"
      WHERE s.id = $1 AND s."expiresAt" > NOW() AND u.active = TRUE
      FOR UPDATE OF u
    `, [sessionHash]);
    const userRow = sessionResult.rows[0];
    if (!userRow) return { status: 401, error: 'سجّل الدخول للمتابعة / Please sign in to continue' };
    if (!['marketer', 'developer'].includes(userRow.role)) return { status: 403, error: 'ليس لديك صلاحية لهذه العملية / Not permitted' };
    const userData = object(userRow.data);
    if (userData.mustChangePassword) return { status: 428, error: 'غيّر كلمة المرور المؤقتة أولاً / Change the temporary password first', mustChangePassword: true };

    const username = userRow.username || '';
    const email = userRow.email || '';
    const destination = clean(userData.payoutHandle, 120);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return { status: 400, error: 'أضف بريداً صالحاً من إعدادات حسابك أولاً / Add a valid email in your account settings first' };
    if (destination.length < 3) return { status: 400, error: 'أضف معرّف Binance Pay أو UID في إعدادات حسابك / Add your Binance Pay ID or UID in account settings' };

    const settingsResult = await client.query('SELECT value FROM app_settings WHERE key = $1 FOR SHARE', ['zezo-runtime']);
    const settings = object(settingsResult.rows[0]?.value);
    const minimumCents = moneyCents(settings.withdrawalMinimum || 100);
    const amountValue = Number(body.amount);
    const requestedCents = moneyCents(amountValue);
    if (!Number.isFinite(amountValue) || !Number.isSafeInteger(requestedCents) || requestedCents < minimumCents) {
      const minimum = ils(minimumCents);
      return { status: 400, error: `الحد الأدنى لطلب السحب ${minimum} شيكل / Minimum withdrawal is ${minimum} ILS` };
    }

    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const day = now.getUTCDate();
    const windowStart = Math.max(1, Math.min(31, Number(settings.withdrawalWindowStart) || 1));
    const windowEnd = Math.max(1, Math.min(31, Number(settings.withdrawalWindowEnd) || 31));
    if (day < windowStart || day > windowEnd) return { status: 409, error: `طلبات السحب متاحة من يوم ${windowStart} إلى ${windowEnd} من الشهر / Withdrawal requests are open from day ${windowStart} to ${windowEnd}` };

    // The account-row lock serializes the monthly cap and balance reservation
    // for this employee. Other employees use different locks and can proceed.
    const existingWithdrawalsResult = await client.query(`
      SELECT id, status, data FROM withdrawal_requests WHERE "userId" = $1 FOR UPDATE
    `, [userRow.id]);
    const withdrawals = existingWithdrawalsResult.rows.map(row => ({ ...row, data: object(row.data) }));
    if (withdrawals.some(row => row.data.month === month)) return { status: 409, error: 'تم استخدام طلب السحب الشهري لهذا الشهر / Your monthly withdrawal request has already been used' };

    const commissionResult = await client.query(`
      SELECT id, "requestId", kind, amount, status, data, "createdAt"
      FROM commissions WHERE "userId" = $1 ORDER BY "createdAt", "requestId", kind FOR UPDATE
    `, [userRow.id]);
    const commissions = commissionResult.rows.map(row => ({ ...row, data: object(row.data), amount: Number(row.amount) }));
    let totalDebtCents = 0;
    const eligible = [];
    for (const commission of commissions) {
      const debtKey = commission.kind === 'developer' ? 'developerCommissionDebtRemaining' : 'commissionDebtRemaining';
      totalDebtCents += Math.max(0, moneyCents(commission.data[debtKey]));
      if (!['referral', 'developer'].includes(commission.kind) || commission.status !== 'confirmed') continue;
      const paidKey = commission.kind === 'developer' ? 'developerCommissionPaidAmount' : 'commissionPaidAmount';
      const outstandingCents = Math.max(0, moneyCents(commission.amount) - moneyCents(commission.data[paidKey]));
      const reservedCents = reservedFor(commission, withdrawals.filter(row => activeStatuses.includes(row.status)));
      const availableCents = Math.max(0, outstandingCents - reservedCents);
      if (availableCents > 0) eligible.push({ ...commission, outstandingCents, availableCents });
    }

    const grossEligibleCents = eligible.reduce((sum, row) => sum + row.availableCents, 0);
    const offsetCents = Math.min(totalDebtCents, requestedCents);
    const netAvailableCents = Math.max(0, grossEligibleCents - totalDebtCents);
    if (requestedCents > netAvailableCents) return { status: 409, error: 'المبلغ المطلوب أكبر من رصيدك المتاح / Requested amount exceeds your available balance' };

    let remainingCents = requestedCents + offsetCents;
    const items = [];
    let referralCents = 0;
    let developerCents = 0;
    for (const kind of ['referral', 'developer']) {
      for (const commission of eligible.filter(row => row.kind === kind)) {
        if (remainingCents <= 0) break;
        const selectedCents = Math.min(commission.availableCents, remainingCents);
        if (selectedCents <= 0) continue;
        items.push({ leadId: commission.requestId, kind, amount: ils(selectedCents) });
        if (kind === 'developer') developerCents += selectedCents;
        else referralCents += selectedCents;
        remainingCents -= selectedCents;
      }
    }
    if (remainingCents > 1) return { status: 409, error: 'تغير الرصيد أثناء إعداد الطلب؛ حدّث الصفحة وأعد المحاولة / Balance changed; refresh and retry' };

    const withdrawalId = rowId('wd');
    const createdAt = now.toISOString();
    const amount = ils(requestedCents);
    const referralAmount = ils(referralCents);
    const developerAmount = ils(developerCents);
    const offsetAmount = ils(offsetCents);
    const method = clean(body.method, 20) || 'binance';
    const withdrawal = {
      id: withdrawalId, userId: userRow.id, name: userRow.fullName || userData.name || '', email,
      role: userRow.role, month, createdAt, updatedAt: createdAt, amount,
      grossAmount: ils(requestedCents + offsetCents), offsetAmount,
      balanceAtRequest: ils(netAvailableCents), referralAmount, developerAmount,
      method, destination, status: 'pending', commissionItems: items,
      commissionIds: [...new Set(items.map(item => item.leadId))], transferReference: '',
      transferDetails: null, note: '', statusHistory: [{ status: 'pending', at: createdAt, by: username }]
    };
    await client.query(`
      INSERT INTO withdrawal_requests (id, "userId", amount, status, "reviewedBy", data, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'pending', NULL, $4::jsonb, $5, $5)
    `, [withdrawalId, userRow.id, amount, JSON.stringify(withdrawal), now]);

    for (const item of items) {
      const commission = eligible.find(row => row.requestId === item.leadId && row.kind === item.kind);
      const key = item.kind === 'developer' ? 'developerWithdrawalId' : 'withdrawalId';
      await client.query('UPDATE commissions SET data = jsonb_set(COALESCE(data, \'{}\'::jsonb), $2::text[], to_jsonb($3::text), true) WHERE id = $1', [commission.id, [key], withdrawalId]);
    }

    const appendLedger = async (key, type, cents, note = '') => {
      const entryId = rowId('fin');
      const data = { id: entryId, idempotencyKey: key, type, employeeId: userRow.id, withdrawalId, amountCents: cents, statusSnapshot: 'pending', actor: username, note, postedAt: createdAt };
      await client.query(`
        INSERT INTO finance_ledger_entries (id, type, status, "requestId", "employeeId", amount, currency, "idempotencyKey", data, "createdAt")
        VALUES ($1, $2, 'pending', NULL, $3, $4, 'ILS', $5, $6::jsonb, $7)
        ON CONFLICT ("idempotencyKey") DO NOTHING
      `, [entryId, type, userRow.id, ils(cents), key, JSON.stringify(data), now]);
    };
    await appendLedger(`withdrawal:${withdrawalId}:requested`, 'withdrawal_reserved', requestedCents, `Requested payout via ${method}`);
    if (offsetCents > 0) await appendLedger(`withdrawal:${withdrawalId}:offset`, 'commission_offset_reserved', offsetCents, 'Reserved for outstanding commission reversal debt');

    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, 'withdrawal_requested', $3, $4::jsonb, $5)
    `, [rowId('evt'), userRow.id, withdrawalId, JSON.stringify({ actor: username, role: userRow.role, detail: `${amount} ILS; ${method}` }), now]);

    const managers = await client.query(`
      SELECT id, role FROM user_accounts WHERE active = TRUE AND role = ANY($1::text[])
        AND COALESCE(data->>'accountDisabledAt', '') = ''
    `, [['admin', 'hr_manager']]);
    for (const manager of managers.rows) {
      const isOwner = manager.role === 'admin';
      const notification = {
        id: rowId('ntf'), userId: manager.id, eventKey: `withdrawal_requested:${withdrawalId}`,
        type: 'withdrawal', importance: isOwner ? 'high' : 'normal',
        titleAr: 'طلب سحب موظف جديد', titleEn: 'New employee withdrawal request',
        descriptionAr: `${withdrawal.name} أرسل طلب سحب بقيمة ${amount} شيكل يحتاج إلى المراجعة.`,
        descriptionEn: `${withdrawal.name} submitted a ${amount} ILS withdrawal request for review.`,
        createdAt, readAt: '', target: { tab: isOwner ? 'withdrawals' : 'people', id: withdrawalId, kind: 'withdrawal' }
      };
      await client.query(`
        INSERT INTO system_notifications (id, "userId", type, "readAt", data, "createdAt")
        VALUES ($1, $2, 'withdrawal', NULL, $3::jsonb, $4)
      `, [notification.id, manager.id, JSON.stringify(notification), now]);
    }

    const mailRows = [
      { id: rowId('mail'), kind: 'withdrawal_requested', to: '', recipientType: 'admin', subject: `طلب سحب عمولة — ${withdrawal.name}`, text: `طلب سحب شهري جديد\nالموظف: ${withdrawal.name}\nالدور: ${withdrawal.role}\nالبريد: ${email}\nعمولات التسويق المحجوزة: ${referralAmount} ₪\nمستحقات التنفيذ المحجوزة: ${developerAmount} ₪\nمبلغ التحويل المطلوب: ${amount} ₪\nتسوية استردادات: ${offsetAmount} ₪\nوسيلة التحويل: ${method}\nBinance Pay ID / UID: ${destination}\nالشهر: ${month}\nيحتاج مراجعة ثم اعتماد المالك قبل التحويل اليدوي.` },
      { id: rowId('mail'), kind: 'withdrawal_received', to: email, recipientType: 'direct', subject: 'تم استلام طلب السحب لدى ZEZO', text: `مرحباً ${withdrawal.name}، وصل طلب السحب الشهري بقيمة ${amount} ₪. سيتم مراجعته وتحويله يدوياً بعد الموافقة.` }
    ];
    for (const mail of mailRows) {
      const row = { ...mail, createdAt, state: 'pending', attempts: 0, lastError: '' };
      await client.query(`
        INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
        VALUES ($1, NULLIF($2, ''), 'pending', 0, $3::jsonb, $4, $4)
      `, [mail.id, mail.to, JSON.stringify(row), now]);
    }

    return {
      status: 201,
      withdrawal: {
        id: withdrawal.id, createdAt: withdrawal.createdAt, amount: withdrawal.amount,
        referralAmount: withdrawal.referralAmount, developerAmount: withdrawal.developerAmount,
        method: withdrawal.method, status: withdrawal.status, updatedAt: withdrawal.updatedAt
      }
    };
  });
}
