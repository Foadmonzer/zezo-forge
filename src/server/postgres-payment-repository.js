import { createHash, randomUUID } from 'node:crypto';
import { withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const cents = value => Math.round((Number(value) || 0) * 100);
const money = value => Number((Math.round((Number(value) || 0) * 100) / 100).toFixed(2));
const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const rowId = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const stableId = (prefix, value) => `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 40)}`;
const marketerRankRates = { rookie: 15, pro: 20, elite: 35 };
const rankOrder = ['rookie', 'pro', 'elite', 'team_leader'];
const rankThresholds = { rookie: 0, pro: 10, elite: 20, team_leader: 80 };
const activeWithdrawalStatuses = ['pending', 'under_review', 'approved', 'awaiting_transfer', 'requested'];

function rankRate(user) {
  const data = object(user?.data);
  return data.rank === 'team_leader' ? Number(data.activeCommissionRate ?? 35) : marketerRankRates[data.rank] ?? 15;
}

function updateReferralCommission(lead, referralUser, settings, at) {
  if (!lead.contractAmount || !lead.referralUserId || ['proposal', 'review', 'new'].includes(lead.status)) {
    lead.commissionAmount = null;
    lead.commissionDebtRemaining = 0;
    lead.commissionStatus = lead.referralUserId ? 'pending_setup' : 'none';
    return;
  }
  if (lead.commissionRate == null) {
    lead.commissionRate = rankRate(referralUser);
    lead.commissionRank = object(referralUser?.data).rank || 'rookie';
    lead.commissionRateSetAt = at;
  }
  const everPaidInFull = Boolean(lead.everFullyPaid || lead.fullyPaidAt);
  const cancelled = lead.status === 'cancelled';
  const hadCommission = Number(lead.commissionAmount || 0) > 0;
  const netPaid = Math.max(0, Math.min(Number(lead.paidTotal || 0), Number(lead.contractAmount)));
  const eligibleAmount = !cancelled && !lead.isDuplicate && everPaidInFull ? money(netPaid * Number(lead.commissionRate) / 100) : 0;
  lead.commissionAmount = money(eligibleAmount);
  lead.commissionDebtRemaining = money(Math.max(0, Number(lead.commissionPaidAmount || 0) - Number(lead.commissionOffsetAmount || 0) - eligibleAmount));
  if (cancelled || lead.isDuplicate || eligibleAmount <= 0) {
    lead.commissionStatus = lead.commissionDebtRemaining > 0 || ((cancelled || lead.isDuplicate || lead.refunded) && (hadCommission || everPaidInFull))
      ? 'reversed' : (Number(lead.commissionPaidAmount || 0) > 0 ? 'paid' : 'none');
    return;
  }
  const unpaid = money(Math.max(0, eligibleAmount - Number(lead.commissionPaidAmount || 0)));
  if (unpaid <= 0) { lead.commissionStatus = lead.commissionDebtRemaining > 0 ? 'reversed' : 'paid'; return; }
  if (!everPaidInFull || lead.paidTotal < lead.contractAmount || !lead.fullyPaidAt || lead.status !== 'completed') {
    lead.commissionStatus = 'pending';
    return;
  }
  const holdDays = Math.max(0, Math.min(90, Number(settings.commissionHoldDays ?? 14)));
  const holdStart = new Date(lead.commissionHoldUntil || lead.fullyPaidAt).getTime();
  lead.commissionStatus = Date.now() >= holdStart + holdDays * 86400000 ? 'confirmed' : 'pending';
}

function updateDeveloperCommission(lead, settings) {
  const rate = 25;
  lead.developerCommissionRate = rate;
  const wasEarned = Number(lead.developerCommissionAmount || 0) > 0;
  const eligible = Boolean(lead.developerUserId && lead.developerReviewStatus === 'approved' &&
    lead.projectStage === 'completed' && lead.status === 'completed' && !lead.isDuplicate && Number(lead.paidTotal || 0) > 0);
  const collected = Math.min(Number(lead.paidTotal || 0), Number(lead.contractAmount || 0));
  const amount = eligible ? money(collected * rate / 100) : 0;
  lead.developerCommissionAmount = amount;
  lead.developerCommissionDebtRemaining = money(Math.max(0, Number(lead.developerCommissionPaidAmount || 0) - Number(lead.developerCommissionOffsetAmount || 0) - amount));
  if (lead.developerTaskStatus === 'declined' && !lead.developerCommissionPaidAmount) { lead.developerCommissionStatus = 'none'; return; }
  if (!lead.developerUserId) { lead.developerCommissionStatus = 'none'; return; }
  if (!eligible) {
    const reversal = Boolean(lead.refunded || lead.status === 'cancelled' || lead.isDuplicate) &&
      (wasEarned || Number(lead.developerCommissionPaidAmount || 0) > 0 || Boolean(lead.everFullyPaid || lead.fullyPaidAt));
    lead.developerCommissionStatus = lead.developerCommissionDebtRemaining > 0 || reversal ||
      (wasEarned && Number(lead.developerCommissionPaidAmount || 0) > 0) ? 'reversed' : 'pending';
    return;
  }
  const unpaid = money(Math.max(0, amount - Number(lead.developerCommissionPaidAmount || 0)));
  if (unpaid <= 0) { lead.developerCommissionStatus = lead.developerCommissionDebtRemaining > 0 ? 'reversed' : 'paid'; return; }
  const holdDays = Math.max(0, Math.min(90, Number(settings.commissionHoldDays ?? 14)));
  const holdStart = new Date(lead.developerCommissionHoldUntil || lead.developerReviewApprovedAt || lead.createdAt).getTime();
  lead.developerCommissionStatus = Date.now() >= holdStart + holdDays * 86400000 ? 'confirmed' : 'pending';
}

async function insertAudit(client, { id, actorId, actor, targetId, action, detail, at }) {
  await client.query(`
    INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (id) DO NOTHING
  `, [id, actorId, action, targetId, JSON.stringify({ actor, role: 'admin', detail: String(detail || '').slice(0, 180) }), at]);
}

async function insertNotification(client, { userId, eventKey, type, importance = 'normal', titleAr, titleEn, descriptionAr = '', descriptionEn = '', tab, targetId, targetKind, at }) {
  if (!userId) return;
  const id = stableId('ntf', `${userId}:${eventKey}`);
  const data = { eventKey, type, importance, titleAr, titleEn, descriptionAr, descriptionEn, target: { tab, id: targetId, kind: targetKind } };
  await client.query(`
    INSERT INTO system_notifications (id, "userId", type, data, "createdAt")
    SELECT $1, u.id, $3, $4::jsonb, $5 FROM user_accounts u
    WHERE u.id = $2 AND u.active = TRUE
      AND COALESCE(u.data ->> 'accountDisabledAt', '') IN ('', 'false', '0')
      AND NOT EXISTS (SELECT 1 FROM system_notifications n WHERE n."userId" = u.id AND n.data ->> 'eventKey' = $6)
    ON CONFLICT (id) DO NOTHING
  `, [id, userId, type, JSON.stringify(data), at, eventKey]);
}

async function insertOutbox(client, { recipient = '', recipientType = 'direct', kind, subject, text, at }) {
  const id = stableId('mail', `${kind}:${recipient}:${subject}:${at}`);
  const data = { id, to: recipient, recipientType, kind, subject, text: String(text || '').slice(0, 6000), state: 'pending', attempts: 0, lastError: '', createdAt: at, updatedAt: at };
  await client.query(`
    INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
    VALUES ($1, NULLIF($2, ''), 'pending', 0, $3::jsonb, $4, $4)
    ON CONFLICT (id) DO NOTHING
  `, [id, recipient, JSON.stringify(data), at]);
}

async function appendLedger(client, entry, at) {
  const id = entry.id || rowId('fin');
  await client.query(`
    INSERT INTO finance_ledger_entries
      (id, type, status, "requestId", "employeeId", amount, currency, "idempotencyKey", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'ILS', $7, $8::jsonb, $9)
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `, [id, entry.type, entry.statusSnapshot || 'posted', entry.leadId || null, entry.employeeId || null,
    Number(entry.amountCents || 0) / 100, entry.idempotencyKey || null, JSON.stringify({ ...entry, id, currency: 'ILS' }), entry.postedAt || at]);
}

async function syncCommissionLedger(client, lead, kind, userId, amount, status, rate, rank, actor, at) {
  if (!userId) return;
  const sourceKey = `commission:${lead.id}:${kind}`;
  const prior = await client.query(`
    SELECT COALESCE(SUM(round(amount * 100)), 0)::bigint AS cents
    FROM finance_ledger_entries
    WHERE "requestId" = $1 AND type = 'commission_balance' AND data ->> 'sourceKey' = $2
  `, [lead.id, sourceKey]);
  const delta = cents(amount) - Number(prior.rows[0]?.cents || 0);
  if (delta) await appendLedger(client, { type: 'commission_balance', leadId: lead.id, employeeId: userId,
    commissionKind: kind, sourceKey, amountCents: delta, rateSnapshot: Number(rate || 0), rankSnapshot: rank || '',
    statusSnapshot: status || 'none', actor, note: 'Append-only commission balance adjustment' }, at);
  const last = await client.query(`
    SELECT data ->> 'statusSnapshot' AS status FROM finance_ledger_entries
    WHERE "requestId" = $1 AND type = 'commission_status' AND data ->> 'sourceKey' = $2
    ORDER BY "createdAt" DESC, id DESC LIMIT 1
  `, [lead.id, sourceKey]);
  if (last.rows[0]?.status !== (status || 'none')) await appendLedger(client, {
    type: 'commission_status', leadId: lead.id, employeeId: userId, commissionKind: kind, sourceKey,
    amountCents: 0, rateSnapshot: Number(rate || 0), rankSnapshot: rank || '', statusSnapshot: status || 'none', actor
  }, at);
}

async function writeCommission(client, lead, kind, userId, rate, amount, status, details, at) {
  if (!userId) return;
  const id = `commission_${kind}_${lead.id}`;
  await client.query(`
    INSERT INTO commissions (id, "userId", "requestId", kind, "ratePercent", amount, currency, status, data, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'ILS', $7, $8::jsonb, $9)
    ON CONFLICT ("userId", "requestId", kind) DO UPDATE
    SET "ratePercent" = EXCLUDED."ratePercent", amount = EXCLUDED.amount, status = EXCLUDED.status, data = EXCLUDED.data
  `, [id, userId, lead.id, kind, Number(rate || 0), money(amount || 0), status || 'none', JSON.stringify(details), at]);
}

async function insertReferralEvent(client, lead, { type, idempotencyKey, at, reversedAt = '' }) {
  if (!lead.referralUserId || !lead.referralCode) return false;
  const id = stableId('rfe', idempotencyKey);
  const data = { leadId: lead.id, linkId: lead.referralLinkId || null, reversedAt };
  const result = await client.query(`
    INSERT INTO referral_events (id, "userId", code, "eventType", "resourceId", "requestId", "idempotencyKey", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $5, $6, $7::jsonb, $8)
    ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id
  `, [id, lead.referralUserId, lead.referralCode, type, lead.id, idempotencyKey, JSON.stringify(data), at]);
  return result.rowCount > 0;
}

async function syncReferralMilestones(client, lead, at) {
  if (!lead.referralUserId || !lead.referralCode) return;
  const completed = lead.status === 'completed' && !lead.isDuplicate;
  const sale = completed && Number(lead.contractAmount) > 0 && Number(lead.paidTotal) >= Number(lead.contractAmount) &&
    Boolean(lead.everFullyPaid || lead.fullyPaidAt) && !lead.refunded;
  const completionCreated = completed && await insertReferralEvent(client, lead, { type: 'project_completed', idempotencyKey: `project_completed:${lead.id}`, at });
  await client.query(`
    UPDATE referral_events SET data = data || jsonb_build_object('reversedAt', $2::text)
    WHERE "idempotencyKey" = $1
  `, [`project_completed:${lead.id}`, completed ? '' : at]);
  const saleCreated = sale && await insertReferralEvent(client, lead, { type: 'qualified_sale', idempotencyKey: `qualified_sale:${lead.id}`, at });
  await client.query(`
    UPDATE referral_events SET data = data || jsonb_build_object('reversedAt', $2::text)
    WHERE "idempotencyKey" = $1
  `, [`qualified_sale:${lead.id}`, sale ? '' : at]);
  if (saleCreated) await insertNotification(client, {
    userId: lead.referralUserId, eventKey: `milestone:qualified_sale:${lead.id}`, type: 'sale', importance: 'high',
    titleAr: 'اكتملت مبيعة مؤهلة من إحالتك', titleEn: 'A qualified referral sale completed',
    descriptionAr: 'سُجل الطلب كمكتمل ومدفوع بالكامل وفق شروط التأهل.',
    descriptionEn: 'The request was recorded as complete and fully paid under the qualification rules.',
    tab: 'referral', targetId: lead.id, targetKind: 'lead', at
  });
  return { completionCreated, saleCreated };
}

async function syncRankRequest(client, user, at, emailEnabled) {
  if (!user || !['marketer', 'developer'].includes(user.role)) return;
  const data = object(user.data);
  const currentRank = rankOrder.includes(data.rank) ? data.rank : 'rookie';
  const targetRank = rankOrder[rankOrder.indexOf(currentRank) + 1];
  if (!targetRank) return;
  const salesResult = await client.query(`
    SELECT count(*)::int AS count FROM project_requests
    WHERE "referrerId" = $1 AND status = 'completed'
      AND COALESCE(data ->> 'isDuplicate', 'false') <> 'true'
      AND COALESCE(data ->> 'duplicateOfLeadId', '') = ''
      AND COALESCE(data ->> 'refunded', 'false') <> 'true'
      AND COALESCE(data ->> 'everFullyPaid', 'false') = 'true'
      AND COALESCE(data ->> 'paidTotal', '0')::numeric >= COALESCE("agreedAmount", 0)
      AND COALESCE("agreedAmount", 0) > 0
  `, [user.id]);
  const sales = Number(salesResult.rows[0]?.count || 0), threshold = rankThresholds[targetRank];
  const rows = await client.query(`SELECT id, state, "salesCount", data FROM rank_requests WHERE "userId" = $1 AND "requestedRank" = $2 ORDER BY "createdAt" DESC FOR UPDATE`, [user.id, targetRank]);
  const pending = rows.rows.find(row => row.state === 'pending');
  const priorApproved = rows.rows.some(row => row.state === 'approved');
  const priorRejected = rows.rows.find(row => row.state === 'rejected');
  if (pending && sales < threshold) {
    const updatedData = { ...object(pending.data), status: 'invalidated', note: 'Qualified sales fell below the threshold after a cancellation, refund, or duplicate review.', updatedAt: at };
    await client.query('UPDATE rank_requests SET state = $2, salesCount = $3, data = $4::jsonb WHERE id = $1', [pending.id, 'invalidated', sales, JSON.stringify(updatedData)]);
    await insertAudit(client, { id: rowId('evt'), actorId: null, actor: 'system', targetId: pending.id, action: 'rank_request_invalidated', detail: `${sales}/${threshold} qualified sales`, at });
  }
  if (sales < threshold || priorApproved || (priorRejected && sales <= Number(priorRejected.salesCount || object(priorRejected.data).salesAtRequest || 0))) return;
  const requestId = rowId('rank');
  const name = user.fullName || data.name || '';
  const request = { id: requestId, userId: user.id, username: user.username, name, fromRank: currentRank, targetRank,
    threshold, salesAtRequest: sales, salesCount: sales, status: 'pending', createdAt: at, updatedAt: at, decidedBy: '', decidedAt: null, note: '' };
  await client.query(`
    INSERT INTO rank_requests (id, "userId", "fromRank", "requestedRank", "salesCount", "commissionPercent", state, data, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, $8)
  `, [requestId, user.id, currentRank, targetRank, sales, rankRate(user), JSON.stringify(request), at]);
  await insertAudit(client, { id: rowId('evt'), actorId: null, actor: 'system', targetId: requestId, action: 'rank_promotion_requested', detail: `${user.username}: ${currentRank} -> ${targetRank}; ${sales} qualified sales`, at });
  if (emailEnabled) await insertOutbox(client, { recipientType: 'admin', kind: 'rank_promotion_requested', subject: `طلب ترقية مسوّق — ${name}`,
    text: `بلغ المسوّق ${name} مستوى ${targetRank}\nالرتبة الحالية: ${currentRank}\nالمبيعات المؤهلة مدى الحياة: ${sales}\nالحد المطلوب: ${threshold}\nراجع الطلب من لوحة ZEZO.`, at });
}

async function cancelRelatedWithdrawals(client, lead, actor, at, emailEnabled) {
  const userIds = [...new Set([lead.referralUserId, lead.developerUserId].filter(Boolean))];
  if (!userIds.length) return;
  const result = await client.query(`
    SELECT id, "userId", amount, status, data FROM withdrawal_requests
    WHERE "userId" = ANY($1::text[]) AND status = ANY($2::text[])
    ORDER BY "createdAt", id FOR UPDATE
  `, [userIds, activeWithdrawalStatuses]);
  for (const row of result.rows) {
    const data = object(row.data), items = Array.isArray(data.commissionItems) ? data.commissionItems : [];
    const matches = items.filter(item => item.leadId === lead.id &&
      ((item.kind === 'developer' && lead.developerUserId === row.userId) || (item.kind !== 'developer' && lead.referralUserId === row.userId)));
    const legacyMatch = !items.length && Array.isArray(data.commissionIds) && data.commissionIds.includes(lead.id) && row.userId === lead.referralUserId;
    if (!matches.length && !legacyMatch) continue;
    const updatedAt = at;
    const history = Array.isArray(data.statusHistory) ? data.statusHistory : [];
    const next = { ...data, status: 'rejected', updatedAt, note: 'Released because a related project was refunded or cancelled.',
      statusHistory: [...history, { status: 'rejected', from: row.status, at: updatedAt, by: actor.username, reason: 'related_refund_or_cancellation' }] };
    await client.query('UPDATE withdrawal_requests SET status = $2, data = $3::jsonb, "updatedAt" = $4 WHERE id = $1', [row.id, 'rejected', JSON.stringify(next), at]);
    if (lead.referralUserId === row.userId && lead.withdrawalId === row.id) delete lead.withdrawalId;
    if (lead.developerUserId === row.userId && lead.developerWithdrawalId === row.id) delete lead.developerWithdrawalId;
    for (const item of matches) {
      const key = item.kind === 'developer' ? 'developerWithdrawalId' : 'withdrawalId';
      await client.query(`UPDATE commissions SET data = data - $2 WHERE "requestId" = $1 AND kind = $3 AND "userId" = $4 AND data ->> $2 = $5`, [lead.id, key, item.kind || 'referral', row.userId, row.id]);
    }
    await appendLedger(client, { idempotencyKey: `withdrawal:${row.id}:released`, type: 'withdrawal_released', employeeId: row.userId,
      withdrawalId: row.id, amountCents: cents(row.amount), statusSnapshot: 'rejected', actor: actor.username,
      note: 'Related project refunded or cancelled' }, at);
    await insertAudit(client, { id: rowId('evt'), actorId: actor.id, actor: actor.username, targetId: row.id, action: 'withdrawal_cancelled', detail: 'Related project refunded or cancelled', at });
    await insertNotification(client, { userId: row.userId, eventKey: `withdrawal:${row.id}:refunded:${lead.id}`, type: 'withdrawal', importance: 'high',
      titleAr: 'تغيّرت حالة طلب السحب', titleEn: 'Withdrawal request status changed',
      descriptionAr: 'أُلغي طلب السحب بسبب استرداد مرتبط. راجع محفظتك وسجل السحب.',
      descriptionEn: 'A withdrawal request was cancelled after a related refund. Review your wallet and withdrawal history.',
      tab: 'referral', targetId: row.id, targetKind: 'withdrawal', at });
    if (emailEnabled && data.email) await insertOutbox(client, { recipient: data.email, kind: 'withdrawal_cancelled',
      subject: 'تحديث طلب السحب لدى ZEZO', text: `مرحباً ${data.name || ''}، أُلغي طلب السحب رقم ${row.id} بعد تعديل مالي على مشروع مرتبط. راجع رصيدك في ZEZO.`, at });
  }
}

async function updateCrm(client, lead, actor, at) {
  const crmResult = await client.query(`
    SELECT id, status, data FROM crm_records
    WHERE id = $1 OR data -> 'orderIds' ? $2
    ORDER BY (id = $1) DESC LIMIT 1 FOR UPDATE
  `, [lead.crmLeadId || '', lead.id]);
  const row = crmResult.rows[0];
  if (!row) return;
  const nextStatus = lead.isDuplicate ? 'duplicate' : lead.status === 'cancelled' || lead.refunded ? 'cancelled' :
    lead.status === 'completed' && Number(lead.contractAmount) > 0 && Number(lead.paidTotal) >= Number(lead.contractAmount) ? 'completed_sale' :
      lead.quoteAcceptedAt ? 'quote_accepted' : 'official_order';
  if (row.status === nextStatus) return;
  const data = object(row.data), history = Array.isArray(data.history) ? data.history : [];
  history.unshift({ kind: 'order_status', status: nextStatus, by: actor.username, at, note: `Existing project request ${lead.id} changed after a ${lead.refunded ? 'refund' : 'payment'} update.` });
  const updated = { ...data, status: nextStatus, updatedAt: at, history: history.slice(0, 100) };
  await client.query('UPDATE crm_records SET status = $2, data = $3::jsonb, "updatedAt" = $4 WHERE id = $1', [row.id, nextStatus, JSON.stringify(updated), at]);
  const notice = nextStatus === 'completed_sale'
    ? { importance: 'high', titleAr: 'اكتملت مبيعة مرتبطة بـ CRM', titleEn: 'CRM linked sale completed', descriptionAr: 'اكتمل المشروع المرتبط وتم التحقق من الدفع المؤهل.', descriptionEn: 'The linked project is complete and eligible payment was verified.' }
    : { importance: 'high', titleAr: 'تم تحديث حالة عميل CRM', titleEn: 'CRM customer status updated', descriptionAr: 'تغيرت حالة طلب مرتبط؛ راجع سجل العميل.', descriptionEn: 'A linked request changed status; review the customer record.' };
  const managers = await client.query('SELECT id, role FROM user_accounts WHERE active = TRUE AND role = ANY($1::text[]) AND id <> $2', [['admin', 'marketing_manager'], actor.id]);
  for (const manager of managers.rows) await insertNotification(client, { userId: manager.id, eventKey: `crm:payment:${row.id}:${nextStatus}:${at}`, type: 'inquiry', ...notice,
    tab: manager.role === 'admin' ? 'crm' : 'crm', targetId: row.id, targetKind: 'crm', at });
}

async function notifyPayment(client, lead, actor, payment, at) {
  const refund = payment.kind === 'refund';
  const eventKey = `${refund ? 'refund_recorded' : 'manual_payment_verified'}:${payment.id}`;
  const copy = refund
    ? { type: 'payment', importance: 'high', titleAr: 'تم تسجيل استرداد على طلبك', titleEn: 'A refund was recorded for your request', descriptionAr: 'تم تحديث سجل الدفعات في حسابك.', descriptionEn: 'Your payment history was updated.' }
    : { type: 'payment', importance: 'normal', titleAr: 'تم تأكيد دفعة لطلبك', titleEn: 'A payment was confirmed for your request', descriptionAr: 'تم تحديث سجل الدفعات في حسابك.', descriptionEn: 'Your payment history was updated.' };
  await insertNotification(client, { userId: lead.clientId, eventKey: `${eventKey}:client`, ...copy, tab: 'orders', targetId: lead.id, targetKind: 'lead', at });
  const commissionCopy = refund
    ? { type: 'commission', importance: 'normal', titleAr: 'تغيّر استحقاق العمولة بعد استرداد', titleEn: 'Commission eligibility changed after a refund', descriptionAr: 'راجع محفظتك؛ بيانات العميل غير معروضة.', descriptionEn: 'Review your wallet; customer details are not shown.' }
    : { type: 'commission', importance: 'normal', titleAr: 'تحدّثت بيانات دفعة مرتبطة بمشروع', titleEn: 'Payment information for a project was updated', descriptionAr: 'راجع محفظتك للاطلاع على حالة العمولة.', descriptionEn: 'Review your wallet for the commission status.' };
  for (const userId of new Set([lead.referralUserId, lead.developerUserId].filter(Boolean))) {
    await insertNotification(client, { userId, eventKey: `${eventKey}:commission:${userId}`, ...commissionCopy, tab: 'referral', targetId: lead.id, targetKind: 'lead', at });
  }
  const admins = await client.query('SELECT id FROM user_accounts WHERE active = TRUE AND role = $1 AND id <> $2', ['admin', actor.id]);
  for (const admin of admins.rows) await insertNotification(client, { userId: admin.id, eventKey: `${eventKey}:admin`, type: refund ? 'finance' : 'payment', importance: refund ? 'high' : 'normal',
    titleAr: refund ? 'تم تسجيل استرداد يحتاج مراجعة' : 'تم تأكيد دفعة جديدة', titleEn: refund ? 'A refund was recorded for review' : 'A new payment was verified',
    descriptionAr: refund ? 'تغيّر المبلغ المحصّل؛ راجع أثر الاسترداد على العمولة والتسوية.' : 'تم تأكيد دفعة مرتبطة بمشروع.',
    descriptionEn: refund ? 'The collected amount changed; review its effect on commissions and settlements.' : 'A payment for a project was verified.',
    tab: 'finance', targetId: lead.id, targetKind: 'lead', at });
}

async function persistCommissionRows(client, lead, actor, at) {
  const referralDetails = Object.fromEntries(['commissionPaidAmount', 'commissionOffsetAmount', 'commissionDebtRemaining', 'withdrawalId', 'commissionRank', 'commissionRateSetAt', 'commissionHoldUntil'].filter(key => lead[key] !== undefined).map(key => [key, lead[key]]));
  const developerDetails = Object.fromEntries(Object.keys(lead).filter(key => key.startsWith('developerCommission') || ['developerWithdrawalId', 'developerReviewStatus', 'developerReviewApprovedAt'].includes(key)).map(key => [key, lead[key]]));
  if (lead.referralUserId) {
    await writeCommission(client, lead, 'referral', lead.referralUserId, lead.commissionRate || 0, lead.commissionAmount || 0, lead.commissionStatus, referralDetails, at);
    await syncCommissionLedger(client, lead, 'referral', lead.referralUserId, lead.commissionAmount || 0, lead.commissionStatus, lead.commissionRate, lead.commissionRank, actor.username, at);
  }
  if (lead.developerUserId) {
    await writeCommission(client, lead, 'developer', lead.developerUserId, 25, lead.developerCommissionAmount || 0, lead.developerCommissionStatus, developerDetails, at);
    await syncCommissionLedger(client, lead, 'developer', lead.developerUserId, lead.developerCommissionAmount || 0, lead.developerCommissionStatus, 25, '', actor.username, at);
  }
}

/** A short per-project payment transaction; unrelated orders never share a global advisory lock. */
export async function recordPostgresManualPayment({ sessionHash, leadId, amount, kind, verified, idempotencyKey, note = '', at = new Date(), emailEnabled = false }) {
  const amountCents = cents(amount);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(String(idempotencyKey || '')) || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 1000000000 || !['payment', 'refund'].includes(kind) || verified !== true) {
    return { kind: 'invalid' };
  }
  const timestamp = iso(at);
  try {
    return await withPostgresScopedTransaction(async client => {
      // Acquire write-intent locks in the same order as compatibility writers.
      // ROW EXCLUSIVE permits parallel scoped payments, which serialize on the
      // project row below. It conflicts with the legacy SHARE ROW EXCLUSIVE
      // snapshot locks, so payments can still wait while a legacy write runs.
      await client.query(`LOCK TABLE app_settings, user_accounts, project_requests, projects, commissions, payments,
        withdrawal_requests, finance_ledger_entries, system_notifications, audit_entries, outbox_messages,
        referral_events, rank_requests, crm_records IN ROW EXCLUSIVE MODE`);

      const actorResult = await client.query(`
        SELECT u.id, u.username, u.role, u.active, u.data
        FROM auth_sessions s JOIN user_accounts u ON u.id = s."userId"
        WHERE s.id = $1 AND s."expiresAt" > NOW() AND u.active = TRUE
          AND COALESCE(u.data ->> 'accountDisabledAt', '') IN ('', 'false', '0')
        FOR SHARE OF s, u
      `, [sessionHash]);
      const actorRow = actorResult.rows[0];
      if (!actorRow) return { kind: 'unauthenticated' };
      if (actorRow.role !== 'admin') return { kind: 'forbidden' };
      const actor = { id: actorRow.id, username: actorRow.username || 'admin' };

      const priorPayment = await client.query('SELECT id, "requestId", amount, status, "idempotencyKey", data, "createdAt" FROM payments WHERE "idempotencyKey" = $1', [idempotencyKey]);
      if (priorPayment.rowCount) {
        const prior = priorPayment.rows[0], priorData = object(prior.data);
        if (prior.requestId !== leadId || Number(prior.amount) !== money(amount) || (priorData.kind || prior.status) !== kind) return { kind: 'idempotency_conflict' };
        const priorLead = await client.query('SELECT id, "customerId", "referrerId", "developerId", status, "projectStage", "agreedAmount", data, "createdAt", "updatedAt" FROM project_requests WHERE id = $1', [leadId]);
        if (!priorLead.rowCount) return { kind: 'missing' };
        const lead = { ...object(priorLead.rows[0].data), id: priorLead.rows[0].id, clientId: priorLead.rows[0].customerId || '', referralUserId: priorLead.rows[0].referrerId || null, developerUserId: priorLead.rows[0].developerId || null,
          status: priorLead.rows[0].status || '', projectStage: priorLead.rows[0].projectStage || '', contractAmount: priorLead.rows[0].agreedAmount == null ? object(priorLead.rows[0].data).contractAmount : Number(priorLead.rows[0].agreedAmount) };
        return { kind: 'duplicate', lead, payment: { ...priorData, id: prior.id, idempotencyKey: prior.idempotencyKey, leadId: prior.requestId, amount: Number(prior.amount), kind: priorData.kind || prior.status, at: iso(prior.createdAt) } };
      }

      const requestResult = await client.query(`
        SELECT id, "customerId", "referrerId", "developerId", status, "projectStage", "agreedAmount", data, "createdAt", "updatedAt"
        FROM project_requests WHERE id = $1 FOR UPDATE
      `, [leadId]);
      if (!requestResult.rowCount) return { kind: 'missing' };
      const row = requestResult.rows[0];
      const lead = { ...object(row.data), id: row.id, clientId: row.customerId || object(row.data).clientId || null,
        referralUserId: row.referrerId || object(row.data).referralUserId || null,
        developerUserId: row.developerId || object(row.data).developerUserId || null,
        status: row.status || object(row.data).status || 'new', projectStage: row.projectStage || object(row.data).projectStage || '',
        contractAmount: row.agreedAmount == null ? object(row.data).contractAmount ?? null : Number(row.agreedAmount),
        createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
      const settingsResult = await client.query('SELECT value FROM app_settings WHERE key = $1 FOR SHARE', ['zezo-runtime']);
      const settings = object(settingsResult.rows[0]?.value);
      const paymentRows = await client.query(`
        SELECT COALESCE(SUM(CASE WHEN COALESCE(data ->> 'kind', status) = 'refund' THEN -amount
          WHEN COALESCE(data ->> 'kind', status) = 'payment' THEN amount ELSE 0 END), 0)::numeric AS total
        FROM payments WHERE "requestId" = $1
      `, [lead.id]);
      const persistedPaidTotal = money(paymentRows.rows[0]?.total || 0);
      const snapshotPaidTotal = money(lead.paidTotal || 0);
      if (Math.abs(persistedPaidTotal - snapshotPaidTotal) > 0.01) return { kind: 'ledger_mismatch' };
      lead.paidTotal = persistedPaidTotal;
      if (kind === 'payment' && (!lead.contractAmount || !['active', 'waiting_payment', 'completed'].includes(lead.status))) return { kind: 'not_payable' };
      if (kind === 'refund' && money(amount) > lead.paidTotal) return { kind: 'refund_exceeds_paid' };
      if (kind === 'payment' && lead.paidTotal + money(amount) > Number(lead.contractAmount)) return { kind: 'payment_exceeds_contract' };

      const employeeIds = [...new Set([lead.referralUserId, lead.developerUserId].filter(Boolean))];
      const employeeResult = employeeIds.length ? await client.query('SELECT id, role, username, "fullName", data FROM user_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [employeeIds]) : { rows: [] };
      const employeeById = new Map(employeeResult.rows.map(user => [user.id, user]));
      const referralUser = employeeById.get(lead.referralUserId);
      const beforePaid = lead.paidTotal;
      const paymentId = rowId('pay');
      const payment = { id: paymentId, idempotencyKey, leadId: lead.id, at: timestamp, kind, amount: money(amount), note: String(note || '').trim().replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 300), verifiedBy: actor.username };
      if (kind === 'refund') {
        await cancelRelatedWithdrawals(client, lead, actor, timestamp, emailEnabled);
        lead.paidTotal = money(lead.paidTotal - money(amount));
        lead.refunded = true; lead.refundAt = timestamp; lead.commissionHoldUntil = timestamp;
      } else {
        lead.paidTotal = money(lead.paidTotal + money(amount));
        if (beforePaid < Number(lead.contractAmount) && lead.paidTotal >= Number(lead.contractAmount)) {
          lead.fullyPaidAt = timestamp; lead.everFullyPaid = true; lead.commissionHoldUntil = timestamp;
        }
        if (lead.paidTotal >= Number(lead.contractAmount)) lead.refunded = false;
      }
      lead.updatedAt = timestamp;
      updateReferralCommission(lead, referralUser, settings, timestamp);
      updateDeveloperCommission(lead, settings);

      await client.query(`
        INSERT INTO payments (id, "requestId", amount, currency, status, "idempotencyKey", data, "createdAt")
        VALUES ($1, $2, $3, 'ILS', $4, $5, $6::jsonb, $7)
      `, [payment.id, lead.id, payment.amount, kind, idempotencyKey, JSON.stringify(payment), timestamp]);
      await client.query(`
        UPDATE project_requests SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1
      `, [lead.id, JSON.stringify(lead), timestamp]);
      await client.query(`UPDATE projects SET data = $2::jsonb, "updatedAt" = $3 WHERE "requestId" = $1`, [lead.id, JSON.stringify(lead), timestamp]);
      await persistCommissionRows(client, lead, actor, timestamp);
      await appendLedger(client, { idempotencyKey: `payment:${payment.id}`, type: kind === 'refund' ? 'customer_refund' : 'customer_payment_received',
        leadId: lead.id, employeeId: null, amountCents: (kind === 'refund' ? -1 : 1) * cents(payment.amount), note: payment.note,
        actor: actor.username, postedAt: timestamp }, timestamp);

      if (lead.referralUserId && lead.referralCode) {
        await insertReferralEvent(client, lead, { type: kind === 'refund' ? 'refund' : 'payment_received',
          idempotencyKey: `${kind === 'refund' ? 'refund' : 'payment_received'}:${payment.id}`, at: timestamp });
        const milestones = await syncReferralMilestones(client, lead, timestamp);
        if (milestones?.completionCreated) await insertNotification(client, { userId: lead.referralUserId, eventKey: `milestone:project_completed:${lead.id}`, type: 'project',
          titleAr: 'اكتمل مشروع من إحالتك', titleEn: 'A project from your referral was completed', descriptionAr: 'اكتمل التنفيذ؛ راجع حالة البيع المؤهل في لوحة الإحالات.', descriptionEn: 'The work completed; review qualification in your referral dashboard.',
          tab: 'referral', targetId: lead.id, targetKind: 'lead', at: timestamp });
      }
      await updateCrm(client, lead, actor, timestamp);
      await notifyPayment(client, lead, actor, payment, timestamp);
      if (referralUser) await syncRankRequest(client, referralUser, timestamp, emailEnabled);
      await insertAudit(client, { id: rowId('evt'), actorId: actor.id, actor: actor.username, targetId: lead.id,
        action: kind === 'refund' ? 'refund_recorded' : 'manual_payment_verified', detail: `${payment.amount} ILS`, at: timestamp });
      return { kind: 'created', lead, payment, developerName: employeeById.get(lead.developerUserId)?.fullName || '' };
    });
  } catch (error) {
    if (error?.code !== '23505' || error?.constraint !== 'payments_idempotencyKey_key') throw error;
    const duplicate = await withPostgresScopedTransaction(async client => {
      const result = await client.query('SELECT id, "requestId", amount, status, "idempotencyKey", data, "createdAt" FROM payments WHERE "idempotencyKey" = $1', [idempotencyKey]);
      const row = result.rows[0];
      if (!row || row.requestId !== leadId || Number(row.amount) !== money(amount) || (object(row.data).kind || row.status) !== kind) return { kind: 'idempotency_conflict' };
      const leadResult = await client.query('SELECT id, "customerId", "referrerId", "developerId", status, "projectStage", "agreedAmount", data FROM project_requests WHERE id = $1', [leadId]);
      if (!leadResult.rowCount) return { kind: 'missing' };
      const source = leadResult.rows[0], data = object(source.data);
      return { kind: 'duplicate', payment: { ...object(row.data), id: row.id, leadId: row.requestId, amount: Number(row.amount), kind: object(row.data).kind || row.status, at: iso(row.createdAt) },
        lead: { ...data, id: source.id, clientId: source.customerId, referralUserId: source.referrerId, developerUserId: source.developerId, status: source.status, projectStage: source.projectStage,
          contractAmount: source.agreedAmount == null ? data.contractAmount : Number(source.agreedAmount) } };
    });
    return duplicate;
  }
}
