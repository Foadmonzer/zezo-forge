import { randomUUID } from 'node:crypto';
import { queryPostgres, withPostgresScopedTransaction } from './postgres-runtime.js';

const keyFor = projectId => `project-review:${projectId}`;
const projectEligible = `p.status = 'completed' AND p."projectStage" = 'completed'
  AND (COALESCE(p.data->>'projectDeliveredAt', '') <> '' OR COALESCE(p.data->>'clientDeliveryAt', '') <> '')
  AND COALESCE(p.data->>'isDuplicate', 'false') <> 'true'
  AND COALESCE(p.data->>'duplicateOfLeadId', '') = ''`;

function displayReview(review) {
  const { id, rating, body, submittedAt, service, reply } = review;
  return { id, rating, body, submittedAt, service, ...(reply ? { reply: { body: reply.body, createdAt: reply.createdAt } } : {}) };
}

function privateReview(review) {
  return { ...displayReview(review), projectId: review.projectId, status: review.status };
}

export async function listPublishedProjectReviews({ sort, limit, offset }) {
  const order = sort === 'highest' ? `r.value->>'rating' DESC, `
    : sort === 'lowest' ? `r.value->>'rating' ASC, ` : '';
  const { rows } = await queryPostgres(`
    SELECT r.value, COUNT(*) OVER () AS total
    FROM app_settings r JOIN project_requests p ON p.id = r.value->>'projectId'
    WHERE r.key LIKE 'project-review:%' AND r.value->>'status' = 'published' AND ${projectEligible}
    ORDER BY ${order} r.value->>'submittedAt' DESC, r.key
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return { reviews: rows.map(row => displayReview(row.value)), total: Number(rows[0]?.total || 0) };
}

export async function listProjectReviewsForModeration({ status, limit, offset }) {
  const { rows } = await queryPostgres(`
    SELECT value, COUNT(*) OVER () AS total FROM app_settings
    WHERE key LIKE 'project-review:%' AND ($1::text IS NULL OR value->>'status' = $1)
    ORDER BY value->>'submittedAt' DESC, key LIMIT $2 OFFSET $3
  `, [status || null, limit, offset]);
  return { reviews: rows.map(row => privateReview(row.value)), total: Number(rows[0]?.total || 0) };
}

export async function loadCustomerProjectReview(projectId, clientId) {
  const { rows: [row] } = await queryPostgres(`
    SELECT (${projectEligible}) AS eligible, r.value AS review
    FROM project_requests p LEFT JOIN app_settings r ON r.key = $3
    WHERE p.id = $1 AND p."customerId" = $2
  `, [projectId, clientId, keyFor(projectId)]);
  return row ? { eligible: Boolean(row.eligible), review: row.review ? privateReview(row.review) : null } : null;
}

// Match the compatibility transaction's lock order before touching project or user rows.
// Concurrent scoped writes can still proceed on independent projects.
async function reviewWrite(work) {
  return withPostgresScopedTransaction(async client => {
    await client.query(`SET LOCAL lock_timeout = '3s'`);
    await client.query(`LOCK TABLE app_settings, user_accounts, project_requests, system_notifications, audit_entries IN ROW EXCLUSIVE MODE`);
    return work(client);
  });
}

async function activeActor(client, { sessionHash, actorId, role }) {
  const { rows: [actor] } = await client.query(`
    SELECT u.id, u.username, u.role FROM auth_sessions s JOIN user_accounts u ON u.id = s."userId"
    WHERE s.id = $1 AND u.id = $2 AND u.role = $3 AND u.active = TRUE AND s."expiresAt" > NOW()
      AND COALESCE(u.data->>'accountDisabledAt', '') IN ('', 'false', '0')
      AND COALESCE(u.data->>'mustChangePassword', 'false') <> 'true'
      AND (u.role <> 'admin' OR COALESCE(u.data->>'mfaEnabledAt', '') <> '')
    FOR SHARE OF s, u
  `, [sessionHash, actorId, role]);
  return actor;
}

async function insertAudit(client, actor, action, review, detail) {
  await client.query(`
    INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
  `, [`evt_${randomUUID()}`, actor.id, action, review.projectId, JSON.stringify({ actor: actor.username, role: actor.role, detail })]);
}

async function notifyReview(client, { userId, review, event, titleAr, titleEn, team = false }) {
  const data = {
    eventKey: `project-review:${review.id}:${event}`,
    importance: 'normal', titleAr, titleEn,
    target: { tab: team ? 'requests' : 'orders', kind: 'lead', id: review.projectId }
  };
  await client.query(`
    INSERT INTO system_notifications (id, "userId", type, data, "createdAt")
    SELECT 'ntf_' || md5($1 || ':' || u.id), u.id, 'project', $2::jsonb, NOW()
    FROM user_accounts u WHERE u.active = TRUE AND (u.id = $3 OR ($4 AND u.role = 'admin'))
      AND COALESCE(u.data->>'accountDisabledAt', '') IN ('', 'false', '0')
    ON CONFLICT (id) DO NOTHING
  `, [data.eventKey, JSON.stringify(data), userId || null, team]);
}

export async function submitProjectReview({ sessionHash, actorId, projectId, rating, body }) {
  return reviewWrite(async client => {
    const actor = await activeActor(client, { sessionHash, actorId, role: 'client' });
    if (!actor) return { kind: 'unauthorized' };
    const { rows: [project] } = await client.query(`
      SELECT (${projectEligible}) AS eligible, p.data->>'service' AS service
      FROM project_requests p WHERE p.id = $1 AND p."customerId" = $2 FOR SHARE
    `, [projectId, actor.id]);
    if (!project) return { kind: 'missing' };
    if (!project.eligible) return { kind: 'ineligible' };

    const service = ['web', 'apps', 'ai', 'ideas'].includes(project.service) ? project.service : '';
    const review = { id: `review_${randomUUID()}`, projectId, rating, body, service, status: 'pending', submittedAt: new Date().toISOString() };
    const inserted = await client.query(`
      INSERT INTO app_settings (key, value, "updatedAt") VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING RETURNING key
    `, [keyFor(projectId), JSON.stringify(review)]);
    if (!inserted.rowCount) {
      const { rows: [previous] } = await client.query('SELECT value FROM app_settings WHERE key = $1', [keyFor(projectId)]);
      return { kind: 'existing', review: privateReview(previous.value) };
    }

    await insertAudit(client, actor, 'project_review_submitted', review, 'pending');
    await notifyReview(client, { review, event: 'submitted', titleAr: 'تقييم مشروع بانتظار المراجعة', titleEn: 'Project review awaiting moderation', team: true });
    return { kind: 'created', review: privateReview(review) };
  });
}

export async function moderateProjectReview({ sessionHash, actorId, projectId, status, reply }) {
  return reviewWrite(async client => {
    const actor = await activeActor(client, { sessionHash, actorId, role: 'admin' });
    if (!actor) return { kind: 'unauthorized' };
    const { rows: [project] } = await client.query(`
      SELECT (${projectEligible}) AS eligible, p."customerId" AS "customerId"
      FROM project_requests p WHERE p.id = $1 FOR SHARE
    `, [projectId]);
    const { rows: [row] } = await client.query('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [keyFor(projectId)]);
    if (!row) return { kind: 'missing' };

    const review = row.value;
    const isReply = reply !== undefined;
    if ((status === 'published' || isReply) && !project?.eligible) return { kind: 'ineligible' };
    if (isReply && review.status !== 'published') return { kind: 'ineligible' };
    if (status === review.status || (isReply && reply === (review.reply?.body || ''))) {
      return { kind: 'unchanged', review: privateReview(review) };
    }

    const updated = { ...review };
    if (isReply) {
      if (reply) updated.reply = { body: reply, createdAt: new Date().toISOString() };
      else delete updated.reply;
    } else updated.status = status;
    await client.query('UPDATE app_settings SET value = $2::jsonb, "updatedAt" = NOW() WHERE key = $1', [keyFor(projectId), JSON.stringify(updated)]);
    await insertAudit(client, actor, isReply ? 'project_review_reply_updated' : 'project_review_moderated', updated, isReply ? (reply ? 'reply_saved' : 'reply_removed') : status);

    if (project?.customerId && (status === 'published' || (isReply && reply))) {
      await notifyReview(client, {
        review: updated, userId: project.customerId, event: isReply ? 'reply' : 'published',
        titleAr: isReply ? 'ردت ZEZO على تقييمك' : 'نُشر تقييم مشروعك',
        titleEn: isReply ? 'ZEZO replied to your review' : 'Your project review was published'
      });
    }
    return { kind: 'updated', review: privateReview(updated) };
  });
}
