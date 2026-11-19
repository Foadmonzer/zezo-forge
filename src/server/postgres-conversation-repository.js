import { withPostgresScopedTransaction } from './postgres-runtime.js';
import { loadConversationViews } from './core-read-repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { customerReplyEmail, enqueuePostgresTransactionalMail, mailWithFooter } from './transactional-email.js';

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

async function enqueueCustomerReply(client, { clientId, eventKey, at, siteBase, quote = false }) {
  if (!siteBase || !clientId) return;
  const { rows: [account] } = await client.query(`
    SELECT email, data->>'language' AS language
    FROM user_accounts
    WHERE id = $1 AND role = 'client' AND active = TRUE
      AND COALESCE(data->>'accountDisabledAt', '') IN ('', 'false', '0')
  `, [clientId]);
  if (!account?.email) return;
  await enqueuePostgresTransactionalMail(client, {
    eventKey, at, recipient: account.email, kind: quote ? 'customer_quote_ready' : 'customer_conversation_reply',
    ...customerReplyEmail({ siteBase, language: account.language, quote })
  });
}

async function notifyConversationTeam(client, { conversation, actorId = '', eventKey, copy, at, authorizeRecipient }) {
  const users = await client.query(`
    SELECT id, role, active, data FROM user_accounts
    WHERE active = TRUE AND role <> 'client'
      AND COALESCE(data ->> 'accountDisabledAt', '') IN ('', 'false', '0')
      AND id <> COALESCE($1, '')
  `, [actorId]);
  const resource = {
    assigneeId: conversation.assignedUserId || '',
    ownerId: conversation.clientId || '',
    department: conversation.department || 'orders'
  };
  for (const row of users.rows) {
    const data = object(row.data);
    const recipient = {
      ...data, id: row.id, role: row.role, active: row.active,
      department: data.department || '', permissionOverrides: object(data.permissionOverrides)
    };
    if (authorizeRecipient && !authorizeRecipient(recipient, resource)) continue;
    await insertNotification(client, {
      id: stableId('ntf', `${row.id}:${eventKey}`), userId: row.id, eventKey, copy,
      tab: 'conversations', targetId: conversation.id, at
    });
  }
}

function stableId(prefix, value) {
  const digest = createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
  return `${prefix}_${digest}`;
}

