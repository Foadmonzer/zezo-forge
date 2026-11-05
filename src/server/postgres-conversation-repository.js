import { withPostgresScopedTransaction } from './postgres-runtime.js';
import { loadConversationViews } from './core-read-repository.js';
import { randomUUID } from 'node:crypto';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function mapConversation(row) {
  const data = object(row.data);
  return {
    ...data,
    id: row.id,
    clientId: row.customerId || data.clientId || null,
    assignedUserId: row.assignedToId || data.assignedUserId || null,
    status: row.status || 'new',
    department: data.department || 'orders',
    templateId: row.templateId || data.templateId || '',
    updatedAt: row.updatedAt,
    createdAt: row.createdAt
  };
}
async function selectConversationForUpdate(client, conversationId) {
  const result = await client.query(`
    SELECT id, "customerId", "assignedToId", status, "templateId", data, "createdAt", "updatedAt"
    FROM conversations WHERE id = $1 FOR UPDATE
  `, [conversationId]);
  return result.rows[0] ? mapConversation(result.rows[0]) : null;
}

async function insertAudit(client, { id, actor, action, targetId, detail, at }) {
  await client.query(`
    INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  `, [id, actor?.id || null, action, targetId, JSON.stringify({ actor: actor?.username || 'guest', role: actor?.role || 'guest', detail }), at]);
}

async function insertNotification(client, { id, userId, eventKey, copy, tab, targetId, at }) {
  if (!userId) return;
  const data = {
    eventKey, importance: copy.importance || 'normal', titleAr: copy.titleAr, titleEn: copy.titleEn,
    descriptionAr: copy.descriptionAr || '', descriptionEn: copy.descriptionEn || '',
    target: { tab, id: targetId, kind: 'conversation' }
  };
  await client.query(`
    INSERT INTO system_notifications (id, "userId", type, data, "createdAt")
    SELECT $1, u.id, $3, $4::jsonb, $5
    FROM user_accounts u
    WHERE u.id = $2 AND u.active = TRUE AND COALESCE(u.data ->> 'accountDisabledAt', '') IN ('', 'false', '0')
      AND NOT EXISTS (
        SELECT 1 FROM system_notifications n WHERE n."userId" = u.id AND n.data ->> 'eventKey' = $6
      )
  `, [id, userId, copy.type || 'inquiry', JSON.stringify(data), at, eventKey]);
}

async function loadResponse(client, actor, conversationId, guestHash = '', permissionScope = '') {
  const rows = await loadConversationViews(actor, {
    conversationId,
    permissionScope: actor.role === 'admin' ? 'all' : permissionScope,
    department: actor.department || 'orders',
    guestHash
  });
  return rows[0] || null;
}

