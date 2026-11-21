const apiRoot = '/api/development-manager';
const stages = {
  new_request: ['طلب جديد', 'New request'],
  under_review: ['قيد المراجعة', 'Under review'],
  waiting_developer_acceptance: ['بانتظار قبول المبرمج', 'Awaiting developer acceptance'],
  in_progress: ['قيد التنفيذ', 'In progress'],
  quote_sent: ['أُرسل عرض السعر', 'Quote sent'],
  waiting_customer_approval: ['بانتظار موافقة العميل', 'Awaiting customer approval'],
  waiting_payment_to_start: ['بانتظار بدء التنفيذ', 'Awaiting project start'],
  technical_review: ['مراجعة التسليم', 'Technical delivery review'],
  quality_review: ['مراجعة الجودة', 'Quality review'],
  ready_for_delivery: ['جاهز للتسليم', 'Ready for delivery'],
  ready_delivery: ['جاهز للتسليم', 'Ready for delivery'],
  changes_requested: ['مطلوب تعديلات', 'Changes requested'],
  needs_revisions: ['مطلوب تعديلات', 'Changes requested'],
  waiting_client_review: ['بانتظار مراجعة العميل', 'Awaiting customer review'],
  delivered: ['تم التسليم', 'Delivered'],
  completed: ['مكتمل', 'Completed'],
  archived: ['مؤرشف', 'Archived'],
  cancelled: ['ملغى', 'Cancelled']
};
const priorities = {
  low: ['منخفضة', 'Low'],
  normal: ['عادية', 'Normal'],
  medium: ['متوسطة', 'Medium'],
  high: ['عالية', 'High'],
  urgent: ['عاجلة', 'Urgent']
};
const complexities = {
  low: ['منخفض', 'Low'],
  medium: ['متوسط', 'Medium'],
  high: ['عالٍ', 'High']
};
const availabilityLabels = {
  available: ['متاح للعمل', 'Available'],
  busy: ['مشغول', 'Busy'],
  unavailable: ['غير متاح', 'Unavailable'],
  unspecified: ['التوفر غير محدد', 'Availability unspecified']
};
const activityLabels = {
  review: ['مراجعة تقنية', 'Technical review'],
  assignment: ['إسناد مشروع', 'Project assignment'],
  reassignment: ['إعادة إسناد المشروع', 'Project reassignment'],
  delegation: ['تفويض تقني', 'Technical delegation'],
  update_request: ['طلب تحديث من المبرمج', 'Developer update requested'],
  owner_escalation: ['إحالة إلى المالك', 'Escalated to the owner'],
  revision: ['طلب تعديلات على التسليم', 'Delivery revisions requested'],
  note: ['ملاحظة تقنية', 'Technical note']
};
const deliveryStages = new Set(['technical_review', 'quality_review', 'ready_for_delivery', 'ready_delivery']);
const closedStages = new Set(['delivered', 'completed', 'archived', 'cancelled', 'rejected', 'refunded']);
const safeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const list = value => Array.isArray(value) ? value : [];
const pathFor = projectId => `${apiRoot}/projects/${encodeURIComponent(projectId)}`;

function field(label, control) {
  return `<label><span>${label}</span>${control}</label>`;
}

function choices(labels, value, t) {
  return Object.entries(labels).map(([key, label]) => (
    `<option value="${key}"${key === value ? ' selected' : ''}>${t(...label)}</option>`
  )).join('');
}

function textField(name, label, value, maxLength, required = false) {
  return field(label, `<input name="${name}" value="${safeHtml(value)}" maxlength="${maxLength}" autocomplete="off" dir="auto"${required ? ' required' : ''}>`);
}

function textArea(name, label, value, maxLength) {
  return field(label, `<textarea name="${name}" maxlength="${maxLength}" dir="auto">${safeHtml(value)}</textarea>`);
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error('Technical workspace request failed'), {
      status: response.status,
      code: result.code
    });
  }
  return result;
}