async function storeAttachment(client, file, ownerId) {
  if (!file) return null;
  const attachmentId = `att_${randomUUID().replaceAll('-', '')}`;
  const name = String(file.filename || 'attachment').slice(0, 120);
  const type = String(file.contentType || 'application/octet-stream').toLowerCase();
  await client.query(`
    INSERT INTO stored_attachments (id, "ownerId", "fileName", "contentType", "sizeBytes", content)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [attachmentId, ownerId || null, name, type, file.content.length, file.content]);
  return { attachmentId, storedName: attachmentId, originalName: name, type, size: file.content.length };
}

async function insertConversationMessage(client, { id, conversationId, actor, senderType, text, attachment, at, idempotencyHash = '' }) {
  const attachments = attachment ? [attachment] : [];
  const messageData = { id, senderType, senderId: actor?.id || '', text, createdAt: at, attachments };
  if (idempotencyHash) messageData.idempotencyHash = idempotencyHash;
  await client.query(`
    INSERT INTO conversation_messages (id, "conversationId", "senderId", body, "attachmentId", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [id, conversationId, actor?.id || null, text, attachment?.attachmentId || null, JSON.stringify(messageData), at]);
  return messageData;
}

export async function createPostgresConversation({ conversation, message, attachmentFile, actor, guestHash, idempotencyHash, auditId, messageId, referral, at, authorizeRecipient }) {
  return withPostgresScopedTransaction(async client => {
    const data = { ...conversation, idempotencyHash };
    delete data.messages;
    const inserted = await client.query(`
      INSERT INTO conversations (id, "customerId", "assignedToId", status, "templateId", source, data, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `, [conversation.id, conversation.clientId || null, conversation.assignedUserId || null, conversation.status, conversation.templateId, conversation.source, JSON.stringify(data), at]);
    if (!inserted.rowCount) {
      const existing = await client.query('SELECT id, "customerId", data FROM conversations WHERE id = $1 FOR UPDATE', [conversation.id]);
      const data = object(existing.rows[0].data);
      const sameSubmitter = actor?.role === 'client'
        ? existing.rows[0].customerId === actor.id
        : !existing.rows[0].customerId && data.guestSessionHash === guestHash;
      if (!sameSubmitter || data.idempotencyHash !== idempotencyHash) return { kind: 'conflict' };
      const view = await loadResponse(client, actor || { id: '', role: 'guest' }, conversation.id, guestHash);
      return { kind: 'duplicate', conversation: view };
    }

    const attachment = await storeAttachment(client, attachmentFile, actor?.id || null);
    await insertConversationMessage(client, {
      id: messageId, conversationId: conversation.id, actor, senderType: actor ? 'client' : 'guest',
      text: message, attachment, at, idempotencyHash
    });

    await insertAudit(client, {
      id: auditId, actor, action: 'template_conversation_created', targetId: conversation.id,
      detail: `${conversation.templateId}; referral=${conversation.referralCode || 'none'}`, at
    });
    if (referral?.userId) {
      await client.query(`
        INSERT INTO referral_events (id, "userId", code, "eventType", "resourceId", "idempotencyKey", data, "createdAt")
        VALUES ($1, $2, $3, 'inquiry_confirmed', $4, $5, $6::jsonb, $7)
        ON CONFLICT ("idempotencyKey") DO NOTHING
      `, [stableId('rfe', `conversation:${conversation.id}`), referral.userId, referral.code, conversation.id, `conversation_inquiry:${conversation.id}`, JSON.stringify({ conversationId: conversation.id, referralLinkId: referral.linkId || null }), at]);
    }

    const eventKey = `conversation:${conversation.id}:created`;
    const copy = {
      type: 'inquiry', importance: 'high', titleAr: 'محادثة قالب جديدة', titleEn: 'New template conversation',
      descriptionAr: `وصل استفسار حول ${conversation.templateName}. عيّن مسؤول متابعة للرد.`,
      descriptionEn: `A new enquiry arrived for ${conversation.templateName}. Assign an owner to reply.`
    };
    await notifyConversationTeam(client, { conversation, actorId: actor?.id || '', eventKey, copy, at, authorizeRecipient });

    const view = await loadResponse(client, actor || { id: '', role: 'guest' }, conversation.id, guestHash);
    return { kind: 'created', conversation: view, messageId };
  });
}

export async function createPostgresConversationMessage({ conversationId, actor, guestHash = '', text, attachmentFile, idempotencyHash, messageId, auditId, at, permissionScope = '', authorize, authorizeRecipient, emailSiteBase }) {
  return withPostgresScopedTransaction(async client => {
    const conversation = await selectConversationForUpdate(client, conversationId);
    if (!conversation) return { kind: 'missing' };
    if (!authorize(conversation)) return { kind: 'forbidden' };

    const duplicate = await client.query(`
      SELECT id FROM conversation_messages
      WHERE "conversationId" = $1 AND data ->> 'idempotencyHash' = $2
      LIMIT 1
    `, [conversationId, idempotencyHash]);
    if (duplicate.rowCount) {
      const view = await loadResponse(client, actor, conversationId, guestHash, permissionScope);
      return { kind: 'duplicate', conversation: view };
    }

    const attachment = await storeAttachment(client, attachmentFile, actor?.id || null);
    const senderType = actor?.role === 'guest' ? 'guest' : ['admin', 'hr_manager', 'marketing_manager', 'order_manager'].includes(actor?.role) ? 'staff' : 'client';
    const message = await insertConversationMessage(client, { id: messageId, conversationId, actor, senderType, text, attachment, at, idempotencyHash });
    const nextStatus = conversation.status === 'waiting_customer' ? 'in_progress' : conversation.status;
    await client.query('UPDATE conversations SET status = $2, "updatedAt" = $3 WHERE id = $1', [conversationId, nextStatus, at]);
    await insertAudit(client, { id: auditId, actor: actor?.role === 'guest' ? null : actor, action: 'conversation_message_sent', targetId: conversationId, detail: `${senderType}; ${message.id}; attachment=${Boolean(attachment)}`, at });

    const eventKey = `conversation:${conversationId}:message:${message.id}`;
    const copy = {
      type: 'inquiry', importance: senderType === 'staff' ? 'normal' : 'high',
      titleAr: senderType === 'staff' ? 'رد فريق ZEZO على محادثتك' : 'رسالة جديدة في محادثة قالب',
      titleEn: senderType === 'staff' ? 'ZEZO replied to your conversation' : 'New message in template conversation',
      descriptionAr: senderType === 'staff' ? 'افتح المحادثة لمتابعة الرد.' : `توجد رسالة جديدة في محادثة ${conversation.templateName}.`,
      descriptionEn: senderType === 'staff' ? 'Open your conversation to read the reply.' : `There is a new message in the ${conversation.templateName} conversation.`
    };
    if (senderType === 'staff' && conversation.clientId) {
      await insertNotification(client, { id: stableId('ntf', `${conversation.clientId}:${eventKey}`), userId: conversation.clientId, eventKey, copy, tab: 'conversations', targetId: conversationId, at });
      await enqueueCustomerReply(client, { clientId: conversation.clientId, eventKey, at, siteBase: emailSiteBase });
    } else {
      await notifyConversationTeam(client, { conversation, actorId: actor?.id || '', eventKey, copy, at, authorizeRecipient });
    }
    const view = await loadResponse(client, actor, conversationId, guestHash, permissionScope);
    return { kind: 'created', conversation: view, messageId: message.id };
  });
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

export async function createPostgresQuote({ conversationId, actor, quote, message, auditId, messageId, notificationId, at, permissionScope, authorize, emailSiteBase }) {
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
    await enqueueCustomerReply(client, { clientId: conversation.clientId, eventKey: `quote:${quote.id}:sent`, at, siteBase: emailSiteBase, quote: true });
    const view = await loadResponse(client, actor, conversation.id, '', permissionScope);
    return { kind: 'ok', conversation: view };
  });
}

export async function acceptPostgresQuote({ conversationId, actor, guestHash = '', quoteMessage, auditId, messageId, notificationIds = [], at, permissionScope = '', authorize, adminEmailSiteBase }) {
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
      if (adminEmailSiteBase) await enqueuePostgresTransactionalMail(client, {
        eventKey: `quote:${quoteRow.id}:accepted`, at, recipientType: 'admin', kind: 'client_quote_accepted',
        subject: 'تم قبول عرض سعر في ZEZO / A ZEZO quote was accepted',
        text: mailWithFooter(`قبِل عميل عرض سعر. افتح مساحة الفريق لمراجعة المحادثة.\nA customer accepted a quote. Open the team workspace to review the conversation.\n${adminEmailSiteBase}/team`, 'both')
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
