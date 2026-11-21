export const developmentManagerRole = 'development_manager';

export const developmentTechnicalStages = ['technical_review', 'needs_revisions', 'ready_delivery', 'waiting_client_review', 'delivered', 'completed'];
const technicalStages = new Set(developmentTechnicalStages);
const closedStages = new Set(['ready_delivery', 'waiting_client_review', 'delivered', 'completed', 'cancelled']);
const assignmentStages = new Set(['under_review', 'waiting_payment_to_start', 'waiting_developer_acceptance', 'in_progress', 'technical_review', 'needs_revisions']);

export function developmentStage(lead) {
  return lead.projectStage || ({ review: 'under_review', active: 'in_progress', waiting_payment: 'waiting_payment_to_start', technical_review: 'technical_review', ready_delivery: 'ready_delivery', completed: 'completed', cancelled: 'cancelled' })[lead.status] || 'new_request';
}

export function developmentProjectAccessible(lead, managerId) {
  if (!lead || lead.isDuplicate || lead.status === 'cancelled') return false;
  const review = lead.developmentReview || {};
  if (review.managerId) return review.managerId === managerId;
  return technicalStages.has(developmentStage(lead)) ||
    (lead.projectHistory || []).some(entry => technicalStages.has(entry.stage)) || review.inReview === true;
}

export function developmentAssignmentAllowed(lead, payments) {
  if (!lead || lead.isDuplicate || closedStages.has(developmentStage(lead)) || !assignmentStages.has(developmentStage(lead))) return false;
  if (lead.hasDeveloperCommission || lead.hasDeveloperProgress) return false;
  if (!lead.developerUserId) return !lead.projectStartedAt && !lead.developerAcceptedAt && !lead.developerReviewApprovedAt && !lead.developerCommissionReview &&
    !lead.developerWithdrawalId && !Number(lead.developerCommissionAmount || 0) && !Number(lead.developerCommissionPaidAmount || 0);
  if (!['', 'offered'].includes(lead.developerTaskStatus || '')) return false;
  return !lead.developerAcceptedAt && !lead.developerReviewApprovedAt && !lead.developerCommissionReview &&
    !lead.developerWithdrawalId && !Number(lead.developerCommissionAmount || 0) && !Number(lead.developerCommissionPaidAmount || 0) &&
    !Number(lead.paidTotal || 0) && !lead.financeSettlement && !lead.financeSettlements?.length &&
    !payments.some(payment => payment.leadId === lead.id);
}

export function developmentManagerIdentity(user) {
  return { id: user.id, name: user.name || '', username: user.username || '', role: user.role, mfaEnabled: Boolean(user.mfaEnabledAt), mustChangePassword: Boolean(user.mustChangePassword) };
}

const fileView = (attachment, index) => ({ index, name: attachment.originalName, size: attachment.size });
const noteView = ({ id, kind, text, author, at }) => ({ id, kind, text, author, at });
const assignmentView = ({ fromDeveloperId, fromDeveloperName, developerId, developerName, reason, note, dueAt, actor, at }) =>
  ({ fromDeveloperId, fromDeveloperName, developerId, developerName, reason, note, dueAt, actor, at });

export function developmentProjectView(lead, payments = []) {
  const review = lead.developmentReview || {};
  const projectStage = developmentStage(lead);
  return {
    id: lead.id, title: lead.templateName || lead.service || lead.category || lead.id,
    service: lead.service || '', category: lead.category || '',
    details: review.allowCustomerConversation === true ? lead.details || '' : lead.technicalRequirements || '',
    technicalRequirements: lead.technicalRequirements || '', status: lead.status || '', projectStage,
    createdAt: lead.createdAt || null, dueAt: String(lead.developerDueDate || '').slice(0, 10), developerId: lead.developerUserId || null,
    developerTaskStatus: lead.developerTaskStatus || '', developerTaskNote: lead.developerTaskNote || '',
    developerUpdatedAt: lead.developerUpdatedAt || null, version: Number(review.version || 0),
    canAssign: developmentAssignmentAllowed(lead, payments),
    canRequestRevision: lead.developerTaskStatus === 'review_requested' && projectStage === 'technical_review' && Boolean(lead.developerUserId),
    canReadConversation: review.allowCustomerConversation === true,
    files: (lead.developerAttachments || []).map(fileView),
    customerFiles: review.allowCustomerConversation === true ? (lead.attachments || []).map(fileView) : [],
    review: {
      managerId: review.managerId || null, allowCustomerConversation: review.allowCustomerConversation === true,
      category: review.category || '', complexity: review.complexity || '', skills: review.skills || [],
      estimateDays: review.estimateDays ?? null, priority: review.priority || '', inReview: review.inReview === true,
      reviewedAt: review.reviewedAt || null, reviewedBy: review.reviewedBy || '',
      notes: (review.notes || []).map(noteView), assignmentHistory: (review.assignmentHistory || []).map(assignmentView)
    }
  };
}

export function developmentDeveloperView(user, leads, today) {
  const profile = user.developmentProfile || {};
  const projects = leads.filter(lead => lead.developerUserId === user.id);
  const completed = projects.filter(lead => ['completed', 'delivered'].includes(developmentStage(lead)));
  const activeProjects = projects.filter(lead => !['completed', 'delivered', 'cancelled'].includes(developmentStage(lead)));
  const overdue = activeProjects.filter(lead => lead.developerDueDate && String(lead.developerDueDate).slice(0, 10) < today);
  const active = user.active === true && !user.accountDisabledAt;
  return {
    id: user.id, name: user.name || '', username: user.username || '', active, status: active ? 'active' : 'inactive',
    specialties: profile.specialties || [], skills: profile.skills || [], availability: profile.availability || '',
    professionalContact: profile.professionalContact || '', notes: profile.notes || '', enrolledAt: user.createdAt || null,
    lastActivityAt: projects.map(lead => lead.developerUpdatedAt || lead.developerRespondedAt || lead.developerAssignedAt || '').sort().at(-1) || null,
    workload: { assigned: projects.length, active: activeProjects.length, completed: completed.length, overdue: overdue.length }
  };
}

export function canUseDevelopmentManagerRoute(route) {
  const selfService = ['/api/auth/session', '/api/auth/login', '/api/auth/logout', '/api/auth/password', '/api/auth/mfa/setup',
    '/api/auth/mfa/enable', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/activate'];
  return route === '/api/dashboard' || selfService.includes(route) || route === '/api/notifications' ||
    /^\/api\/notifications\/[^/]+$/.test(route) || route === '/api/development-manager' || route.startsWith('/api/development-manager/');
}