export function mountDevelopmentManager(container, {language, tab, serviceTitle, isCurrent, owner = false, targetId = ''}) {
  const t = (ar, en) => language === 'en' ? en : ar;
  const localizedDate = (value, withTime = false) => {
    if (!value) return '—';
    const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const date = new Date(calendarDate ? `${value}T00:00:00Z` : value);
    if (!Number.isFinite(date.valueOf())) return '—';
    return new Intl.DateTimeFormat(t('ar', 'en'), {
      dateStyle: 'medium',
      ...(withTime && !calendarDate ? {timeStyle: 'short'} : {}),
      ...(calendarDate ? {timeZone: 'UTC'} : {})
    }).format(date);
  };
  const status = value => t(...(stages[value] || ['حالة غير محددة', 'Status unavailable']));
  const amount = value => new Intl.NumberFormat(t('ar', 'en')).format(value ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  const stageOf = project => project.projectStage || project.stage;
  const dueOf = project => project.dueAt || project.dueDate;
  const late = project => Boolean(dueOf(project) && String(dueOf(project)).slice(0, 10) < today && !closedStages.has(stageOf(project)));
  const needsDeliveryReview = project => deliveryStages.has(stageOf(project));
  const errorText = error => {
    if (error.status === 401) return t('انتهت جلستك. سجّل الدخول مجددًا.', 'Your session has expired. Sign in again.');
    if (error.status === 403) return t('صلاحية هذه العملية غير متاحة لحسابك. قد يتطلب المشروع موافقة المالك.', 'This action is unavailable to your account. The project may require owner approval.');
    if (error.status === 404) return t('تعذر العثور على المشروع ضمن نطاقك. حدّث القائمة.', 'This project is unavailable in your workspace. Refresh the list.');
    if (error.status === 409) return t('تغيّر المشروع منذ فتحه. حدّث التفاصيل وراجعها قبل إعادة المحاولة.', 'The project changed since you opened it. Refresh the details before trying again.');
    if (error.status === 429) return t('تم إرسال طلبات كثيرة. حاول مجددًا بعد قليل.', 'Too many requests. Try again shortly.');
    if (error.status >= 400 && error.status < 500) return t('راجع الحقول المطلوبة وحالة المشروع والمبرمج المختار.', 'Check the required fields, project status, and selected developer.');
    return t('تعذر إكمال العملية. تحقّق من الاتصال وحاول مجددًا.', 'Could not complete the action. Check your connection and try again.');
  };
  const headings = {
    'technical-overview': t('نظرة عامة على العمل التقني', 'Technical operations overview'),
    'technical-requests': t('طلبات المراجعة التقنية', 'Technical review requests'),
    'technical-developers': t('المبرمجون', 'Developers'),
    'technical-progress': t('متابعة التنفيذ', 'Project progress'),
    'technical-deliveries': t('مراجعة التسليمات', 'Delivery review'),
    'technical-activity': t('سجل النشاط التقني', 'Technical activity'),
    'technical-delegation': t('التفويض وإعدادات الفريق التقني', 'Delegation & developer profiles')
  };
  let snapshot;
  let selectedProjectId = targetId;
  let openDeveloperId = '';
  const filters = {query: '', stage: '', developer: '', service: '', priority: '', due: ''};

  function shell(body) {
    return `<header class="dm-heading"><h2>${headings[tab] || headings['technical-overview']}</h2>
      <button type="button" class="dm-button" data-dm-reload>${t('تحديث', 'Refresh')}</button></header>
      <p class="dm-feedback" data-dm-feedback role="status" aria-live="polite"></p>${body}`;
  }

  const empty = (ar, en) => `<p class="dm-empty">${t(ar, en)}</p>`;
  const item = (name, value) => `<div><dt>${name}</dt><dd dir="auto">${safeHtml(value || '—')}</dd></div>`;
  const cell = (label, value) => `<div class="dm-row-cell"><small>${label}</small>${value}</div>`;
  const button = (label, attributes, accent = false) => (
    `<button type="button" class="dm-button${accent ? ' dm-primary' : ''}" ${attributes}>${label}</button>`
  );
  const developerName = (project, developers) => (
    project.developerName ||
    developers.find(developer => developer.id === project.developerId)?.name ||
    (project.developerId ? t('مبرمج مسند', 'Developer assigned') : t('بلا إسناد', 'Unassigned'))
  );
  const projectTitle = project => (
    (project.title !== project.service ? project.title : '') || serviceTitle(project.service) || t('مشروع', 'Project')
  );
  const priorityOf = project => project.review?.priority || project.priority || 'normal';
  const projectRef = project => project.number || project.reference || project.id;

  function filterOptions(items, value, defaultLabel) {
    return `<option value="">${defaultLabel}</option>${items.map(([key, label]) => (
      `<option value="${safeHtml(key)}"${key === value ? ' selected' : ''}>${safeHtml(label)}</option>`
    )).join('')}`;
  }

  function renderFilters(projects, developers) {
    const options = [
      ['stage', t('الحالة', 'Status'), [...new Set(projects.map(stageOf).filter(Boolean))].map(key => [key, status(key)])],
      ['developer', t('المبرمج', 'Developer'), developers.map(developer => [developer.id, developer.name])],
      ['service', t('الخدمة', 'Service'), [...new Set(projects.map(project => project.service).filter(Boolean))].map(key => [key, serviceTitle(key)])],
      ['priority', t('الأولوية', 'Priority'), Object.entries(priorities).map(([key, labels]) => [key, t(...labels)])],
      ['due', t('موعد التسليم', 'Due date'), [['late', t('متأخر', 'Overdue')], ['scheduled', t('محدد', 'Scheduled')], ['unscheduled', t('بدون موعد', 'Unscheduled')]]]
    ];
    return `<form class="dm-filters" data-dm-filters>
      ${field(t('البحث برقم الطلب أو عنوانه', 'Search by request number or title'), `<input type="search" name="query" dir="auto" autocomplete="off" value="${safeHtml(filters.query)}">`)}
      ${options.map(([name, label, values]) => field(label, `<select name="${name}">${filterOptions(values, filters[name], t('الكل', 'All'))}</select>`)).join('')}
    </form><div data-dm-results></div>`;
  }

  function applicableProjects() {
    const projects = list(snapshot.projects);
    if (tab === 'technical-deliveries') return projects.filter(needsDeliveryReview);
    if (tab === 'technical-progress') return projects.filter(project => project.developerId && !closedStages.has(stageOf(project)));
    return projects;
  }

  function resultsMarkup(projects, developers) {
    const query = filters.query.trim().toLocaleLowerCase(language);
    const filtered = projects.filter(project => {
      const due = dueOf(project);
      return (!query || [projectRef(project), projectTitle(project)].some(value => String(value).toLocaleLowerCase(language).includes(query))) &&
        (!filters.stage || stageOf(project) === filters.stage) &&
        (!filters.developer || project.developerId === filters.developer) &&
        (!filters.service || project.service === filters.service) &&
        (!filters.priority || priorityOf(project) === filters.priority) &&
        (!filters.due ||
          (filters.due === 'late' && late(project)) ||
          (filters.due === 'scheduled' && due) ||
          (filters.due === 'unscheduled' && !due));
    });
    return filtered.length
      ? `<ul class="dm-requests" role="list">${filtered.map(project => renderProject(project, developers)).join('')}</ul>`
      : empty('لا توجد مشاريع مطابقة.', 'No matching projects.');
  }

  function renderProject(project, developers) {
    const due = dueOf(project);
    const pid = safeHtml(project.id);
    const open = selectedProjectId === project.id;
    return `<li class="dm-request" data-dm-project="${pid}">
      <div class="dm-request-row">
        <div class="dm-request-title"><h3 dir="auto">${safeHtml(projectTitle(project))}</h3>
          <small>#<bdi>${safeHtml(projectRef(project))}</bdi></small></div>
        ${cell(t('الاستلام', 'Received'), safeHtml(localizedDate(project.createdAt)))}
        ${cell(t('الحالة', 'Status'), `<span class="dm-tag">${status(stageOf(project))}</span>`)}
        ${cell(t('الأولوية', 'Priority'), safeHtml(t(...(priorities[priorityOf(project)] || priorities.normal))))}
        ${cell(t('المبرمج', 'Developer'), `<bdi>${safeHtml(developerName(project, developers))}</bdi>`)}
        ${cell(t('التسليم', 'Due'), `<span${late(project) ? ' class="dm-overdue"' : ''}>${safeHtml(localizedDate(due))}</span>`)}
        <div class="dm-actions">
          ${button(t('مراجعة', 'Review'), `data-dm-open="review" aria-expanded="${open}"`)}
          ${canAssign(project) ? button(project.developerId ? t('إعادة إسناد', 'Reassign') : t('إسناد', 'Assign'), `data-dm-open="assignment" aria-expanded="${open}"`, true) : ''}
        </div>
      </div>
      ${open ? renderProjectDetails(project, developers) : ''}
    </li>`;
  }

  function canAssign(project) {
    return project.canAssign === true || (project.actionPermissions && project.actionPermissions.assign === true);
  }

  function renderProjectDetails(project, developers) {
    const review = project.review || {};
    return `<div class="dm-project-detail" data-dm-project-detail>
      <p class="dm-feedback dm-project-feedback" data-dm-project-feedback role="status" aria-live="polite"></p>
      <div class="dm-brief">
        <h4>${t('تفاصيل المشروع', 'Project brief')}</h4>
        <dl>${item(t('الخدمة', 'Service'), serviceTitle(project.service))}${item(t('المجال', 'Category'), project.category)}
          ${item(t('آخر تحديث من المبرمج', 'Last developer update'), localizedDate(project.developerUpdatedAt, true))}</dl>
        ${project.details && project.details !== project.technicalRequirements ? `<p dir="auto">${safeHtml(project.details)}</p>` : ''}
        ${project.technicalRequirements ? `<h5>${t('المتطلبات التقنية', 'Technical requirements')}</h5><p dir="auto">${safeHtml(project.technicalRequirements)}</p>` : ''}
        ${project.developerTaskNote ? `<h5>${t('تحديث التنفيذ', 'Implementation update')}</h5><p dir="auto">${safeHtml(project.developerTaskNote)}</p>` : ''}
        ${list(project.files).length ? `<h5>${t('ملفات التسليم', 'Delivery files')}</h5>${renderFiles(project.files, `${pathFor(project.id)}/files`)}` : ''}
        ${list(project.customerFiles).length ? `<h5>${t('ملفات العميل المصرح بها', 'Delegated customer files')}</h5>${renderFiles(project.customerFiles, `${pathFor(project.id)}/customer-files`)}` : ''}
        ${list(review.notes).length ? `<h5>${t('الملاحظات التقنية', 'Technical notes')}</h5><ul class="dm-notes" role="list">${review.notes.map(note => (
          `<li><span>${safeHtml(note.author)} · ${safeHtml(localizedDate(note.at, true))}</span><p dir="auto">${safeHtml(note.text)}</p></li>`
        )).join('')}</ul>` : ''}
      </div>
      <div class="dm-project-forms">
        ${renderReviewForm(project, review)}
        ${canAssign(project) ? renderAssignmentForm(project, developers) : ''}
      </div>
      ${project.canReadConversation ? `<details class="dm-conversations" data-dm-conversation>
        <summary>${t('محادثات المشروع المصرّح بها', 'Delegated project conversations')}</summary>
        <div data-dm-thread-content></div>
      </details>` : ''}
    </div>`;
  }

  function renderReviewForm(project, review) {
    if (project.canReview === false) return '';
    return `<form class="dm-form" data-dm-review>
      <h4>${t('مراجعة تقنية', 'Technical review')}</h4>
      ${textField('category', t('مجال المشروع', 'Project category'), review.category || project.category, 100)}
      <div class="dm-two-fields">
        ${field(t('التعقيد', 'Complexity'), `<select name="complexity"><option value="">—</option>${choices(complexities, review.complexity, t)}</select>`)}
        ${field(t('الأولوية', 'Priority'), `<select name="priority">${choices(priorities, priorityOf(project), t)}</select>`)}
      </div>
      ${textField('skills', t('المهارات المطلوبة، مفصولة بفواصل', 'Required skills, comma-separated'), list(review.skills).join(', '), 300)}
      ${field(t('مدة التنفيذ المتوقعة بالأيام', 'Estimated duration in days'), `<input type="number" name="estimateDays" min="1" max="3650" inputmode="numeric" value="${safeHtml(review.estimateDays)}">`)}
      <label class="dm-check"><input name="inReview" type="checkbox"${review.inReview ? ' checked' : ''}><span>${t('المشروع قيد المراجعة التقنية', 'Keep this project under technical review')}</span></label>
      ${textArea('note', t('ملاحظة تقنية داخلية', 'Internal technical note'), '', 1000)}
      ${project.developerId ? textArea('updateRequest', t('تحديث مطلوب من المبرمج (اختياري)', 'Update requested from the developer (optional)'), '', 1000) : ''}
      ${project.canRequestRevision ? textArea('requestRevision', t('التعديلات المطلوبة على التسليم (اختياري)', 'Delivery revisions requested (optional)'), '', 1000) : ''}
      ${textArea('escalatedIssue', t('مشكلة لرفعها إلى المالك (اختياري)', 'Issue to escalate to the owner (optional)'), '', 1000)}
      <button class="dm-button dm-primary" type="submit">${t('حفظ المراجعة', 'Save review')}</button>
      <p class="dm-feedback" data-dm-project-feedback role="status" aria-live="polite"></p>
    </form>`;
  }

  function renderAssignmentForm(project, developers) {
    const reassign = Boolean(project.developerId);
    const eligible = developers.filter(developer => developer.active && developer.availability !== 'unavailable' && developer.id !== project.developerId);
    return `<form class="dm-form" data-dm-assignment>
      <h4>${reassign ? t('إعادة إسناد المشروع', 'Reassign project') : t('إسناد المشروع لمبرمج', 'Assign a developer')}</h4>
      ${field(t('المبرمج', 'Developer'), `<select name="developerId" required>
        ${filterOptions(eligible.map(developer => [
          developer.id,
          `${developer.name} · ${t(...(availabilityLabels[developer.availability] || availabilityLabels.unspecified))} · ${t('مشاريع جارية', 'In progress')}: ${amount(developer.workload?.active)}${list(developer.specialties).length ? ` · ${developer.specialties.join(', ')}` : ''}`
        ]), '', t('اختر مبرمجًا', 'Choose a developer'))}
      </select>`)}
      ${field(t('موعد التسليم المستهدف', 'Target delivery date'), `<input name="dueAt" type="date" min="${today}" value="${safeHtml(dueOf(project)?.slice(0, 10))}">`)}
      ${textArea('note', t('ملاحظة الإسناد (اختياري)', 'Assignment note (optional)'), '', 500)}
      ${reassign ? textField('reason', t('سبب إعادة الإسناد', 'Reason for reassignment'), '', 500, true) : ''}
      ${eligible.length ? `<button class="dm-button dm-primary" type="submit">${reassign ? t('تأكيد إعادة الإسناد', 'Confirm reassignment') : t('تأكيد الإسناد', 'Confirm assignment')}</button>` : empty('لا يوجد مبرمج آخر مؤهل للإسناد.', 'No other developer is eligible for assignment.')}
      <p class="dm-feedback" data-dm-project-feedback role="status" aria-live="polite"></p>
    </form>`;
  }

  function renderOverview(projects, developers) {
    const open = projects.filter(project => !closedStages.has(stageOf(project)));
    const metrics = [
      [t('طلبات المراجعة التقنية', 'Technical review requests'), open.filter(project => (
        project.review?.inReview || stageOf(project) === 'technical_review' || (project.review?.managerId && !project.review?.reviewedAt)
      )).length],
      [t('بانتظار الإسناد', 'Awaiting assignment'), open.filter(project => !project.developerId && canAssign(project)).length],
      [t('مشاريع نشطة', 'Active projects'), open.filter(project => project.developerId).length],
      [t('مبرمجون متاحون', 'Available developers'), developers.filter(developer => developer.active && developer.availability === 'available').length],
      [t('مشاريع متأخرة', 'Overdue projects'), open.filter(late).length],
      [t('تسليمات للمراجعة', 'Deliveries to review'), open.filter(needsDeliveryReview).length]
    ];
    return `<dl class="dm-metrics">${metrics.map(([label, count]) => item(label, amount(count))).join('')}</dl>
      <section class="dm-recent" aria-labelledby="dm-recent-heading">
        <h3 id="dm-recent-heading">${t('أحدث المشاريع', 'Recent projects')}</h3>
        <div data-dm-results>${resultsMarkup(projects.slice(0, 5), developers)}</div>
      </section>`;
  }

  function renderDevelopers(developers, projects) {
    if (!developers.length) return empty('لا يوجد مبرمجون مسجلون.', 'No developers are registered.');
    return `<ul class="dm-developers" role="list">${developers.map(developer => {
      const workload = developer.workload || {};
      const assigned = projects.filter(project => project.developerId === developer.id);
      const availability = t(...(availabilityLabels[developer.availability] || availabilityLabels.unspecified));
      const joined = values => list(values).join(', ');
      return `<li class="dm-developer"><header><h3 dir="auto">${safeHtml(developer.name)}</h3><span class="dm-tag">${availability}</span></header>
        <p dir="auto">${safeHtml(joined(developer.specialties) || t('التخصص غير مسجل', 'Specialty unspecified'))}</p>
        <dl>${item(t('جارية', 'In progress'), amount(workload.active ?? assigned.filter(project => !closedStages.has(stageOf(project))).length))}
          ${item(t('مكتملة', 'Completed'), amount(workload.completed ?? assigned.filter(project => stageOf(project) === 'completed').length))}
          ${item(t('متأخرة', 'Overdue'), amount(workload.overdue ?? assigned.filter(late).length))}</dl>
        <details><summary>${t('عرض التفاصيل المهنية', 'View professional details')}</summary>
          <dl>${item(t('حالة الحساب الوظيفية', 'Account status'), developer.active ? t('نشط', 'Active') : t('غير نشط', 'Inactive'))}
            ${item(t('تواصل مهني', 'Professional contact'), developer.professionalContact)}
            ${item(t('المهارات التقنية', 'Technical skills'), joined(developer.skills))}
            ${item(t('آخر نشاط مهني', 'Last professional activity'), localizedDate(developer.lastActivityAt, true))}
            ${item(t('ملاحظات مهنية', 'Professional notes'), developer.notes)}</dl>
          ${assigned.length ? `<h4>${t('المشاريع المسندة', 'Assigned projects')}</h4><ul class="dm-developer-projects">${assigned.map(project => (
            `<li><bdi>${safeHtml(projectTitle(project))}</bdi> · ${safeHtml(localizedDate(dueOf(project)))}</li>`
          )).join('')}</ul>` : ''}
        </details></li>`;
    }).join('')}</ul>`;
  }

  function renderActivity(projects) {
    const activity = list(snapshot.activity).length ? snapshot.activity : projects.flatMap(project => (
      [
        ...(project.review?.reviewedAt ? [{kind: 'review', actor: project.review.reviewedBy, at: project.review.reviewedAt}] : []),
        ...list(project.review?.notes).map(note => ({...note, actor: note.author, note: note.text})),
        ...list(project.review?.assignmentHistory).map(entry => ({...entry, kind: entry.fromDeveloperId ? 'reassignment' : 'assignment'}))
      ].map(event => ({...event, projectId: project.id}))
    ));
    if (!activity.length) return empty('لا توجد عمليات تقنية مسجلة.', 'No technical activity has been recorded.');
    return `<ol class="dm-activity">${activity.slice().sort((a, b) => String(b.at || b.createdAt).localeCompare(String(a.at || a.createdAt))).map(event => (
      `<li><div><strong>${t(...(activityLabels[event.kind || event.action] || ['تحديث المشروع', 'Project update']))}</strong>
      <span>${safeHtml(localizedDate(event.at || event.createdAt, true))}</span></div>
      <p dir="auto">${safeHtml(event.actorName || event.actor)} · <bdi>${safeHtml(event.projectId)}</bdi></p>
      ${event.developerName ? `<p dir="auto">${event.fromDeveloperName ? `${safeHtml(event.fromDeveloperName)} → ` : ''}${safeHtml(event.developerName)}</p>` : ''}
      ${event.reason || event.note ? `<p dir="auto">${safeHtml(event.reason || event.note)}</p>` : ''}</li>`
    )).join('')}</ol>`;
  }

  function renderFiles(files, path) {
    return `<ul class="dm-file-list" role="list">${list(files).map(file => (
      `<li><a href="${path}/${encodeURIComponent(file.index)}" class="dm-button" target="_blank" rel="noopener noreferrer" dir="auto">${safeHtml(file.name || t('فتح الملف', 'Open file'))}</a></li>`
    )).join('')}</ul>`;
  }

  async function loadConversation(section) {
    const mount = section.querySelector('[data-dm-thread-content]');
    const projectId = section.closest('[data-dm-project]').dataset.dmProject;
    const root = `${pathFor(projectId)}/conversation`;
    mount.innerHTML = `<p role="status">${t('جارٍ تحميل المحادثة…', 'Loading the conversation…')}</p>`;
    try {
      const {conversations} = await jsonRequest(root);
      if (!isCurrent() || !section.isConnected) return;
      const threads = list(conversations);
      mount.innerHTML = threads.length ? threads.map(thread => `<article class="dm-thread">
        <h5>${t('محادثة', 'Conversation')} <bdi>${safeHtml(thread.id)}</bdi></h5>
        <ol class="dm-messages" tabindex="0" aria-label="${t('رسائل المحادثة', 'Conversation messages')}">${list(thread.messages).map(message => (
          `<li><small>${message.senderType === 'customer' || message.senderType === 'client' ? t('العميل', 'Customer') : t('فريق ZEZO', 'ZEZO team')} · ${safeHtml(localizedDate(message.createdAt, true))}</small>
          <p dir="auto">${safeHtml(message.text)}</p>
          ${list(message.attachments).length ? renderFiles(message.attachments, `${root}/${encodeURIComponent(thread.id)}/files`) : ''}</li>`
        )).join('')}</ol>
        ${thread.status !== 'closed' ? `<form class="dm-form" data-dm-conversation-reply="${safeHtml(thread.id)}">
          ${field(t('رد في المحادثة', 'Reply to the conversation'), '<textarea name="message" maxlength="4000" required dir="auto"></textarea>')}
          <button class="dm-button dm-primary" type="submit">${t('إرسال الرد', 'Send reply')}</button>
          <p class="dm-feedback" data-dm-thread-feedback role="status" aria-live="polite"></p>
        </form>` : ''}</article>`).join('') : empty('لا توجد محادثات ضمن هذا المشروع.', 'There are no conversations for this project.');
    } catch (error) {
      if (isCurrent() && section.isConnected) mount.innerHTML = `<p class="dm-error" role="status">${safeHtml(errorText(error))}</p>`;
    }
  }

  async function reply(form) {
    const threadFeedback = form.querySelector('[data-dm-thread-feedback]');
    const submitButton = form.querySelector('button[type="submit"]');
    const section = form.closest('[data-dm-conversation]');
    if (submitButton.disabled || section.dataset.dmThreadSending) return;
    const message = form.elements.message.value.trim();
    if (!message) {
      threadFeedback.textContent = t('اكتب نص الرد أولًا.', 'Enter a reply first.');
      form.elements.message.focus();
      return;
    }
    submitButton.disabled = true;
    section.dataset.dmThreadSending = 'true';
    submitButton.setAttribute('aria-busy', 'true');
    threadFeedback.classList.remove('dm-error');
    threadFeedback.textContent = t('جارٍ إرسال الرد…', 'Sending the reply…');
    try {
      const projectId = section.closest('[data-dm-project]').dataset.dmProject;
      await jsonRequest(`${pathFor(projectId)}/conversation`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({conversationId: form.dataset.dmConversationReply, message})
      });
      if (isCurrent() && form.isConnected) await loadConversation(section);
    } catch (error) {
      if (isCurrent() && form.isConnected) {
        threadFeedback.classList.add('dm-error');
        threadFeedback.textContent = errorText(error);
      }
    } finally {
      delete section.dataset.dmThreadSending;
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
    }
  }

  function feedback(message, error = false, parent = container) {
    const target = parent.querySelector(parent === container ? '[data-dm-feedback]' : '[data-dm-project-feedback]');
    if (target) {
      target.classList.toggle('dm-error', error);
      target.textContent = message;
    }
  }

  function render() {
    const projects = applicableProjects();
    const developers = list(snapshot.developers);
    if (owner) container.innerHTML = shell(renderOwnerControls(projects, developers));
    else if (tab === 'technical-developers') container.innerHTML = shell(renderDevelopers(developers, projects));
    else if (tab === 'technical-activity') container.innerHTML = shell(renderActivity(projects));
    else if (tab === 'technical-overview') container.innerHTML = shell(renderOverview(projects, developers));
    else {
      container.innerHTML = shell(renderFilters(projects, developers));
      renderResults();
    }
  }

  function renderOwnerControls(projects, developers) {
    const project = projects.find(item => item.id === selectedProjectId);
    const managers = list(snapshot.managers);
    const managerOptions = managers.filter(manager => manager.active || manager.id === project?.review?.managerId);
    const delegation = project ? `<form class="dm-form" data-dm-delegation>
      ${field(t('مسؤول المبرمجين', 'Development Manager'), `<select name="managerId">${filterOptions(managerOptions.map(manager => [manager.id, manager.name]), project.review?.managerId, t('بلا تفويض خاص', 'No explicit delegation'))}</select>`)}
      ${textArea('technicalRequirements', t('المتطلبات التقنية المسموح بعرضها', 'Technical requirements approved for sharing'), project.technicalRequirements, 6000)}
      <label class="dm-check"><input name="allowCustomerConversation" type="checkbox"${project.review?.allowCustomerConversation ? ' checked' : ''}><span>${t('السماح لهذا المسؤول بالوصول إلى محادثة العميل وملفاتها', 'Allow this manager to access the customer conversation and its files')}</span></label>
      <button class="dm-button dm-primary" type="submit">${t('حفظ التفويض', 'Save delegation')}</button>
    </form>` : '';
    return `<div class="dm-owner-grid">
      <section class="dm-owner-section">
        <h3>${t('تفويض مشروع', 'Delegate a project')}</h3>
        ${field(t('المشروع', 'Project'), `<select data-dm-owner-project>${filterOptions(projects.map(item => [item.id, `${projectTitle(item)} · ${projectRef(item)}`]), selectedProjectId, t('اختر مشروعًا', 'Choose a project'))}</select>`)}
        ${delegation}
      </section>
      <section class="dm-owner-section">
        <h3>${t('ملفات المبرمجين المهنية', 'Developer profiles')}</h3>
        ${developers.length ? developers.map(developer => `<details class="dm-profile-card"${developer.id === openDeveloperId ? ' open' : ''}>
          <summary dir="auto">${safeHtml(developer.name)}</summary>
          <form class="dm-form" data-dm-developer-profile="${safeHtml(developer.id)}">
            ${textField('specialties', t('التخصصات، مفصولة بفواصل', 'Specialties, comma-separated'), list(developer.specialties).join(', '), 300)}
            ${textField('skills', t('المهارات، مفصولة بفواصل', 'Skills, comma-separated'), list(developer.skills).join(', '), 300)}
            ${field(t('التوفر للعمل', 'Availability'), `<select name="availability"><option value="">${t(...availabilityLabels.unspecified)}</option>${choices(Object.fromEntries(Object.entries(availabilityLabels).filter(([key]) => key !== 'unspecified')), developer.availability, t)}</select>`)}
            ${textField('professionalContact', t('وسيلة التواصل المهنية المعتمدة', 'Approved professional contact'), developer.professionalContact, 200)}
            ${textArea('notes', t('ملاحظات مهنية', 'Professional notes'), developer.notes, 1000)}
            <button class="dm-button dm-primary" type="submit">${t('حفظ الملف المهني', 'Save professional profile')}</button>
          </form>
        </details>`).join('') : empty('لا يوجد مبرمجون مسجلون.', 'No developers are registered.')}
      </section>
    </div>`;
  }

  async function submitOwner(form) {
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton.disabled || container.querySelector('[data-dm-owner-saving]')) return;
    const profile = form.dataset.dmDeveloperProfile;
    const project = list(snapshot.projects).find(item => item.id === selectedProjectId);
    if (!profile && !project) return;
    const values = Object.fromEntries(new FormData(form));
    const payload = profile ? {
      ...values,
      specialties: values.specialties.split(/[,،]/).map(value => value.trim()).filter(Boolean),
      skills: values.skills.split(/[,،]/).map(value => value.trim()).filter(Boolean)
    } : {
      version: project.version,
      managerId: values.managerId || null,
      technicalRequirements: values.technicalRequirements,
      allowCustomerConversation: Boolean(values.managerId && form.elements.allowCustomerConversation.checked)
    };
    form.dataset.dmOwnerSaving = 'true';
    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    feedback(t('جارٍ الحفظ…', 'Saving…'));
    try {
      await jsonRequest(profile ? `${apiRoot}/developers/${encodeURIComponent(profile)}/profile` : `${pathFor(project.id)}/delegation`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      if (!isCurrent()) return;
      openDeveloperId = profile || '';
      await load();
      if (isCurrent() && !container.querySelector('[data-dm-feedback]')?.classList.contains('dm-error')) {
        feedback(profile ? t('تم حفظ الملف المهني.', 'Professional profile saved.') : t('تم حفظ التفويض.', 'Delegation saved.'));
      }
    } catch (error) {
      if (isCurrent() && form.isConnected) feedback(errorText(error), true);
    } finally {
      delete form.dataset.dmOwnerSaving;
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
    }
  }

  function renderResults() {
    const projects = applicableProjects();
    container.querySelector('[data-dm-results]').innerHTML = resultsMarkup(
      tab === 'technical-overview' ? projects.slice(0, 5) : projects,
      list(snapshot.developers)
    );
  }

  async function load() {
    container.setAttribute('aria-busy', 'true');
    try {
      snapshot = await jsonRequest(apiRoot);
      if (isCurrent()) render();
    } catch (error) {
      if (isCurrent()) {
        if (error.status === 401 || error.status === 403) {
          snapshot = undefined;
          selectedProjectId = '';
          container.innerHTML = shell('');
        }
        feedback(errorText(error), true);
      }
    } finally {
      if (isCurrent()) container.setAttribute('aria-busy', 'false');
    }
  }

  async function submit(form) {
    const row = form.closest('[data-dm-project]');
    const project = list(snapshot.projects).find(item => item.id === row.dataset.dmProject);
    if (!project || row.dataset.dmSaving) return;
    row.dataset.dmSaving = 'true';
    const assignment = form.hasAttribute('data-dm-assignment');
    const controls = [...row.querySelectorAll('button[type="submit"]')];
    const submitButton = form.querySelector('button[type="submit"]');
    for (const control of controls) control.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    feedback(t('جارٍ الحفظ…', 'Saving…'), false, form);
    const values = Object.fromEntries(new FormData(form));
    const payload = {...values, version: project.version};
    if (assignment) {
      payload.dueAt ||= null;
    } else {
      payload.skills = values.skills.split(/[,،]/).map(value => value.trim()).filter(Boolean);
      payload.estimateDays = values.estimateDays ? Number(values.estimateDays) : null;
      payload.inReview = form.elements.inReview.checked;
    }
    try {
      await jsonRequest(`${pathFor(project.id)}/${assignment ? 'assignment' : 'review'}`, {
        method: assignment ? 'POST' : 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      if (!isCurrent()) return;
      selectedProjectId = project.id;
      await load();
      if (isCurrent() && container.querySelector('[data-dm-feedback]')?.classList.contains('dm-error')) return;
      if (isCurrent()) {
        const refreshed = container.querySelector(`[data-dm-project="${CSS.escape(project.id)}"]`);
        feedback(
          assignment ? t('تم حفظ الإسناد.', 'Assignment saved.') : t('تم حفظ المراجعة.', 'Review saved.'),
          false,
          refreshed || container
        );
        refreshed?.querySelector('[data-dm-open="review"]')?.focus({preventScroll: true});
      }
    } catch (error) {
      if (isCurrent()) feedback(errorText(error), true, form);
    } finally {
      delete row.dataset.dmSaving;
      for (const control of controls) control.disabled = false;
      submitButton.removeAttribute('aria-busy');
    }
  }

  container.addEventListener('click', event => {
    if (event.target.closest('[data-dm-reload]')) {
      if (container.getAttribute('aria-busy') !== 'true' && !container.querySelector('[data-dm-owner-saving], [data-dm-saving], [data-dm-thread-sending]')) {
        feedback(t('جارٍ التحديث…', 'Refreshing…'));
        void load();
      }
      return;
    }
    const action = event.target.closest('[data-dm-open]');
    if (!action || !snapshot) return;
    const row = action.closest('[data-dm-project]');
    if (container.querySelector('[data-dm-saving], [data-dm-thread-sending]')) return;
    const project = list(snapshot.projects).find(item => item.id === row.dataset.dmProject);
    if (!project) return;
    const alreadyOpen = selectedProjectId === project.id;
    if (!alreadyOpen) {
      const current = container.querySelector('[data-dm-project-detail]');
      current?.closest('[data-dm-project]').querySelectorAll('[data-dm-open]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      current?.remove();
      selectedProjectId = project.id;
      row.insertAdjacentHTML('beforeend', renderProjectDetails(project, list(snapshot.developers)));
      row.querySelectorAll('[data-dm-open]').forEach(button => button.setAttribute('aria-expanded', 'true'));
    } else if (action.dataset.dmOpen === 'review') {
      row.querySelector('[data-dm-project-detail]')?.remove();
      row.querySelectorAll('[data-dm-open]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      selectedProjectId = '';
      return;
    }
    row.querySelector(action.dataset.dmOpen === 'assignment' ? '[data-dm-assignment] select' : '[data-dm-review] input')?.focus();
  });
  container.addEventListener('input', event => {
    if (!event.target.closest('[data-dm-filters]')) return;
    filters[event.target.name] = event.target.value;
    if (!container.querySelector('[data-dm-saving], [data-dm-thread-sending]')) renderResults();
  });
  container.addEventListener('change', event => {
    if (!event.target.matches('[data-dm-owner-project]')) return;
    if (container.querySelector('[data-dm-owner-saving]')) {
      event.target.value = selectedProjectId || '';
      return;
    }
    selectedProjectId = event.target.value;
    render();
    container.querySelector('[data-dm-owner-project]')?.focus();
  });
  container.addEventListener('toggle', event => {
    const section = event.target;
    if (section.matches('[data-dm-conversation]') && section.open && !section.dataset.dmThreadSending) void loadConversation(section);
  }, true);
  container.addEventListener('submit', event => {
    if (event.target.matches('[data-dm-filters]')) {
      event.preventDefault();
    } else if (event.target.matches('[data-dm-review], [data-dm-assignment]')) {
      event.preventDefault();
      void submit(event.target);
    } else if (event.target.matches('[data-dm-conversation-reply]')) {
      event.preventDefault();
      void reply(event.target);
    } else if (event.target.matches('[data-dm-delegation], [data-dm-developer-profile]')) {
      event.preventDefault();
      void submitOwner(event.target);
    }
  });
  container.innerHTML = shell('');
  feedback(t('جارٍ تحميل مساحة العمل…', 'Loading the workspace…'));
  return load().then(() => {
    if (!targetId || !isCurrent()) return;
    const target = container.querySelector(`[data-dm-project="${CSS.escape(targetId)}"]`);
    target?.querySelector('[data-dm-open="review"]')?.focus();
  });
}