export async function createPostgresQuote({ conversationId, actor, quote, message, auditId, messageId, notificationId, at, permissionScope, authorize }) {
  return withPostgresScopedTransaction(async client => {
    const conversation = await selectConversationForUpdate(client, conversationId);
    if (!conversation) return { kind: 'missing' };
    if (!authorize(conversation)) return { kind: 'forbidden' };

    const eventKey = `conversation:${conversation.id}:message:${at}`;
    const quoteData = { ...quote, status: 'sent', createdAt: at };
    const messageData = { id: messageId, senderType: 'staff', senderId: actor.id, text: message, createdAt: at, attachments: [] };
    await client.query(`
      INSERT INTO quotes (id, "conversationId", amount, currency, state, data, "createdAt")
      VALUES ($1, $2, $3, 'ILS', 'sent', $4::jsonb, $5)
    `, [quote.id, conversation.id, quote.amount, JSON.stringify(quoteData), at]);
    await client.query(`
      UPDATE conversations SET status = 'waiting_customer', "updatedAt" = $2
      WHERE id = $1
    `, [conversation.id, at]);
    await client.query(`
      INSERT INTO conversation_messages (id, "conversationId", "senderId", body, data, "createdAt")
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [messageId, conversation.id, actor.id, message, JSON.stringify(messageData), at]);
    await insertAudit(client, { id: auditId, actor, action: 'conversation_quote_sent', targetId: conversation.id, detail: `${quote.id}; ${quote.amount} ILS`, at });
    if (conversation.clientId) await insertNotification(client, {
      id: notificationId, userId: conversation.clientId, eventKey, targetId: conversation.id, at, tab: 'conversations',
      copy: { type: 'inquiry', titleAr: 'رد فريق ZEZO على محادثتك', titleEn: 'ZEZO replied to your conversation', descriptionAr: 'افتح المحادثة لمتابعة عرض السعر.', descriptionEn: 'Open the conversation to review the quote.' }
    });
    const view = await loadResponse(client, actor, conversation.id, '', permissionScope);
    return { kind: 'ok', conversation: view };
  });
}

export async function acceptPostgresQuote({ conversationId, actor, guestHash = '', quoteMessage, auditId, messageId, notificationIds = [], at, permissionScope = '', authorize }) {
  return withPostgresScopedTransaction(async client => {
    const conversation = await selectConversationForUpdate(client, conversationId);
    if (!conversation) return { kind: 'missing' };
    if (!authorize(conversation)) return { kind: 'forbidden' };
    const quoteResult = await client.query(`
      SELECT id, amount, currency, state, data
      FROM quotes WHERE "conversationId" = $1
      ORDER BY "createdAt" DESC, id DESC LIMIT 1 FOR UPDATE
    `, [conversation.id]);
    const quoteRow = quoteResult.rows[0];
    if (!quoteRow || quoteRow.state !== 'sent') return { kind: 'no_pending_quote' };

    const acceptedAt = at;
    const amount = Number(quoteRow.amount);
    const quoteData = { ...object(quoteRow.data), status: 'accepted', acceptedAt };
    const agreedPriceSnapshot = { amount, currency: quoteRow.currency || 'ILS', quoteId: quoteRow.id, acceptedAt };
    const senderType = actor.role === 'guest' ? 'guest' : 'client';
    const senderId = actor.role === 'guest' ? '' : actor.id;
    const messageData = { id: messageId, senderType, senderId, text: quoteMessage, createdAt: at, attachments: [] };
    await client.query(`UPDATE quotes SET state = 'accepted', data = $2::jsonb WHERE id = $1`, [quoteRow.id, JSON.stringify(quoteData)]);
    await client.query(`
      UPDATE conversations
      SET "customerId" = COALESCE("customerId", NULLIF($2, '')),
          data = CASE WHEN NULLIF($2, '') IS NOT NULL
            THEN ((data - 'guestSessionHash') || jsonb_build_object('clientId', $2, 'agreedPriceSnapshot', $3::jsonb))
            ELSE data || jsonb_build_object('agreedPriceSnapshot', $3::jsonb)
          END
      WHERE id = $1
    `, [conversation.id, actor.role === 'client' ? actor.id : '', JSON.stringify(agreedPriceSnapshot)]);
    await client.query(`
      INSERT INTO conversation_messages (id, "conversationId", "senderId", body, data, "createdAt")
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [messageId, conversation.id, senderId || null, quoteMessage, JSON.stringify(messageData), at]);
    await client.query('UPDATE conversations SET "updatedAt" = $2 WHERE id = $1', [conversation.id, at]);
    await insertAudit(client, { id: auditId, actor: actor.role === 'guest' ? null : actor, action: 'conversation_quote_accepted', targetId: conversation.id, detail: quoteRow.id, at });

    const eventKey = `conversation:${conversation.id}:message:${at}`;
    let index = 0;
    if (actor.role === 'client' || actor.role === 'guest') {
      const copy = { type: 'inquiry', titleAr: 'رسالة جديدة في محادثة قالب', titleEn: 'New message in template conversation', descriptionAr: `توجد رسالة جديدة في محادثة ${conversation.templateName || ''}.`, descriptionEn: 'A customer accepted the quote in your template conversation.' };
      const recipients = await client.query(`SELECT id, role FROM user_accounts WHERE active = TRUE AND COALESCE(data ->> 'accountDisabledAt', '') IN ('', 'false', '0') AND role = ANY($1::text[])`, [['admin', 'order_manager']]);
      for (const recipient of recipients.rows) {
        if (recipient.id === actor.id) continue;
        await insertNotification(client, { id: notificationIds[index++] || `ntf_${randomUUID()}`, userId: recipient.id, eventKey, targetId: conversation.id, at, tab: 'conversations', copy });
      }
      if (conversation.assignedUserId && conversation.assignedUserId !== actor.id) await insertNotification(client, {
        id: notificationIds[index] || `ntf_${randomUUID()}`, userId: conversation.assignedUserId, eventKey, targetId: conversation.id, at, tab: 'conversations', copy
      });
    } else if (conversation.clientId) {
      await insertNotification(client, {
        id: notificationIds[index] || `ntf_${randomUUID()}`, userId: conversation.clientId, eventKey, targetId: conversation.id, at, tab: 'conversations',
        copy: { type: 'inquiry', titleAr: 'رد فريق ZEZO على محادثتك', titleEn: 'ZEZO replied to your conversation', descriptionAr: 'افتح المحادثة لمتابعة الرد.', descriptionEn: 'Open the conversation to read the reply.' }
      });
    }
    const responseActor = actor.role === 'guest' ? { id: '', role: 'guest' } : actor;
    const view = await loadResponse(client, responseActor, conversation.id, guestHash, permissionScope);
    return { kind: 'ok', conversation: view, quoteId: quoteRow.id };
  });
}
