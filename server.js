import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { extname, join, normalize, basename, isAbsolute, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { templateCatalog, templateById } from './public/template-catalog.js';
import { buildWhatsAppUrl, normalizeWhatsAppNumber } from './public/whatsapp.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STAGING_MODE = process.env.ZEZO_STAGING === 'true';
const STAGING_ACCESS_PASSWORD = STAGING_MODE ? String(process.env.ZEZO_STAGING_ACCESS_PASSWORD || '') : '';
if (STAGING_MODE && STAGING_ACCESS_PASSWORD.length < 16) throw new Error('ZEZO staging requires a temporary access password of at least 16 characters.');
const STAGING_ACCESS_PASSWORD_HASH = STAGING_MODE ? createHash('sha256').update(STAGING_ACCESS_PASSWORD).digest() : null;
if (!STAGING_MODE) try {
  const envText = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const DATA_DIR = process.env.ZEZO_DATA_DIR ? (isAbsolute(process.env.ZEZO_DATA_DIR) ? normalize(process.env.ZEZO_DATA_DIR) : normalize(join(ROOT, process.env.ZEZO_DATA_DIR))) : join(ROOT, 'data');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const DB_FILE = join(DATA_DIR, 'zezo-data.json');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY = 6 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const roles = ['admin', 'marketing_manager', 'hr_manager', 'order_manager', 'developer', 'marketer'];
const allRoles = [...roles, 'client'];
const employeeRoles = ['marketer', 'developer'];
const inviteableEmployeeRoles = ['marketer', 'developer', 'order_manager'];
const managementRoles = ['admin', 'marketing_manager', 'hr_manager', 'order_manager'];
const accountTypes = { employee:employeeRoles, management:managementRoles, client:['client'] };
const permissionDefinitions = {
  'conversations.read': ['assigned','department','all'],
  'conversations.reply': ['assigned','department','all'],
  'conversations.update': ['assigned','department','all'],
  'conversations.assign': ['department','all'],
  'quotes.draft': ['assigned','department','all'],
  'orders.manage': ['assigned','department','all'],
  'orders.convert': ['assigned','department','all'],
  'projects.assign': ['department','all'],
  'employees.read': ['own','department','all'],
  'withdrawals.review': ['department','all'],
  'team.invite': ['department','all']
};
const defaultRolePermissions = {
  order_manager: {'conversations.read':'assigned','conversations.reply':'assigned','conversations.update':'assigned','quotes.draft':'assigned','orders.manage':'assigned','orders.convert':'assigned'},
  hr_manager: {'employees.read':'department','withdrawals.review':'department','team.invite':'department'},
  marketing_manager: {'conversations.read':'all','conversations.reply':'all','conversations.update':'all','quotes.draft':'all','orders.manage':'all','employees.read':'all'}
};
const defaultTemplateInclusion = { ar:'يشمل تهيئة الاسم التجاري والشعار والألوان، واستبدال النصوص والصور ضمن الصفحات والوظائف الموجودة في النموذج. الصفحات أو الوظائف الإضافية تُسعّر بعد مراجعة النطاق وموافقة العميل.', en:'Includes adapting the business name, logo, and colors, and replacing copy and images within the template’s existing pages and functions. Extra pages or features are quoted after scope review and customer approval.' };
const statuses = ['new','review','proposal','waiting_customer_approval','waiting_payment','active','technical_review','ready_delivery','completed','cancelled'];
const projectStages = ['new_request','under_review','quote_sent','waiting_customer_approval','waiting_payment_to_start','waiting_developer_acceptance','in_progress','technical_review','needs_revisions','ready_delivery','waiting_client_review','delivered','completed','cancelled'];
const projectStageFromOrderStatus = {new:'new_request',review:'under_review',proposal:'quote_sent',waiting_customer_approval:'waiting_customer_approval',waiting_payment:'waiting_payment_to_start',active:'in_progress',technical_review:'technical_review',ready_delivery:'ready_delivery',completed:'completed',cancelled:'cancelled'};
const commissionStatusNames = ['pending','confirmed','paid','reversed','none','pending_setup'];
const marketerRankOrder = ['rookie','pro','elite','team_leader'];
const marketerRankTitles = { rookie:'Rookie', pro:'Pro', elite:'Elite', team_leader:'Team Leader' };
const marketerRankThresholds = { rookie:0, pro:10, elite:20, team_leader:80 };
const marketerRankRates = { rookie:15, pro:20, elite:35 };
const developerCommissionRate = 25;
const duplicateRequestWindowMs = 48 * 60 * 60 * 1000;
const REFERRAL_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFERRAL_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TRACKING_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const serviceCategories = { web:['site','store','care','audit','maintenance'], apps:['mobile','webapp','prototype'], ai:['assistant','automation','integration'], ideas:['discovery','consulting','prototype-plan','startup'] };
const initialPrices = [
  { id: 'landing-basic', ar: 'صفحة هبوط أساسية — قالب جاهز', en: 'Basic landing page — starter template', price: 150, detailsAr: 'حتى 3 أقسام، مناسبة للجوال، مع زر تواصل. العميل يزوّدنا بالنصوص والصور. تعديل واحد. لا تشمل النطاق أو الاستضافة.', detailsEn: 'Up to 3 sections, mobile-friendly, with a contact button. Client supplies copy and images. One revision. Domain and hosting excluded.' },
  { id: 'landing-custom', ar: 'صفحة هبوط مخصصة', en: 'Custom landing page', price: 300, detailsAr: 'تصميم مخصص حتى 5 أقسام، مناسبة للجوال، مع زر تواصل أو نموذج طلب. العميل يزوّدنا بالنصوص والصور. تعديل واحد. لا تشمل النطاق أو الاستضافة.', detailsEn: 'Custom design up to 5 sections, mobile-friendly, with a contact button or enquiry form. Client supplies copy and images. One revision. Domain and hosting excluded.' },
  { id: 'web-care', ar: 'مراجعة وتحسين صفحة ويب واحدة', en: 'Review and polish one web page', price: 250 },
  { id: 'app-session', ar: 'جلسة تصور لميزة تطبيق', en: 'App feature planning session', price: 200 },
  { id: 'ai-audit', ar: 'مراجعة فكرة أتمتة بسيطة', en: 'Simple automation idea review', price: 150 },
  { id: 'idea-map', ar: 'جلسة ترتيب فكرة مشروع', en: 'Project idea mapping session', price: 100 }
];
const defaultStore = () => ({
  users: [], leads: [], crmLeads: [], conversations: [], audit: [], notifications: [], payments: [], withdrawals: [], financeLedger: [], expenses: [], mailQueue: [], referralVisits: [], referralLinks: [], referralEvents: [], referralAttributions: [], rankRequests: [], campaigns: [],
  settings: { commissionPercent: 15, commissionTier: null, commissionHoldDays: 14, prices: initialPrices.map(item=>({...item,active:true,pricingMode:'fixed'})), templatePricingVersion:1, templatePrices: Object.fromEntries(templateCatalog.map(template => [template.id, 200])), templateInclusions:Object.fromEntries(templateCatalog.map(template=>[template.id,{...defaultTemplateInclusion}])), templateActive:Object.fromEntries(templateCatalog.map(template=>[template.id,true])), withdrawalMinimum:100, withdrawalWindowStart:1, withdrawalWindowEnd:31, marginWarningPercent:10 },
});
let store;
let persistQueue = Promise.resolve();
const sessions = new Map();
const stagingSessions = new Map();
const stagingLoginAttempts = new Map();
const loginAttempts = new Map();
const leadAttempts = new Map();
const quoteAttempts = new Map();
const clientRegistrationAttempts = new Map();
const passwordResetAttempts = new Map();
const conversationAttempts = new Map();

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const id = prefix => `${prefix}_${randomBytes(9).toString('hex')}`;
const clean = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function invitationStatus(user){
  if(user?.active)return user.inviteStatus==='accepted'?'accepted':'active';
  if(user?.inviteApprovalStatus==='pending_approval')return 'pending_approval';
  if(user?.inviteStatus==='revoked')return 'revoked';
  if(user?.inviteStatus==='accepted')return 'accepted';
  if(user?.inviteStatus==='pending'||user?.activationHash)return Number(user.inviteExpiresAt?Date.parse(user.inviteExpiresAt):user.activationExpires)>Date.now()?'pending':'expired';
  return user?.inviteStatus||'';
}
function setProjectStage(lead, stage, actor, note='', clientNote='') {
  if(!projectStages.includes(stage))throw Object.assign(new Error('مرحلة مشروع غير صالحة / Invalid project stage'),{status:400});
  if(lead.projectStage===stage&&!note&&!clientNote)return false;
  const at=now();lead.projectStage=stage;lead.projectHistory??=[];
  lead.projectHistory.push({stage,at,by:actor?.username||'system',note:clean(note,500),clientNote:clean(clientNote,500)});
  if(stage==='in_progress'&&!lead.projectStartedAt)lead.projectStartedAt=at;
  if(stage==='delivered'&&!lead.projectDeliveredAt)lead.projectDeliveredAt=at;
  if(stage==='completed')lead.projectCompletedAt=at;
  if(stage==='cancelled')lead.projectCancelledAt=at;
  return true;
}
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, email: u.email || '', phone: u.phone || '', instagram:u.instagram||'', socialLinks:u.socialLinks||'', telegramUsername:u.telegramUsername||'', role: u.role, active: u.active, accountDisabled:Boolean(u.accountDisabledAt), accountProvisioned:Boolean(u.passwordHash), mustChangePassword:Boolean(u.mustChangePassword), mfaEnabled:Boolean(u.mfaEnabledAt), referralCode: referralEnabled(u) ? (u.currentReferralCode||u.referralCode) : undefined, inviteApprovalStatus:u.inviteApprovalStatus||'', inviteStatus:invitationStatus(u), inviteExpiresAt:u.inviteExpiresAt||null, createdAt: u.createdAt });
function canSetUpFirstAdmin() { return process.env.ZEZO_DISABLE_ADMIN_SETUP !== 'true' && (STAGING_MODE || process.env.NODE_ENV !== 'production'); }
function firstAdminSetupAvailable() { return canSetUpFirstAdmin() && !store.users.some(u=>u.role==='admin'&&u.active); }
const money = n => Math.round(Number(n) * 100) / 100;
const cents = n => Math.round((Number(n)||0) * 100);
const fromCents = n => Number((Number(n||0)/100).toFixed(2));
const referralEnabled = user => ['marketer','developer'].includes(user?.role);
const referralMonth = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
const findReferralLinkByCode = code => {
  const link = store.referralLinks.find(row => row.code === code);
  const user = link ? store.users.find(row => row.id === link.userId && referralEnabled(row) && row.active) : store.users.find(row => referralEnabled(row) && row.active && row.referralCode === code);
  return user ? { user, link:link || null } : null;
};
const findUserByCode = code => findReferralLinkByCode(code)?.user;
function newReferralCode() {
  let code;
  do { code = `Z${randomBytes(16).toString('hex').toUpperCase()}`; }
  while (store.referralLinks.some(row=>row.code===code) || store.users.some(user=>user.referralCode===code));
  return code;
}
function ensureMonthlyReferralLinks() {
  let changed = false;
  const month = referralMonth();
  for (const user of store.users.filter(row=>referralEnabled(row)&&row.active)) {
    user.referralCode ||= newReferralCode();
    if (!store.referralLinks.some(row=>row.userId===user.id&&row.code===user.referralCode)) {
      store.referralLinks.push({id:id('rfl'),userId:user.id,code:user.referralCode,month:'legacy',kind:'legacy',createdAt:user.createdAt||now()}); changed=true;
    }
    let current = store.referralLinks.find(row=>row.userId===user.id&&row.month===month&&row.kind==='monthly');
    if (!current) {
      current = {id:id('rfl'),userId:user.id,code:newReferralCode(),month,kind:'monthly',createdAt:now()};
      store.referralLinks.push(current); changed=true;
    }
    if (user.currentReferralCode!==current.code || user.currentReferralLinkId!==current.id) {
      user.currentReferralCode=current.code; user.currentReferralLinkId=current.id; changed=true;
    }
  }
  return changed;
}
function referralLinkForCode(code) {
  const resolved=findReferralLinkByCode(code);
  if (!resolved) return null;
  return { ...resolved, link:resolved.link || {id:`legacy_${resolved.user.id}`,userId:resolved.user.id,code,month:'legacy',kind:'legacy'} };
}
function cleanReferralEvents() {
  const cutoff=Date.now()-REFERRAL_EVENT_RETENTION_MS;
  const shortLived=new Set(['visit','service_view','template_view','whatsapp_click']);
  store.referralEvents=store.referralEvents.filter(event=>!shortLived.has(event.type)||new Date(event.createdAt).getTime()>=cutoff);
}
function cleanReferralAttributions(){
  const current=Date.now();
  store.referralAttributions=store.referralAttributions.filter(row=>Number(row.expiresAt)>current).slice(-200000);
}
function rememberReferralAttribution({visitorHash,userId,code,linkId}){
  if(!visitorHash||!userId||!code)return;
  cleanReferralAttributions();
  const existing=store.referralAttributions.find(row=>row.visitorHash===visitorHash&&Number(row.expiresAt)>Date.now());
  if(existing){existing.lastSeenAt=now();return existing;}
  const row={visitorHash,userId,code,linkId:linkId||null,firstSeenAt:now(),lastSeenAt:now(),expiresAt:Date.now()+REFERRAL_TTL_SECONDS*1000};
  store.referralAttributions.push(row);return row;
}
function referralAttributionForVisitor(visitorId){
  if(!visitorId||!/^[\-_a-zA-Z0-9]{12,80}$/.test(visitorId))return null;
  cleanReferralAttributions();
  return store.referralAttributions.find(row=>row.visitorHash===hash(visitorId)&&Number(row.expiresAt)>Date.now())||null;
}
function recordReferralEvent({userId,code,linkId=null,type,visitorHash=null,resourceId='',leadId='',followupId='',idempotencyKey='',createdAt=''}) {
  if(!userId||!type)return null;
  cleanReferralEvents();
  const uniqueKey=idempotencyKey||'';
  if(uniqueKey){const existing=store.referralEvents.find(event=>event.idempotencyKey===uniqueKey);if(existing)return existing;}
  const event={id:id('rfe'),userId,code:code||'',linkId:linkId||null,month:(store.referralLinks.find(row=>row.id===linkId)?.month)||'legacy',type,createdAt:createdAt&&Number.isFinite(Date.parse(createdAt))?new Date(createdAt).toISOString():now(),visitorHash:visitorHash||null,resourceId:clean(resourceId,100),leadId:clean(leadId,80),followupId:clean(followupId,60),idempotencyKey:uniqueKey||null,reversedAt:''};
  if(type==='visit'&&visitorHash){const day=event.createdAt.slice(0,10);const existing=store.referralEvents.find(row=>row.userId===userId&&row.type==='visit'&&row.visitorHash===visitorHash&&row.createdAt.slice(0,10)===day&&row.linkId===event.linkId);if(existing)return existing;}
  if(['service_view','template_view'].includes(type)&&visitorHash){const existing=store.referralEvents.find(row=>row.userId===userId&&row.type===type&&row.resourceId===event.resourceId&&row.visitorHash===visitorHash&&row.linkId===event.linkId);if(existing)return existing;}
  store.referralEvents.unshift(event);
  return event;
}
function recordLeadMilestone(lead,type,actor=null) {
  if(!lead.referralUserId||!lead.referralCode)return null;
  const resolved=referralLinkForCode(lead.referralCode);
  const event=recordReferralEvent({userId:lead.referralUserId,code:lead.referralCode,linkId:lead.referralLinkId||resolved?.link?.id||null,type,leadId:lead.id,idempotencyKey:`${type}:${lead.id}`});
  if(type==='qualified_sale')notifyUser(lead.referralUserId,`milestone:${type}:${lead.id}`,{type:'sale',importance:'high',titleAr:'اكتملت مبيعة مؤهلة من إحالتك',titleEn:'A qualified referral sale completed',descriptionAr:'سُجل الطلب كمكتمل ومدفوع بالكامل وفق شروط التأهل.',descriptionEn:'The request was recorded as complete and fully paid under the qualification rules.'},{tab:'referral',targetId:lead.id,targetKind:'lead'});
  return event;
}
function syncLeadReferralMilestones(lead,actor=null) {
  if(!lead.referralUserId||!lead.referralCode)return;
  const complete=lead.status==='completed'&&!lead.isDuplicate&&lead.status!=='cancelled';
  let completion=store.referralEvents.find(event=>event.idempotencyKey===`project_completed:${lead.id}`);
  if(complete&&!completion)completion=recordLeadMilestone(lead,'project_completed',actor);
  if(completion)completion.reversedAt=complete?'':(completion.reversedAt||now());
  const qualified=complete&&Number(lead.contractAmount)>0&&Number(lead.paidTotal)>=Number(lead.contractAmount)&&Boolean(lead.everFullyPaid||lead.fullyPaidAt)&&!lead.refunded;
  let sale=store.referralEvents.find(event=>event.idempotencyKey===`qualified_sale:${lead.id}`);
  if(qualified&&!sale)sale=recordLeadMilestone(lead,'qualified_sale',actor);
  if(sale)sale.reversedAt=qualified?'':(sale.reversedAt||now());
}
function referralIntelligenceFor(user=null) {
  const isOwner=user?.role==='admin';
  const canViewTeam=!user||['admin','hr_manager','marketing_manager'].includes(user.role);
  const visibleUsers=store.users.filter(row=>referralEnabled(row)&&(canViewTeam||row.id===user.id));
  const allowedIds=new Set(visibleUsers.map(row=>row.id));
  const events=store.referralEvents.filter(event=>allowedIds.has(event.userId)).map(event=>({id:event.id,userId:event.userId,employeeName:visibleUsers.find(row=>row.id===event.userId)?.name||'',code:event.code,linkId:event.linkId,month:event.month,type:event.type,createdAt:event.createdAt,resourceId:event.resourceId,leadId:event.leadId,followupId:event.followupId,reversed:Boolean(event.reversedAt)}));
  const links=store.referralLinks.filter(link=>allowedIds.has(link.userId)).map(link=>({id:link.id,userId:link.userId,employeeName:visibleUsers.find(row=>row.id===link.userId)?.name||'',code:link.code,month:link.month,kind:link.kind,createdAt:link.createdAt,current:visibleUsers.find(row=>row.id===link.userId)?.currentReferralLinkId===link.id}));
  const orders=store.leads.filter(lead=>lead.referralUserId&&allowedIds.has(lead.referralUserId)).map(lead=>({id:lead.id,userId:lead.referralUserId,code:lead.referralCode||'',linkId:lead.referralLinkId||null,createdAt:lead.createdAt,service:lead.service,category:lead.category,status:lead.status,isDuplicate:Boolean(lead.isDuplicate),qualified:Boolean(lead.status==='completed'&&!lead.isDuplicate&&!lead.refunded&&Number(lead.contractAmount)>0&&Number(lead.paidTotal)>=Number(lead.contractAmount)&&Boolean(lead.everFullyPaid||lead.fullyPaidAt)),paid:isOwner?Number(lead.paidTotal||0):undefined,amount:isOwner?Number(lead.contractAmount||0):undefined}));
  return {retentionDays:90,events,links,orders,employees:visibleUsers.map(row=>({id:row.id,name:row.name,role:row.role,rank:row.rank||'rookie',commissionRate:currentRankRate(row),currentReferralCode:row.currentReferralCode||row.referralCode||''}))};
}
function referralIntelligenceForViewer(user){
  const data=referralIntelligenceFor(user);if(!['hr_manager','marketing_manager'].includes(user?.role))return data;
  const allowedIds=new Set(store.users.filter(row=>referralEnabled(row)&&hasPermission(user,'employees.read',{ownerId:row.id,department:row.department||roleDepartment(row.role)})).map(row=>row.id));
  return {...data,employees:data.employees.filter(row=>allowedIds.has(row.id)),links:data.links.filter(row=>allowedIds.has(row.userId)),orders:data.orders.filter(row=>allowedIds.has(row.userId)),events:data.events.filter(row=>allowedIds.has(row.userId))};
}
function referralMetricsFor(userId) {
  const events=store.referralEvents.filter(event=>event.userId===userId&&!event.reversedAt);
  const orders=store.leads.filter(lead=>lead.referralUserId===userId&&!lead.isDuplicate&&!lead.duplicateOfLeadId);
  const currentCode=store.users.find(row=>row.id===userId)?.currentReferralCode;
  const types=type=>events.filter(event=>event.type===type).length;
  return {visits:new Set(events.filter(event=>event.type==='visit').map(event=>event.visitorHash).filter(Boolean)).size,serviceViews:types('service_view'),templateViews:types('template_view'),whatsappClicks:types('whatsapp_click'),inquiries:types('inquiry_confirmed'),requests:orders.length,quoteAcceptances:types('quote_accepted'),sales:new Set(events.filter(event=>event.type==='qualified_sale'&&event.leadId).map(event=>event.leadId)).size,currentCode};
}

async function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  persistQueue = persistQueue.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await writeFile(tmp, snapshot, { mode: 0o600 });
    for(let attempt=0;;attempt++){
      try { await rename(tmp, DB_FILE); break; }
      catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4) throw error;
        await new Promise(resolve=>setTimeout(resolve,40*(attempt+1)));
      }
    }
  });
  await persistQueue;
}
async function init() {
  let migratedSetupFields = false;
  let migratedTemplateAvailability = false;
  let migratedTemplatePricing = false;
  let migratedPermissionData = false;
  let migratedWithdrawals = false;
  let migratedClientData = false;
  let migratedNotifications = false;
  let migratedCrm = false;
  await mkdir(UPLOAD_DIR, { recursive: true });
  try { store = JSON.parse(await readFile(DB_FILE, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    store = defaultStore();
  }
  store.users ??= []; store.leads ??= []; store.conversations ??= []; store.audit ??= []; if(!Array.isArray(store.notifications)){store.notifications=[];migratedNotifications=true;} store.payments ??= []; store.campaigns ??= [];
  if(!Array.isArray(store.crmLeads)){store.crmLeads=[];migratedCrm=true;}
  store.withdrawals ??= []; store.financeLedger ??= []; store.expenses ??= []; store.mailQueue ??= []; store.referralVisits ??= []; store.referralLinks ??= []; store.referralEvents ??= []; store.referralAttributions ??= []; store.rankRequests ??= [];
  const templatePricingWasConfigured=store.settings?.templatePricingVersion===1;
  store.settings = { ...defaultStore().settings, ...(store.settings || {}) };
  store.settings.templatePrices ??= {};
  store.settings.templateInclusions ??= {};
  for(const template of templateCatalog){
    if(!templatePricingWasConfigured&&store.settings.templatePrices[template.id]==null){store.settings.templatePrices[template.id]=200;migratedTemplatePricing=true;}
    if(!store.settings.templateInclusions[template.id]){store.settings.templateInclusions[template.id]={...defaultTemplateInclusion};migratedTemplatePricing=true;}
  }
  if(!templatePricingWasConfigured){store.settings.templatePricingVersion=1;migratedTemplatePricing=true;}
  for(const price of store.settings.prices){price.active ??= true;price.pricingMode ??= 'fixed';}
  store.settings.templateActive ??= {};
  for(const template of templateCatalog)if(store.settings.templateActive[template.id]===undefined){store.settings.templateActive[template.id]=true;migratedTemplateAvailability=true;}
  store.settings.withdrawalMinimum=100;
  store.settings.withdrawalWindowStart=Math.min(31,Math.max(1,Number(store.settings.withdrawalWindowStart)||1));
  store.settings.withdrawalWindowEnd=Math.min(31,Math.max(1,Number(store.settings.withdrawalWindowEnd)||31));
  for(const withdrawal of store.withdrawals){
    if(withdrawal.status==='requested'){withdrawal.status='pending';migratedWithdrawals=true;}
    else if(withdrawal.status==='approved'){withdrawal.status='awaiting_transfer';migratedWithdrawals=true;}
    else if(withdrawal.status==='cancelled'){withdrawal.status='rejected';migratedWithdrawals=true;}
    if(withdrawal.transferDetails===undefined){withdrawal.transferDetails=null;migratedWithdrawals=true;}
    if(!withdrawal.statusHistory){withdrawal.statusHistory=[{status:withdrawal.status,at:withdrawal.updatedAt||withdrawal.createdAt,by:'system_migration'}];migratedWithdrawals=true;}
  }
  if ('setupHash' in store) { delete store.setupHash; migratedSetupFields = true; }
  if ('setupExpires' in store) { delete store.setupExpires; migratedSetupFields = true; }
  if (store.settings.commissionPercent == null) store.settings.commissionPercent = 15;
  let recoveredMail=false;
  for (const item of store.mailQueue) if (item.state === 'sending') { item.state = 'retry'; recoveredMail=true; }
  for (const user of store.users) {
    if (user.role === 'orders_manager' || user.role === 'documentation_officer') { user.role='hr_manager'; migratedSetupFields=true; }
    if (referralEnabled(user)) {
    user.referralCode ||= `Z${randomBytes(4).toString('hex').toUpperCase()}`;
    user.rank ??= 'rookie';
    if (!marketerRankOrder.includes(user.rank)) user.rank = 'rookie';
    user.activeCommissionRate ??= marketerRankRates[user.rank] ?? 35;
    if (user.rank === 'team_leader') user.teamLeaderTermsPending ??= true;
    }
    if(!user.permissionOverrides){user.permissionOverrides={};migratedPermissionData=true;}
    if(!user.department){user.department=roleDepartment(user.role);migratedPermissionData=true;}
  }
  for(const visit of store.referralVisits){
    const user=store.users.find(row=>row.id===visit.referralUserId);
    if(user&&!store.referralEvents.some(event=>event.idempotencyKey===`legacy-visit:${visit.referralUserId}:${visit.visitorHash}`)){
      const resolved=referralLinkForCode(user.currentReferralCode||user.referralCode);
      recordReferralEvent({userId:user.id,code:user.referralCode,linkId:resolved?.link?.id||null,type:'visit',visitorHash:visit.visitorHash,idempotencyKey:`legacy-visit:${visit.referralUserId}:${visit.visitorHash}`});
    }
  }
  const referralLinksCreated=ensureMonthlyReferralLinks();
  const referralEventsBeforeCleanup=store.referralEvents.length,referralAttributionsBeforeCleanup=store.referralAttributions.length;
  cleanReferralEvents();cleanReferralAttributions();
  const referralDataCleaned=referralEventsBeforeCleanup!==store.referralEvents.length||referralAttributionsBeforeCleanup!==store.referralAttributions.length;
  for (const lead of store.leads) {
    if (lead.clientId === undefined) { lead.clientId = null; migratedClientData = true; }
    if (lead.clientWhatsappPhone === undefined) { lead.clientWhatsappPhone = isE164Phone(lead.phone) ? lead.phone : ''; migratedClientData = true; }
    if (!lead.statusHistory) { lead.statusHistory = [{ status: lead.status || 'new', at: lead.createdAt || now(), note: '' }]; migratedClientData = true; }
    lead.developerUserId ??= null; lead.developerDueDate ??= ''; lead.developerTaskStatus ??=''; lead.developerTaskNote ??='';
    lead.developerAttachments ??=[]; lead.supportNotes ??=[]; lead.financialReview ??=null;lead.developerReviewStatus??=null;
    if(!lead.projectStage){lead.projectStage=lead.developerTaskStatus==='offered'?'waiting_developer_acceptance':projectStageFromOrderStatus[lead.status]||'new_request';lead.projectHistory=[{stage:lead.projectStage,at:lead.createdAt||now(),by:'system_migration',note:'Project lifecycle initialized.'}];migratedClientData=true;}
    lead.projectHistory ??=[];lead.projectStartedAt??=lead.developerAcceptedAt||lead.developerAssignedAt||'';lead.projectDeliveredAt??='';lead.clientDeliveryAt??='';
    lead.developerCommissionRate = developerCommissionRate;
    lead.developerCommissionAmount ??= 0; lead.developerCommissionStatus ??='none'; lead.developerCommissionPaidAmount ??=0;
    lead.developerCommissionOffsetAmount ??=0; lead.developerCommissionDebtRemaining ??=0; lead.developerWithdrawalId ??=null;
    lead.developerCommissionReview ??=null;
    lead.commissionPaidAmount ??= lead.commissionStatus === 'paid' ? Number(lead.commissionAmount || 0) : 0;
    lead.commissionOffsetAmount ??= 0;
    lead.isDuplicate ??= false;
    lead.duplicateOfLeadId ??= null;
    lead.referralLinkId ??=referralLinkForCode(lead.referralCode||'')?.link?.id||null;
    if(lead.referralUserId&&lead.referralCode&&!lead.isDuplicate&&!lead.duplicateOfLeadId){
      if(!store.referralEvents.some(event=>event.idempotencyKey===`project_request:${lead.id}`))recordReferralEvent({userId:lead.referralUserId,code:lead.referralCode,linkId:lead.referralLinkId,type:'project_request',leadId:lead.id,idempotencyKey:`project_request:${lead.id}`,createdAt:lead.createdAt});
      if(lead.quoteAcceptedAt&&!store.referralEvents.some(event=>event.idempotencyKey===`quote_accepted:${lead.id}`))recordReferralEvent({userId:lead.referralUserId,code:lead.referralCode,linkId:lead.referralLinkId,type:'quote_accepted',leadId:lead.id,idempotencyKey:`quote_accepted:${lead.id}`,createdAt:lead.quoteAcceptedAt});
    }
    if (lead.commissionRate == null && lead.contractAmount && lead.referralUserId) {
      lead.commissionRate = Number(store.settings.commissionPercent ?? 15);
      lead.commissionRank = 'rookie';
      lead.commissionRateSetAt = lead.createdAt || now();
    }
    updateDeveloperCommission(lead);
    syncLeadReferralMilestones(lead);
  }
  for(const payment of store.payments){const lead=store.leads.find(row=>row.id===payment.leadId);if(!lead?.referralUserId||!lead.referralCode)continue;const type=payment.kind==='refund'?'refund':'payment_received',key=`${type}:${payment.id}`;if(!store.referralEvents.some(event=>event.idempotencyKey===key))recordReferralEvent({userId:lead.referralUserId,code:lead.referralCode,linkId:lead.referralLinkId,type,leadId:lead.id,idempotencyKey:key,createdAt:payment.createdAt||payment.at||lead.createdAt});}
  for(const withdrawal of store.withdrawals){
    withdrawal.commissionItems ??=(withdrawal.commissionIds||[]).map(leadId=>({leadId,kind:'referral'}));
    withdrawal.referralAmount ??=Number(withdrawal.amount||0); withdrawal.developerAmount ??=0;
    for(const item of withdrawal.commissionItems){
      if(item.kind==='referral'){const lead=store.leads.find(row=>row.id===item.leadId);if(lead)lead.withdrawalId??=withdrawal.id;}
      if(item.kind==='developer'){const lead=store.leads.find(row=>row.id===item.leadId);if(lead)lead.developerWithdrawalId??=withdrawal.id;}
    }
    appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:requested`,type:'withdrawal_reserved',employeeId:withdrawal.userId,withdrawalId:withdrawal.id,amountCents:cents(withdrawal.amount),statusSnapshot:withdrawal.status,actor:'system_migration',postedAt:withdrawal.createdAt});
    if(withdrawal.status==='paid')appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:paid`,type:'withdrawal_paid',employeeId:withdrawal.userId,withdrawalId:withdrawal.id,amountCents:cents(withdrawal.amount),statusSnapshot:'paid',actor:'system_migration',postedAt:withdrawal.paidAt||withdrawal.updatedAt||withdrawal.createdAt,transferReference:withdrawal.transferReference||''});
    else if(withdrawal.status==='rejected')appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:released`,type:'withdrawal_released',employeeId:withdrawal.userId,withdrawalId:withdrawal.id,amountCents:cents(withdrawal.amount),statusSnapshot:'rejected',actor:'system_migration',postedAt:withdrawal.updatedAt||withdrawal.createdAt});
  }
  const ledgerSizeBefore=store.financeLedger.length;
  for(const lead of store.leads)syncLeadFinanceLedger(lead);
  for(const expense of store.expenses)appendFinanceEntry({idempotencyKey:`expense:${expense.id}`,type:'operating_expense',expenseId:expense.id,leadId:expense.leadId||null,employeeId:expense.employeeId||null,amountCents:-cents(expense.amount),note:expense.description||'',actor:expense.createdBy||'system_migration',postedAt:expense.date||expense.createdAt});
  const financeMigrated=ledgerSizeBefore!==store.financeLedger.length;
  const rankRequestsCreated = syncAllRankRequests();
  for(const lead of store.leads){const linked=(store.crmLeads||[]).some(row=>row.orderIds?.includes(lead.id)||row.id===lead.crmLeadId);ensureCrmCaseForOrder(lead);if(!linked)migratedCrm=true;}
  if(recoveredMail || migratedSetupFields || migratedWithdrawals || migratedTemplateAvailability || migratedTemplatePricing || migratedPermissionData || migratedClientData || migratedNotifications || migratedCrm || referralLinksCreated || referralDataCleaned || rankRequestsCreated.length || financeMigrated || store.users.some(referralEnabled)) await persist();
  for (const request of rankRequestsCreated) await queueRankRequestMail(request);
  return firstAdminSetupAvailable();
}
function audit(actor, action, target, detail = '') {
  const entry={ id: id('evt'), at: now(), actor: actor ? actor.username : 'system', actorId:actor?.id||'', role: actor?.role || 'system', action, target, detail: clean(detail, 180) };
  store.audit.unshift(entry);
  store.audit = store.audit.slice(0, 500);
  emitAuditNotifications(entry,actor);
}
const notificationAllowedTabs={admin:['overview','requests','finance','referrals','ranks','withdrawals','team','marketing','crm','pricing','audit','conversations','permissions'],marketing_manager:['marketing','referrals','crm','conversations'],hr_manager:['people','referrals','conversations','orders'],order_manager:['conversations','orders'],marketer:['referral'],developer:['development','referral'],client:['orders','conversations']};
function createNotification(userId,eventKey,{type='update',importance='normal',titleAr,titleEn,descriptionAr='',descriptionEn='',tab='',targetId='',targetKind=''}={}){
  if(!userId||!eventKey||!titleAr||!titleEn)return null;
  store.notifications??=[];
  if(store.notifications.some(row=>row.userId===userId&&row.eventKey===eventKey))return store.notifications.find(row=>row.userId===userId&&row.eventKey===eventKey);
  const user=store.users.find(row=>row.id===userId);if(!user)return null;
  const allowed=notificationAllowedTabs[user.role]||[];
  const safeTab=allowed.includes(tab)?tab:(user.role==='client'?'orders':user.role==='admin'?'overview':user.role==='marketing_manager'?'marketing':user.role==='hr_manager'?'people':user.role==='order_manager'?'conversations':user.role==='developer'?'development':'referral');
  const row={id:id('ntf'),userId,eventKey:clean(eventKey,180),type:clean(type,32),importance:['low','normal','high','critical'].includes(importance)?importance:'normal',titleAr:clean(titleAr,140),titleEn:clean(titleEn,140),descriptionAr:clean(descriptionAr,320),descriptionEn:clean(descriptionEn,320),createdAt:now(),readAt:'',target:{tab:safeTab,id:clean(targetId,100),kind:clean(targetKind,32)}};
  store.notifications.unshift(row);
  if(store.notifications.length>10000){
    const excess=store.notifications.length-10000;
    let removed=0;
    for(let index=store.notifications.length-1;index>=0&&removed<excess;index--)if(store.notifications[index].readAt){store.notifications.splice(index,1);removed++;}
  }
  return row;
}
function notifyRoles(userRoles,eventKey,copy,{excludeUserId='',tabs={},targetId='',targetKind=''}={}){
  for(const user of store.users.filter(row=>userRoles.includes(row.role)&&row.active&&!row.accountDisabledAt&&row.id!==excludeUserId))createNotification(user.id,eventKey,{...copy,tab:tabs[user.role]||'',targetId,targetKind});
}
function notifyUser(userId,eventKey,copy,options={}){return createNotification(userId,eventKey,{...copy,...options});}
function emitAuditNotifications(entry,actor){
  const action=entry.action,target=String(entry.target||''),targetId=String(entry.target||''),key=`audit:${entry.id}`;
  const lead=store.leads.find(row=>row.id===target);
  if(lead&&['lead_updated','hr_order_updated','manual_payment_verified','refund_recorded','developer_commission_approved','developer_revision_requested'].includes(action))notifyCurrentCommissions(lead);
  const notifyLeadPeople=(copy,{ownerTab='requests',supportTab='marketing',includeClient=true,includeReferral=true,includeDeveloper=false,excludeActor=false}={})=>{
    notifyRoles(['admin'],key,copy,{excludeUserId:excludeActor?actor?.id:'',tabs:{admin:ownerTab},targetId:lead?.id||target,targetKind:'lead'});
    notifyRoles(['marketing_manager'],key,copy,{excludeUserId:excludeActor?actor?.id:'',tabs:{marketing_manager:supportTab},targetId:lead?.id||target,targetKind:'lead'});
    if(lead&&includeClient&&lead.clientId)notifyUser(lead.clientId,key,copy,{tab:'orders',targetId:lead.id,targetKind:'lead'});
    if(lead&&includeReferral&&lead.referralUserId)notifyUser(lead.referralUserId,key,copy,{tab:'referral',targetId:lead.id,targetKind:'lead'});
    if(lead&&includeDeveloper&&lead.developerUserId)notifyUser(lead.developerUserId,key,copy,{tab:'development',targetId:lead.id,targetKind:'lead'});
  };
  const copy=(type,importance,titleAr,titleEn,descriptionAr,descriptionEn)=>({type,importance,titleAr,titleEn,descriptionAr,descriptionEn});
  if(action==='client_project_request'&&lead){
    const c=copy('project','high','طلب مشروع جديد','New project request','وصل طلب جديد. افتح الطلب لمراجعته.','A new project request arrived. Open it to review.');
    notifyLeadPeople(c,{includeClient:false});
    notifyUser(lead.clientId,key,copy('project','normal','تم استلام طلبك','Your request was received','يمكنك متابعة حالة الطلب من حسابك.','You can follow the request from your account.'),{tab:'orders',targetId:lead.id,targetKind:'lead'});
    if(lead.referralUserId&&!lead.isDuplicate)notifyUser(lead.referralUserId,key,copy('referral','normal','طلب جديد من رابطك','A new request from your link','أُضيف طلب إلى سجل إحالاتك. بيانات العميل محمية.','A request was added to your referrals. Customer details are protected.'),{tab:'referral',targetId:lead.id,targetKind:'lead'});
    return;
  }
  if(action==='referral_inquiry_confirmed'){
    const followupId=target,clicked=store.referralEvents.find(row=>row.type==='whatsapp_click'&&row.followupId===followupId),copyText=copy('inquiry','normal','تأكد استفسار عميل','Customer enquiry confirmed','تم توثيق محادثة مرتبطة برابط إحالة.','A conversation linked to a referral has been confirmed.');
    notifyRoles(['admin','marketing_manager'],key,copyText,{tabs:{admin:'marketing',marketing_manager:'marketing'},targetId:followupId,targetKind:'inquiry'});
    if(clicked)notifyUser(clicked.userId,key,copy('inquiry','normal','تم تأكيد استفسار من رابطك','An enquiry from your link was confirmed','تم توثيق الاستفسار، ولا يُعد ذلك مبيعة.','The enquiry was confirmed; it is not a sale.'),{tab:'referral',targetId:followupId,targetKind:'inquiry'});
    return;
  }
  if(action==='withdrawal_requested'){
    const item=store.withdrawals.find(row=>row.id===target),c=copy('withdrawal','high','طلب سحب ينتظر المراجعة','Withdrawal request needs review','وصل طلب سحب موظف. راجعه من قسم طلبات السحب.','An employee submitted a withdrawal request. Review it in Withdrawals.');
    notifyRoles(['admin','hr_manager'],key,c,{tabs:{admin:'withdrawals',hr_manager:'people'},targetId:target,targetKind:'withdrawal'});
    if(item)notifyUser(item.userId,key,copy('withdrawal','normal','وصل طلب السحب','Withdrawal request received','تم تسجيل طلبك وينتظر المراجعة.','Your request was recorded and is awaiting review.'),{tab:item.role==='developer'?'referral':'referral',targetId:target,targetKind:'withdrawal'});
    return;
  }
  if(action==='withdrawal_reviewed'){
    const item=store.withdrawals.find(row=>row.id===target),c=copy('withdrawal','high','مراجعة سحب تنتظر قراري','Withdrawal review awaits my decision','راجع مسؤول الموظفين طلب السحب. لا يتم الصرف إلا بموافقة المالك.','HR reviewed a withdrawal request. Only the owner can approve payment.');
    notifyRoles(['admin'],key,c,{excludeUserId:actor?.id,tabs:{admin:'withdrawals'},targetId,targetKind:'withdrawal'});
    if(item)notifyUser(item.userId,key,copy('withdrawal','normal','تمت مراجعة طلب السحب','Withdrawal request reviewed','أُحيل طلبك إلى المالك لاتخاذ القرار.','Your request was forwarded to the owner for a decision.'),{tab:'referral',targetId,targetKind:'withdrawal'});
    return;
  }
  if(action.startsWith('withdrawal_')&&['withdrawal_awaiting_transfer','withdrawal_rejected','withdrawal_paid'].includes(action)){
    const item=store.withdrawals.find(row=>row.id===target);if(item){const paid=action==='withdrawal_paid',rejected=action==='withdrawal_rejected';notifyUser(item.userId,key,copy('withdrawal',paid?'normal':'high',paid?'تم توثيق صرف مستحقاتك':rejected?'رُفض طلب السحب':'تمت الموافقة على طلب السحب',paid?'Payout recorded':rejected?'Withdrawal request declined':'Withdrawal request approved',paid?'سُجل التحويل بعد التحقق منه.':rejected?'راجع تفاصيل الطلب في مساحتك.':'أصبح الطلب بانتظار التحويل اليدوي.',paid?'The transfer was recorded after verification.':rejected?'Review the request details in your workspace.':'The request is awaiting manual transfer.'),{tab:'referral',targetId,targetKind:'withdrawal'});notifyRoles(['hr_manager'],key,copy('withdrawal','normal','تغيّرت حالة طلب سحب','Withdrawal status changed','تغيّرت حالة طلب موظف بعد قرار المالك.','An employee withdrawal changed after the owner decision.'),{tabs:{hr_manager:'people'},targetId,targetKind:'withdrawal'});}return;
  }
  if(action==='withdrawal_cancelled'){
    const item=store.withdrawals.find(row=>row.id===target);
    if(item){const c=copy('withdrawal','high','أُلغي طلب سحب بسبب تسوية مرتبطة','Withdrawal request cancelled after a related adjustment','تغيّرت حالة طلب سحب بسبب إلغاء مشروع أو استرداد مرتبط. راجع السجل.','A withdrawal changed after a related project cancellation or refund. Review its history.');notifyRoles(['admin','hr_manager'],key,c,{tabs:{admin:'withdrawals',hr_manager:'people'},targetId,targetKind:'withdrawal'});notifyUser(item.userId,key,copy('withdrawal','high','تغيّرت حالة طلب السحب','Withdrawal request status changed','أُلغِي الطلب بسبب تسوية مرتبطة. راجع محفظتك وسجل السحب.','The request was cancelled after a related adjustment. Review your wallet and withdrawal history.'),{tab:'referral',targetId,targetKind:'withdrawal'});}
    return;
  }
  if(action==='rank_promotion_requested'){
    const request=store.rankRequests.find(row=>row.id===target),employee=request&&store.users.find(row=>row.id===request.userId),c=copy('rank','high','طلب ترقية مسوّق','Marketer promotion request','بلغ مسوّق حد التأهل. يلزم قرار المالك؛ لا تتغير النسبة قبل الموافقة.','A marketer reached a promotion threshold. Owner approval is required; the rate does not change before approval.');
    notifyRoles(['admin','hr_manager'],key,c,{tabs:{admin:'ranks',hr_manager:'people'},targetId,targetKind:'rank_request'});
    if(employee)notifyUser(employee.id,key,copy('rank','normal','أصبحت مؤهلاً لطلب ترقية','You are eligible for promotion review','أُرسل طلب الترقية وينتظر قرار المالك.','A promotion request was submitted and awaits the owner.'),{tab:'referral',targetId,targetKind:'rank_request'});return;
  }
  if(action==='rank_request_invalidated'){
    const request=store.rankRequests.find(row=>row.id===target),c=copy('rank','high','تغيّر أهلية طلب ترقية','Promotion eligibility changed','انخفض عدد المبيعات المؤهلة بعد إلغاء أو استرداد. راجع حالة الطلب.','Qualified sales decreased after a cancellation or refund. Review the promotion request.');notifyRoles(['admin','hr_manager'],key,c,{tabs:{admin:'ranks',hr_manager:'people'},targetId,targetKind:'rank_request'});if(request)notifyUser(request.userId,key,copy('rank','high','تغيّرت أهلية الترقية','Promotion eligibility changed','تغيّر عدد المبيعات المؤهلة بعد تسوية مرتبطة.','Your qualified-sale count changed after a related adjustment.'),{tab:'referral',targetId,targetKind:'rank_request'});return;
  }
  if(action==='rank_approved'||action==='rank_rejected'){
    const request=store.rankRequests.find(row=>row.id===target);if(request)notifyUser(request.userId,key,copy('rank',action==='rank_approved'?'normal':'high',action==='rank_approved'?'تمت الموافقة على ترقيتك':'رُفض طلب الترقية',action==='rank_approved'?'Your promotion was approved':'Your promotion request was declined',action==='rank_approved'?'تسري العمولة الجديدة على المبيعات المستقبلية فقط.':'يمكنك مراجعة حالة الرتبة من مساحتك.',action==='rank_approved'?'The new rate applies to future sales only.':'Review your rank status in your workspace.'),{tab:'referral',targetId,targetKind:'rank_request'});return;
  }
  if(action==='developer_assigned'&&lead){
    const c=copy('project','high','تم إسناد مشروع لمبرمج','Project assigned to a developer','أُسند مشروع للمراجعة والمتابعة.','A project was assigned for review and follow-up.');
    notifyRoles(['admin','marketing_manager'],key,c,{excludeUserId:actor?.id,tabs:{admin:'requests',marketing_manager:'marketing'},targetId,targetKind:'lead'});
    if(lead.developerUserId)notifyUser(lead.developerUserId,key,copy('project','high','عُرضت عليك مهمة مشروع','A project task was assigned to you','راجع نطاق المشروع وعمولة التنفيذ والموعد ثم اقبل أو اعتذر.','Review the project scope, execution commission, and deadline, then accept or decline.'),{tab:'development',targetId,targetKind:'lead'});
    if(lead.clientId)notifyUser(lead.clientId,key,copy('project','normal','بدأ تجهيز فريق مشروعك','Your project team is being prepared','تم إسناد المشروع إلى المبرمج المناسب. تابع التحديثات من حسابك.','A developer was assigned to your project. Follow updates from your account.'),{tab:'orders',targetId,targetKind:'lead'});return;
  }
  if(action==='developer_task_accepted'||action==='developer_task_declined'){
    const c=copy('project','normal',action==='developer_task_accepted'?'قبل المبرمج المهمة':'اعتذر المبرمج عن المهمة',action==='developer_task_accepted'?'Developer accepted the task':'Developer declined the task','راجع المشروع وحدّث الإسناد أو تواصل مع العميل عند الحاجة.','Review the project and update the assignment or contact the customer if needed.');
    notifyRoles(['admin','marketing_manager'],key,c,{excludeUserId:actor?.id,tabs:{admin:'requests',marketing_manager:'marketing'},targetId,targetKind:'lead'});return;
  }
  if(action==='developer_project_updated'&&lead){
    if(lead.developerTaskStatus==='review_requested'){
      notifyRoles(['admin','marketing_manager'],key,copy('project','high','تسليم مبرمج ينتظر المراجعة','Developer delivery awaits review','رفع المبرمج الملفات وطلب مراجعة التنفيذ.','The developer uploaded files and requested a delivery review.'),{excludeUserId:actor?.id,tabs:{admin:'requests',marketing_manager:'marketing'},targetId,targetKind:'lead'});
      if(lead.clientId)notifyUser(lead.clientId,key,copy('project','normal','المشروع جاهز لمراجعتك','Your project is ready for review','أنهى فريق التنفيذ مرحلة العمل. افتح حسابك لمراجعة التحديثات والملفات المتاحة.','The delivery team finished this stage. Open your account to review the updates and available files.'),{tab:'orders',targetId,targetKind:'lead'});
    }
    else if(['in_progress','accepted'].includes(lead.developerTaskStatus)&&lead.clientId)notifyUser(lead.clientId,key,copy('project','normal','بدأ العمل على مشروعك','Work on your project has started','تابع مراحل التنفيذ من حسابك.','Follow project progress from your account.'),{tab:'orders',targetId,targetKind:'lead'});return;
  }
  if(action==='developer_commission_approved'||action==='developer_revision_requested'){
    if(lead?.developerUserId)notifyUser(lead.developerUserId,key,copy('project',action==='developer_commission_approved'?'normal':'high',action==='developer_commission_approved'?'تم اعتماد تسليم المشروع':'مطلوب تعديل في التسليم',action==='developer_commission_approved'?'Project delivery approved':'A delivery revision is required',action==='developer_commission_approved'?'تم اعتماد التنفيذ بعد المراجعة. ستظهر المستحقات وفق حالة الدفع وفترة التراجع.':'راجع ملاحظة المراجعة في المهمة المسندة إليك.',action==='developer_commission_approved'?'The work passed review. Entitlements follow payment status and the hold period.':'Review the note on your assigned task.'),{tab:'development',targetId,targetKind:'lead'});
    if(action==='developer_commission_approved'&&lead?.clientId)notifyUser(lead.clientId,key,copy('project','high','اكتمل تنفيذ مشروعك','Your project delivery is complete','اعتمد فريق ZEZO التسليم. افتح حسابك لمراجعة المشروع والملفات النهائية المتاحة.','ZEZO approved the delivery. Open your account to review the project and available final files.'),{tab:'orders',targetId,targetKind:'lead'});
    if(action==='developer_revision_requested')notifyRoles(['marketing_manager'],key,copy('project','normal','المبرمج يحتاج متابعة مع العميل','Developer needs customer follow-up','طُلب تعديل على تسليم المشروع.','A revision was requested for the project delivery.'),{tabs:{marketing_manager:'marketing'},targetId,targetKind:'lead'});return;
  }
  if(action==='client_quote_accepted'||action==='quote_acceptance_recorded'){
    notifyRoles(['admin','marketing_manager'],key,copy('quote','normal','تم قبول عرض سعر','A quote was accepted','تم تأكيد قبول عرض مرتبط بطلب مشروع.','A project quote acceptance was confirmed.'),{excludeUserId:actor?.role==='admin'?actor.id:'',tabs:{admin:'requests',marketing_manager:'marketing'},targetId,targetKind:'lead'});
    if(lead?.referralUserId)notifyUser(lead.referralUserId,key,copy('sale','normal','قبل العميل عرض السعر','Customer accepted a quote','تغيّرت مرحلة طلب الإحالة. القبول وحده لا يسجل مبيعة مؤهلة.','A referred request progressed. Acceptance alone is not a qualified sale.'),{tab:'referral',targetId,targetKind:'lead'});return;
  }
  if(action==='lead_updated'||action==='hr_order_updated'||action==='customer_support_updated'){
    if(lead?.clientId)notifyUser(lead.clientId,key,copy('project','normal','هناك تحديث على طلبك','There is an update to your request','افتح حسابك للاطلاع على الحالة وأي تحديث متاح.','Open your account to review the status and available update.'),{tab:'orders',targetId,targetKind:'lead'});
    if(lead?.developerUserId&&action!=='customer_support_updated')notifyUser(lead.developerUserId,key,copy('project','normal','تحدّثت تفاصيل المشروع المسند إليك','Your assigned project was updated','تم تعديل حالة المشروع أو تفاصيله. افتح المهمة لمراجعة أحدث المعلومات.','The project status or details changed. Open your assignment to review the latest information.'),{tab:'development',targetId,targetKind:'lead'});
    if(action==='lead_updated'&&lead?.status==='cancelled')notifyRoles(['admin'],key,copy('finance','high','أُلغي مشروع يحتاج مراجعة','A cancelled project needs review','أُلغي مشروع. راجع أثر الإلغاء على الدفعات والعمولات والمستحقات.','A project was cancelled. Review its impact on payments, commissions, and entitlements.'),{excludeUserId:actor?.id,tabs:{admin:'finance'},targetId,targetKind:'lead'});
    if(action==='customer_support_updated'&&lead?.referralUserId)notifyUser(lead.referralUserId,key,copy('project','low','تحديث متابعة لطلب من رابطك','A request from your link was followed up','تم تحديث متابعة الطلب. بيانات العميل محمية.','The request follow-up was updated. Customer details remain protected.'),{tab:'referral',targetId,targetKind:'lead'});return;
  }
  if(action==='manual_payment_verified'||action==='refund_recorded'){
    notifyRoles(['admin'],key,copy(action==='refund_recorded'?'finance':'payment',action==='refund_recorded'?'high':'normal',action==='refund_recorded'?'تم تسجيل استرداد يحتاج مراجعة':'تم تأكيد دفعة جديدة',action==='refund_recorded'?'A refund was recorded for review':'A new payment was verified',action==='refund_recorded'?'تغيرت حالة مبلغ محصّل؛ راجع أثر الاسترداد على العمولات والتسوية.':'تم تأكيد دفعة مرتبطة بمشروع. راجع التسوية عند الحاجة.',action==='refund_recorded'?'A collected amount changed; review its effect on commissions and settlement.':'A project payment was verified. Review the settlement if needed.'),{excludeUserId:actor?.id,tabs:{admin:'finance'},targetId,targetKind:'lead'});
    if(lead?.clientId)notifyUser(lead.clientId,key,copy('payment',action==='refund_recorded'?'high':'normal',action==='refund_recorded'?'تم تسجيل استرداد على طلبك':'تم تأكيد دفعة لطلبك',action==='refund_recorded'?'A refund was recorded for your request':'A payment was confirmed for your request','تم تحديث سجل الدفعات في حسابك.','Your payment history was updated in your account.'),{tab:'orders',targetId,targetKind:'lead'});
    if(lead?.referralUserId)notifyUser(lead.referralUserId,key,copy('commission','normal',action==='refund_recorded'?'تغيّر رصيد عمولة الإحالة بعد استرداد':'تحديث على عمولة الإحالة',action==='refund_recorded'?'Referral commission changed after a refund':'Referral commission updated','راجع حالة العمولة من مساحتك؛ لا تظهر هنا بيانات العميل.','Review the commission status in your workspace; customer details are not shown.'),{tab:'referral',targetId,targetKind:'lead'});
    if(lead?.developerUserId)notifyUser(lead.developerUserId,key,copy('commission','normal',action==='refund_recorded'?'تغيّر استحقاق التنفيذ بعد استرداد':'تحديث على استحقاق التنفيذ',action==='refund_recorded'?'Execution entitlement changed after a refund':'Execution entitlement updated','راجع محفظة التنفيذ المنفصلة عن التسويق.','Review your execution wallet, separate from marketing.'),{tab:'development',targetId,targetKind:'lead'});return;
  }
  if(action==='employee_invited'){
    const c=copy('team','high','دعوة موظف تنتظر المراجعة','Employee invitation needs review','تم تجهيز دعوة موظف. راجعها ضمن إدارة الفريق.','An employee invitation was prepared. Review it in Team management.');
    notifyRoles(['admin','hr_manager'],key,c,{excludeUserId:actor?.id,tabs:{admin:'team',hr_manager:'people'},targetId,targetKind:'employee'});return;
  }
  if(action==='employee_invitation_approved'||action==='employee_invitation_rejected'){
    notifyRoles(['hr_manager'],key,copy('team','normal',action==='employee_invitation_approved'?'تمت الموافقة على دعوة الموظف':'رُفضت دعوة الموظف',action==='employee_invitation_approved'?'Employee invitation approved':'Employee invitation declined','تغيّرت حالة الدعوة التي جهزتها.','An invitation you prepared changed status.'),{excludeUserId:actor?.id,tabs:{hr_manager:'people'},targetId,targetKind:'employee'});return;
  }
  if(action==='account_activated')notifyRoles(['admin','hr_manager'],key,copy('team','normal','فعّل موظف حسابه','An employee activated an account','أكمل الموظف تفعيل الحساب.','The employee completed account activation.'),{excludeUserId:actor?.id,tabs:{admin:'team',hr_manager:'people'},targetId,targetKind:'employee'});
  if(action==='project_financial_settlement_saved'&&lead?.financeSettlement?.lowMargin)notifyRoles(['admin'],key,copy('finance','high','تسوية بهامش منخفض تحتاج قراراً','Low-margin settlement needs review','تم حفظ تسوية بهامش منخفض؛ راجعها في الخزينة قبل المتابعة.','A low-margin settlement was saved. Review it in Finance before proceeding.'),{excludeUserId:actor?.id,tabs:{admin:'finance'},targetId,targetKind:'lead'});
  if(action==='employee_updated'){
    notifyRoles(['admin'],key,copy('team','normal','تم تحديث بيانات موظف','Employee account updated','تم تغيير إعدادات حساب موظف.','An employee account setting changed.'),{excludeUserId:actor?.id,tabs:{admin:'team'},targetId,targetKind:'employee'});
  }
}
function notifyCurrentCommissions(lead){
  if(Number(lead.commissionAmount||0)>0&&lead.referralUserId){const status=lead.commissionStatus||'pending',amount=money(lead.commissionAmount),key=`commission:${lead.id}:referral:${status}:${amount}`;notifyUser(lead.referralUserId,key,{type:'commission',importance:status==='confirmed'?'high':'normal',titleAr:status==='confirmed'?'أصبحت عمولة الإحالة متاحة':'تحدّثت عمولة الإحالة',titleEn:status==='confirmed'?'Referral commission is available':'Referral commission updated',descriptionAr:status==='confirmed'?'راجع محفظتك؛ المبلغ متاح وفق حالة العمولة والسحب.':'تغيرت حالة العمولة المرتبطة بطلبك. راجع محفظتك للتفاصيل.',descriptionEn:status==='confirmed'?'Review your wallet; availability follows commission and withdrawal status.':'The commission status for your request changed. Review your wallet for details.'},{tab:'referral',targetId:lead.id,targetKind:'lead'});}
  if(Number(lead.developerCommissionAmount||0)>0&&lead.developerUserId){const status=lead.developerCommissionStatus||'pending',amount=money(lead.developerCommissionAmount),key=`commission:${lead.id}:developer:${status}:${amount}`;notifyUser(lead.developerUserId,key,{type:'commission',importance:status==='confirmed'?'high':'normal',titleAr:status==='confirmed'?'استحقاق تنفيذ المشروع متاح':'تحدّث استحقاق تنفيذ المشروع',titleEn:status==='confirmed'?'Project execution entitlement is available':'Project execution entitlement updated',descriptionAr:'هذا الاستحقاق منفصل عن عمولة التسويق ويظهر في محفظة التنفيذ.',descriptionEn:'This entitlement is separate from marketing commission and appears in your execution wallet.'},{tab:'development',targetId:lead.id,targetKind:'lead'});}
}
function safeNotification(row){return {id:row.id,type:row.type,importance:row.importance,titleAr:row.titleAr,titleEn:row.titleEn,descriptionAr:row.descriptionAr,descriptionEn:row.descriptionEn,createdAt:row.createdAt,readAt:row.readAt||'',target:{tab:row.target?.tab||'',id:row.target?.id||'',kind:row.target?.kind||''}};}
function ownerDecisionsFor(){
  const decisions=[];
  for(const request of store.rankRequests.filter(row=>row.status==='pending')){const user=store.users.find(row=>row.id===request.userId);decisions.push({id:request.id,type:'rank',titleAr:`ترقية ${user?.name||'مسوّق'}`,titleEn:`Promote ${user?.name||'marketer'}`,descriptionAr:`${marketerRankTitles[request.targetRank]} · ${request.salesAtRequest}/${request.threshold} مبيعات مؤهلة`,descriptionEn:`${marketerRankTitles[request.targetRank]} · ${request.salesAtRequest}/${request.threshold} qualified sales`,createdAt:request.createdAt,target:{tab:'ranks',id:request.id,kind:'rank_request'}});}
  for(const item of store.withdrawals.filter(row=>['pending','under_review'].includes(row.status)))decisions.push({id:item.id,type:'withdrawal',titleAr:'طلب سحب موظف',titleEn:'Employee withdrawal',descriptionAr:'مراجعة الطلب ثم اتخاذ قرار المالك.',descriptionEn:'Review the request and decide as owner.',createdAt:item.updatedAt||item.createdAt,target:{tab:'withdrawals',id:item.id,kind:'withdrawal'}});
  for(const lead of store.leads.filter(row=>row.developerTaskStatus==='review_requested'))decisions.push({id:lead.id,type:'project',titleAr:'تسليم مبرمج ينتظر المراجعة',titleEn:'Developer delivery awaiting review',descriptionAr:'راجع الملفات قبل اعتماد التسليم.',descriptionEn:'Review the uploaded files before approving delivery.',createdAt:lead.developerUpdatedAt||lead.createdAt,target:{tab:'requests',id:lead.id,kind:'lead'}});
  for(const lead of store.leads.filter(row=>row.financeSettlement?.lowMargin&&row.financeSettlementReview?.settlementId!==row.financeSettlement.id&&row.status==='completed'))decisions.push({id:lead.id,type:'finance',titleAr:'تسوية بهامش منخفض',titleEn:'Low-margin settlement',descriptionAr:'راجع الهامش والعمولات والمصاريف ثم سجّل المراجعة في الخزينة.',descriptionEn:'Review margin, commissions, and costs, then record the review in Finance.',createdAt:lead.financeSettlement.createdAt||lead.createdAt,target:{tab:'finance',id:lead.id,kind:'settlement'}});
  const currentTime=Date.now();for(const lead of store.leads.filter(row=>row.developerUserId&&row.developerDueDate&&!['completed','cancelled'].includes(row.status))){const due=Date.parse(`${String(lead.developerDueDate).slice(0,10)}T23:59:59.999Z`);if(Number.isFinite(due)&&due<currentTime)decisions.push({id:lead.id,type:'deadline',titleAr:'مشروع متأخر عن موعده',titleEn:'Overdue project',descriptionAr:'راجع الموعد والتقدم وخطة التواصل مع العميل.',descriptionEn:'Review the deadline, progress, and customer follow-up plan.',createdAt:lead.developerUpdatedAt||lead.createdAt,target:{tab:'requests',id:lead.id,kind:'lead'}});}
  return decisions.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,100);
}
function emitDeadlineNotifications(){
  const latestId=store.notifications?.[0]?.id||'';
  const current=new Date(),today=current.toISOString().slice(0,10),dayEnd=Date.parse(`${today}T23:59:59.999Z`);
  for(const lead of store.leads){
    if(!lead.developerUserId||!lead.developerDueDate||['completed','cancelled'].includes(lead.status))continue;
    const due=Date.parse(`${String(lead.developerDueDate).slice(0,10)}T23:59:59.999Z`);if(!Number.isFinite(due))continue;
    const overdue=due<current.getTime(),soon=!overdue&&due<=dayEnd+86400000;if(!overdue&&!soon)continue;
    const key=`deadline:${lead.id}:${today}:${overdue?'late':'soon'}`,copy={type:'deadline',importance:overdue?'critical':'high',titleAr:overdue?'مشروع متأخر عن موعده':'موعد تسليم المشروع قريب',titleEn:overdue?'Project is overdue':'Project deadline is approaching',descriptionAr:overdue?'راجع الموعد وحالة المشروع واتخذ الإجراء المناسب.':'ينتهي موعد التسليم اليوم أو غداً؛ تابع التقدم.',descriptionEn:overdue?'Review the deadline and project status.':'The deadline is today or tomorrow; check progress.'};
    notifyRoles(['admin'],key,copy,{tabs:{admin:'requests'},targetId:lead.id,targetKind:'lead'});notifyUser(lead.developerUserId,key,copy,{tab:'development',targetId:lead.id,targetKind:'lead'});notifyRoles(['marketing_manager'],key,copy,{tabs:{marketing_manager:'marketing'},targetId:lead.id,targetKind:'lead'});
  }
  for(const record of store.crmLeads||[]){
    if(['completed_sale','cancelled','not_interested','duplicate'].includes(record.status))continue;
    const firstResponseDue=Date.parse(record.createdAt)+24*60*60*1000,followUp=record.followUpAt?Date.parse(record.followUpAt):NaN;
    const overdueFirst=['new_enquiry','awaiting_contact'].includes(record.status)&&firstResponseDue<current.getTime();
    const dueFollow=Number.isFinite(followUp)&&followUp<=dayEnd&&followUp>=current.getTime()-7*86400000;
    if(!overdueFirst&&!dueFollow)continue;
    const dueDate=overdueFirst?new Date(firstResponseDue).toISOString().slice(0,10):new Date(followUp).toISOString().slice(0,10),reason=overdueFirst?'first_response':'follow_up',key=`crm:${record.id}:${reason}:${dueDate}`;
    const copy={type:'deadline',importance:overdueFirst?'critical':'high',titleAr:overdueFirst?'استفسار ينتظر أول تواصل':'موعد متابعة عميل مستحق',titleEn:overdueFirst?'Enquiry awaiting first response':'Customer follow-up is due',descriptionAr:overdueFirst?'مرّ أكثر من 24 ساعة على الاستفسار دون بدء المتابعة.':'حان موعد المتابعة المسجل لهذا العميل.',descriptionEn:overdueFirst?'More than 24 hours passed without a first response.':'The scheduled customer follow-up is due.'};
    notifyRoles(['admin'],key,copy,{tabs:{admin:'crm'},targetId:record.id,targetKind:'crm'});
    notifyRoles(['marketing_manager'],key,copy,{tabs:{marketing_manager:'crm'},targetId:record.id,targetKind:'crm'});
    if(record.assignedUserId)notifyUser(record.assignedUserId,key,copy,{tab:'crm',targetId:record.id,targetKind:'crm'});
  }
  return (store.notifications?.[0]?.id||'')!==latestId;
}
function appendFinanceEntry(entry) {
  const key=clean(entry.idempotencyKey,180);
  if(key){const existing=store.financeLedger.find(row=>row.idempotencyKey===key);if(existing)return existing;}
  const row={id:id('fin'),postedAt:entry.postedAt||now(),currency:'ILS',idempotencyKey:key||null,amountCents:Number.isSafeInteger(entry.amountCents)?entry.amountCents:cents(entry.amount||0),...entry};
  delete row.amount;
  store.financeLedger.unshift(row);
  return row;
}
function syncLeadFinanceLedger(lead, actor=null) {
  for(const payment of store.payments.filter(row=>row.leadId===lead.id)){
    appendFinanceEntry({idempotencyKey:`payment:${payment.id}`,type:payment.kind==='refund'?'customer_refund':'customer_payment_received',leadId:lead.id,employeeId:null,amountCents:(payment.kind==='refund'?-1:1)*cents(payment.amount),note:payment.note||'',actor:payment.verifiedBy||actor?.username||'system',postedAt:payment.at||payment.createdAt||lead.createdAt});
  }
  const kinds=[
    {kind:'referral',userId:lead.referralUserId,amount:lead.commissionAmount,status:lead.commissionStatus,rate:lead.commissionRate,rank:lead.commissionRank},
    {kind:'developer',userId:lead.developerUserId,amount:lead.developerCommissionAmount,status:lead.developerCommissionStatus,rate:developerCommissionRate,rank:''}
  ];
  for(const item of kinds){
    if(!item.userId)continue;
    const entries=store.financeLedger.filter(row=>row.sourceKey===`commission:${lead.id}:${item.kind}`&&row.type==='commission_balance');
    const before=entries.reduce((sum,row)=>sum+row.amountCents,0),target=cents(item.amount||0);
    if(before!==target)appendFinanceEntry({type:'commission_balance',sourceKey:`commission:${lead.id}:${item.kind}`,idempotencyKey:null,leadId:lead.id,employeeId:item.userId,commissionKind:item.kind,amountCents:target-before,rateSnapshot:Number(item.rate||0),rankSnapshot:item.rank||'',statusSnapshot:item.status||'none',actor:actor?.username||'system',note:'Append-only commission balance adjustment'});
    const last=store.financeLedger.find(row=>row.sourceKey===`commission:${lead.id}:${item.kind}`&&row.type==='commission_status');
    if(!last||last.statusSnapshot!==(item.status||'none'))appendFinanceEntry({type:'commission_status',sourceKey:`commission:${lead.id}:${item.kind}`,leadId:lead.id,employeeId:item.userId,commissionKind:item.kind,amountCents:0,rateSnapshot:Number(item.rate||0),rankSnapshot:item.rank||'',statusSnapshot:item.status||'none',actor:actor?.username||'system'});
  }
}
function financeTreasuryFor(filters={}){
  const from=clean(filters.from,10),to=clean(filters.to,10),employeeId=clean(filters.employeeId,100),service=clean(filters.service,80),leadId=clean(filters.leadId,100);
  const dateOk=value=>{const day=String(value||'').slice(0,10);return (!from||day>=from)&&(!to||day<=to);};
  const scopedLeads=store.leads.filter(lead=>(!employeeId||lead.referralUserId===employeeId||lead.developerUserId===employeeId)&&(!service||lead.service===service)&&(!leadId||lead.id===leadId)&&dateOk(lead.createdAt));
  const ids=new Set(scopedLeads.map(lead=>lead.id));
  const scopedPayments=store.payments.filter(payment=>(!leadId||payment.leadId===leadId)&&(!service||ids.has(payment.leadId))&&(!employeeId||ids.has(payment.leadId))&&dateOk(payment.at||payment.createdAt));
  const collected=money(scopedPayments.reduce((sum,payment)=>sum+(payment.kind==='refund'?-1:1)*Number(payment.amount||0),0));
  const receivable=money(scopedLeads.filter(lead=>lead.status!=='cancelled'&&!lead.isDuplicate).reduce((sum,lead)=>sum+Math.max(0,Number(lead.contractAmount||0)-Number(lead.paidTotal||0)),0));
  const referral=money(scopedLeads.reduce((sum,lead)=>sum+Number(lead.commissionAmount||0),0));
  const developer=money(scopedLeads.reduce((sum,lead)=>sum+Number(lead.developerCommissionAmount||0),0));
  const expenses=money(store.expenses.filter(item=>(!employeeId||item.employeeId===employeeId)&&(!service||item.service===service)&&(!leadId||item.leadId===leadId)&&dateOk(item.date||item.createdAt)).reduce((sum,item)=>sum+Number(item.amount||0),0));
  const scopedWithdrawals=store.withdrawals.filter(item=>(!employeeId||item.userId===employeeId)&&dateOk(item.createdAt));
  const paidTransfers=money(scopedWithdrawals.filter(item=>item.status==='paid'&&(!(employeeId||service||leadId)||(item.commissionItems||[]).some(allocation=>ids.has(allocation.leadId)))).reduce((sum,item)=>sum+Number(item.amount||0),0));
  const paidCommissions=money(scopedLeads.reduce((sum,lead)=>sum+Number(lead.commissionPaidAmount||0)+Number(lead.developerCommissionPaidAmount||0),0));
  const companyShare=money(collected-referral-developer),profit=money(companyShare-expenses),cash=money(collected-expenses-paidTransfers);
  return {currency:'ILS',orderCount:scopedLeads.length,orderValue:money(scopedLeads.filter(lead=>lead.status!=='cancelled'&&!lead.isDuplicate).reduce((sum,lead)=>sum+Number(lead.contractAmount||0),0)),collected,receivable,referralCommissions:referral,developerEntitlements:developer,employeePayables:money(Math.max(0,referral+developer-paidCommissions)),paidTransfers,expenses,companyShare,accountingProfit:profit,cashLiquidity:cash,ledger:store.financeLedger.filter(row=>(!employeeId||row.employeeId===employeeId||ids.has(row.leadId))&&(!leadId||row.leadId===leadId)&&dateOk(row.postedAt)).slice(0,250).map(row=>({...row})),expenseItems:store.expenses.filter(item=>(!employeeId||item.employeeId===employeeId||ids.has(item.leadId))&&(!service||item.service===service)&&(!leadId||item.leadId===leadId)&&dateOk(item.date||item.createdAt)).slice(0,100).map(item=>({...item}))};
}
const normalizeEmail = value => clean(value, 150).toLowerCase();
const normalizePhone = value => clean(value, 50).replace(/[^\d+]/g, '');
const isE164Phone = value => /^\+[1-9]\d{7,14}$/.test(String(value||''));
function internationalPhone(countryCode, localNumber, fallback='') {
  const rawFallback=normalizePhone(fallback);
  if(rawFallback&&isE164Phone(rawFallback))return rawFallback;
  const code=clean(countryCode,5).replace(/[^+\d]/g,'');
  const local=clean(localNumber,30).replace(/\D/g,'').replace(/^0+/, '');
  if(!/^\+[1-9]\d{0,2}$/.test(code)||local.length<5||local.length>12)return '';
  const result=`${code}${local}`;
  return isE164Phone(result)?result:'';
}
const crmStatuses=['new_enquiry','awaiting_contact','contacted','interested','follow_up','quote_pending','quote_sent','quote_accepted','official_order','completed_sale','not_interested','unresponsive','cancelled','duplicate'];
const crmStatusTitles={new_enquiry:'استفسار جديد',awaiting_contact:'بانتظار أول تواصل',contacted:'تم التواصل',interested:'مهتم',follow_up:'متابعة مطلوبة',quote_pending:'عرض سعر قيد التجهيز',quote_sent:'أُرسل عرض السعر',quote_accepted:'قُبل عرض السعر',official_order:'طلب مشروع رسمي',completed_sale:'مبيعة مكتملة',not_interested:'غير مهتم',unresponsive:'لم يستجب',cancelled:'ملغي',duplicate:'مكرر'};
function crmDuplicateCandidates({phone='',email='',excludeId='',orderId=''}={}){
  const normPhone=normalizePhone(phone).replace(/\D/g,''),normEmail=normalizeEmail(email),matches=[];
  for(const item of store.crmLeads||[]){if(item.id===excludeId||(orderId&&(item.orderIds||[]).includes(orderId)))continue;if((normPhone&&normalizePhone(item.phone).replace(/\D/g,'')===normPhone)||(normEmail&&normalizeEmail(item.email)===normEmail))matches.push({id:item.id,kind:'crm',createdAt:item.createdAt});}
  for(const lead of store.leads||[]){if(lead.id===orderId||(excludeId&&(store.crmLeads.find(row=>row.id===excludeId)?.orderIds||[]).includes(lead.id)))continue;if((normPhone&&normalizePhone(lead.clientWhatsappPhone||lead.phone).replace(/\D/g,'')===normPhone)||(normEmail&&normalizeEmail(lead.email)===normEmail))matches.push({id:lead.id,kind:'order',createdAt:lead.createdAt});}
  return matches.slice(0,20);
}
function ensureCrmCaseForOrder(lead){
  store.crmLeads??=[];
  let record=store.crmLeads.find(row=>row.orderIds?.includes(lead.id)||row.id===lead.crmLeadId);
  if(!record){
    record={id:id('crm'),name:lead.name||'',phone:lead.clientWhatsappPhone||lead.phone||'',email:lead.email||'',service:lead.service||'',category:lead.category||'',templateId:lead.templateId||'',templateName:lead.templateName||'',conversationId:lead.conversationId||null,details:lead.details||'',source:lead.source||(lead.referralCode?'referral':'website'),referralUserId:lead.referralUserId||null,referralCode:lead.referralCode||'',referralLinkId:lead.referralLinkId||null,createdAt:lead.createdAt||now(),updatedAt:now(),status:crmStatusForOrder(lead),assignedUserId:lead.orderManagerUserId||'',followUpAt:'',orderIds:[lead.id],notes:[],history:[{kind:'order_linked',status:crmStatusForOrder(lead),by:'system',at:lead.createdAt||now(),note:'CRM record linked to the existing project request.'}]};
    record.duplicateCandidates=crmDuplicateCandidates({phone:record.phone,email:record.email,orderId:lead.id}).map(row=>({id:row.id,kind:row.kind}));store.crmLeads.unshift(record);
  }else if(!record.orderIds.includes(lead.id)){record.orderIds.push(lead.id);record.updatedAt=now();}
  lead.crmLeadId=record.id;return record;
}
function crmStatusForOrder(lead){
  if(lead.isDuplicate)return 'duplicate';
  if(lead.status==='cancelled')return 'cancelled';
  if(lead.status==='completed'&&Number(lead.contractAmount)>0&&Number(lead.paidTotal)>=Number(lead.contractAmount)&&!lead.refunded&&!lead.isDuplicate)return 'completed_sale';
  if(lead.refunded)return 'cancelled';
  if(lead.quoteAcceptedAt)return 'quote_accepted';
  if(lead.status==='proposal')return lead.quoteSentAt?'quote_sent':'quote_pending';
  if(lead.status!=='new')return 'official_order';
  return 'official_order';
}
function notifyCrmStageChange(record,actor=null){
  const copyByStatus={quote_pending:['عرض سعر مطلوب لعميل CRM','CRM customer needs a quote','نُقل العميل إلى مرحلة تجهيز عرض السعر.','A customer moved to quote preparation.'],quote_sent:['تم إرسال عرض سعر لعميل CRM','A CRM customer received a quote','سُجل إرسال عرض السعر في مسار العميل.','A quote was marked as sent in the customer journey.'],quote_accepted:['قبل العميل عرض السعر','Customer accepted the quote','قُبل عرض السعر في الطلب المرتبط.','A quote was accepted on the linked project request.'],official_order:['تحول عميل CRM إلى طلب رسمي','CRM customer converted to project order','ارتبط سجل العميل بطلب مشروع رسمي قائم.','A formal project request is linked to this customer.'],completed_sale:['اكتملت مبيعة مرتبطة بـ CRM','CRM linked sale completed','اكتمل المشروع المرتبط وتم التحقق من الدفع المؤهل.','The linked project is complete and eligible payment was verified.']};
  const copy=copyByStatus[record.status];if(!copy)return;
  const key=`crm:stage:${record.id}:${record.status}:${record.updatedAt}`,notice={type:'inquiry',importance:record.status==='completed_sale'?'high':'normal',titleAr:copy[0],titleEn:copy[1],descriptionAr:copy[2],descriptionEn:copy[3]};
  notifyRoles(['admin','marketing_manager'],key,notice,{excludeUserId:actor?.id,tabs:{admin:'crm',marketing_manager:'crm'},targetId:record.id,targetKind:'crm'});
  if(record.status==='completed_sale'&&record.referralUserId)notifyUser(record.referralUserId,key,{...notice,importance:'normal',descriptionAr:'اكتمل الطلب المرتبط بإحالتك؛ تُعرض العمولة المؤهلة في مساحتك.',descriptionEn:'A project from your referral is complete; eligible commission appears in your workspace.'},{tab:'referral',targetId:record.id,targetKind:'crm'});
}
function syncCrmCaseForOrder(lead,actor=null){
  const record=ensureCrmCaseForOrder(lead),status=crmStatusForOrder(lead);if(record.status!==status){record.status=status;record.updatedAt=now();record.history??=[];record.history.unshift({kind:'order_status',status,by:actor?.username||'system',at:record.updatedAt,note:`Existing project request ${lead.id} changed to ${lead.status}.`});record.history=record.history.slice(0,100);notifyCrmStageChange(record,actor);}
  return record;
}
function crmRecordForViewer(record){
  const orders=(record.orderIds||[]).map(orderId=>store.leads.find(row=>row.id===orderId)).filter(Boolean).map(lead=>({id:lead.id,status:lead.status,service:lead.service,category:lead.category,createdAt:lead.createdAt,contractAmount:lead.contractAmount,paidTotal:lead.paidTotal,quoteAccepted:Boolean(lead.quoteAcceptedAt),referralUserId:lead.referralUserId||null,referralName:store.users.find(user=>user.id===lead.referralUserId)?.name||'',referralCode:lead.referralCode||'',isDuplicate:Boolean(lead.isDuplicate)}));
  const assigned=store.users.find(row=>row.id===record.assignedUserId);
  const referrer=store.users.find(row=>row.id===record.referralUserId);
  return {...record,orders,assignedName:assigned?.name||'',referrerName:referrer?.name||'',whatsappUrl:!STAGING_MODE&&isE164Phone(record.phone)?`https://wa.me/${record.phone.replace(/\D/g,'')}`:''};
}
function crmAccess(user,record){return user?.role==='admin'||hasPermission(user,'orders.manage',{assigneeId:record?.assignedUserId||'',ownerId:record?.referralUserId||'',department:'orders'});}
function crmAggregate(records,{from='',to='',service=''}={}){
  const count=status=>records.filter(row=>row.status===status).length;
  const sales=new Set(records.filter(row=>row.status==='completed_sale').flatMap(row=>row.orderIds||[]));
  const fromTime=from?Date.parse(`${from}T00:00:00.000Z`):-Infinity,toTime=to?Date.parse(`${to}T23:59:59.999Z`):Infinity,referralUsers=new Set(records.map(row=>row.referralUserId).filter(Boolean));let events=store.referralEvents.filter(event=>referralUsers.has(event.userId)&&!event.reversedAt&&Date.parse(event.createdAt)>=fromTime&&Date.parse(event.createdAt)<=toTime);if(service)events=events.filter(event=>(event.type==='service_view'||event.type==='whatsapp_click')&&event.resourceId===service||event.type==='template_view'&&templateById.get(event.resourceId)?.service===service);const types=type=>events.filter(event=>event.type===type).length;
  const responseMinutes=records.map(row=>{const first=(row.history||[]).find(item=>item.kind==='status_changed'&&['contacted','interested','follow_up'].includes(item.status));return first?Math.max(0,(Date.parse(first.at)-Date.parse(row.createdAt))/60000):null;}).filter(Number.isFinite);
  const services={};for(const row of records)if(row.service)services[row.service]=(services[row.service]||0)+1;
  const requests=new Set(records.flatMap(row=>row.orderIds||[]));
  return {total:records.length,visits:new Set(events.filter(event=>service?['service_view','template_view','whatsapp_click'].includes(event.type):event.type==='visit').map(event=>event.visitorHash).filter(Boolean)).size,serviceViews:types('service_view'),templateViews:types('template_view'),whatsappClicks:types('whatsapp_click'),confirmedEnquiries:records.filter(row=>row.status!=='duplicate'&&!row.mergedInto).length,newEnquiries:count('new_enquiry'),awaitingContact:records.filter(row=>['awaiting_contact','new_enquiry'].includes(row.status)).length,followUps:records.filter(row=>row.status==='follow_up'&&row.followUpAt).length,quotes:records.filter(row=>['quote_pending','quote_sent','quote_accepted'].includes(row.status)).length,quoteAcceptances:types('quote_accepted'),orders:requests.size,sales:sales.size,conversionRate:requests.size?Math.round(sales.size/requests.size*1000)/10:0,averageFirstResponseMinutes:responseMinutes.length?Math.round(responseMinutes.reduce((sum,value)=>sum+value,0)/responseMinutes.length):null,topServices:Object.entries(services).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([service,count])=>({service,count})),duplicates:records.filter(row=>row.duplicateCandidates?.length||row.status==='duplicate').length,overdueFollowUps:records.filter(row=>row.followUpAt&&Date.parse(row.followUpAt)<Date.now()&&!['completed_sale','cancelled','not_interested','duplicate'].includes(row.status)).length};
}
function crmSummaryFor(user){
  let records=store.crmLeads||[];
  if(user?.role==='marketer'||user?.role==='developer')records=records.filter(row=>row.referralUserId===user.id);
  if(user?.role==='hr_manager')return {...crmAggregate(records),privacy:'aggregate_only'};
  return crmAggregate(records);
}
function clientProfile(user){
  return {id:user.id,name:user.name,email:user.email||'',phone:user.phone||'',student:Boolean(user.student),university:user.student?user.university||'':'',emailVerified:Boolean(user.emailVerified),createdAt:user.createdAt};
}
function referralForRequest(req, body={}){
  const visitor=referralAttributionForVisitor(clean(body.referralVisitorId,80));
  const code=visitor?.code||clean(cookieValue(req,'zezo_ref'),40)||clean(body.referralCode,40);
  if(visitor){const resolved=referralLinkForCode(visitor.code);return resolved?{...resolved,link:resolved.link||null}:null;}
  const resolved=code?referralLinkForCode(code):null;
  return resolved?{...resolved,code,link:resolved.link}:null;
}
function bindClientReferral(user, attribution){
  if(user.referralUserId||!attribution?.user?.id)return false;
  if(attribution.user.id===user.id||normalizeEmail(attribution.user.email)===normalizeEmail(user.email))return false;
  user.referralUserId=attribution.user.id;user.referralCode=attribution.code||attribution.user.currentReferralCode||attribution.user.referralCode;
  user.referralLinkId=attribution.link?.id||null;user.referralBoundAt=now();return true;
}
const emailReady = () => !STAGING_MODE && Boolean(process.env.RESEND_API_KEY && process.env.ZEZO_FROM_EMAIL);
const adminEmailReady = () => !STAGING_MODE && Boolean(process.env.ZEZO_NOTIFICATION_EMAIL);
function requestIsSecure(req) {
  if (req.socket?.encrypted) return true;
  return STAGING_MODE && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}
function siteBase(req) {
  const configured = STAGING_MODE ? '' : String(process.env.ZEZO_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (configured && /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(configured)) return configured;
  const host = String(req.headers.host || 'localhost').toLowerCase();
  return `${requestIsSecure(req) ? 'https' : 'http'}://${/^[a-z0-9.-]+(?::\d+)?$/.test(host) ? host : 'localhost'}`;
}
async function processMailQueue() {
  if (STAGING_MODE || !emailReady() || store.mailQueue.some(item => item.state === 'sending')) return;
  for (const item of [...store.mailQueue].reverse()) {
    if (!['pending','retry'].includes(item.state) || item.attempts >= 5) continue;
    const recipient = item.recipientType === 'admin' ? process.env.ZEZO_NOTIFICATION_EMAIL : item.to;
    if (!recipient) continue;
    item.state = 'sending'; item.attempts += 1; item.lastAttemptAt = now();
    await persist();
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(12000),
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': item.id },
        body: JSON.stringify({ from: process.env.ZEZO_FROM_EMAIL, to: recipient, subject: item.subject, text: item.text })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `Email provider returned ${response.status}`);
      item.state = 'sent'; item.sentAt = now(); item.providerId = clean(result.id, 120); item.lastError = '';
    } catch (error) {
      item.state = item.attempts >= 5 ? 'failed' : 'retry';
      item.lastError = clean(error.message, 220);
    }
    await persist();
  }
}
async function queueMail({ to = '', recipientType = 'direct', subject, text, kind }) {
  const safeText=String(text??'').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,6000);
  const item = { id: id('mail'), createdAt: now(), kind: clean(kind, 50), to: clean(to, 150), recipientType, subject: clean(subject, 180), text: safeText, state: 'pending', attempts: 0, lastError: '' };
  store.mailQueue.unshift(item); store.mailQueue = store.mailQueue.slice(0, 1000);
  await persist();
  void processMailQueue();
  return item;
}
function fallbackQuote(brief) {
  const text=String(brief||'').toLowerCase();
  if(/تحليل|مراجعة مجانية|افحص|audit|review my site|analy[sz]e/.test(text)) return 'FREE_AUDIT';
  if(/صفحة|landing|landing page|هبوط/.test(text)&&/متجر|دفع|حجز|عضوية|لوحة|دخول|تطبيق|app|store|dashboard|payment/.test(text)) return 'SCOPE';
  if(/صفحة هبوط بسيطة|landing page|صفحة واحدة|one page|صفحة تعريف|basic landing/.test(text)) return 'BASIC';
  if(/تصميم مخصص|مخصصة|custom landing|خمسة أقسام|5 sections/.test(text)) return 'CUSTOM';
  if(/متجر|تطبيق|app|e-commerce|payment gateway|دفع إلكتروني/.test(text)) return 'SCOPE';
  return 'SCOPE';
}
async function generateQuote(brief, language='ar') {
  let choice=fallbackQuote(brief), aiActive=false;
  if(!STAGING_MODE&&process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL){
    try{
      const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:AbortSignal.timeout(12000),headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL,store:false,instructions:'Choose exactly one package ID from this fixed list and output only that ID: BASIC = a simple single landing page with up to 3 sections; CUSTOM = a custom single landing page with up to 5 sections; FREE_AUDIT = a short free website review; SCOPE = any website store, application, integration, or request that needs a custom quote. Never invent prices or scope. Use only the client brief.',input:String(brief).slice(0,800),max_output_tokens:20})});
      const data=await response.json().catch(()=>({}));
      if(response.ok){const outputText=data.output_text||(Array.isArray(data.output)?data.output.flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join(' '):'');const answer=String(outputText||'').trim().toUpperCase();const match=/\b(BASIC|CUSTOM|FREE_AUDIT|SCOPE)\b/.exec(answer);if(match){choice=match[1];aiActive=true;}}
    }catch{}
  }
  const packages={
    BASIC:{id:'landing-basic',price:150,nameAr:'صفحة هبوط أساسية',nameEn:'Basic landing page',descriptionAr:'قالب جاهز حتى ٣ أقسام، وزر تواصل، مع تعديل واحد. العميل يزوّدنا بالنصوص والصور.',descriptionEn:'Starter template with up to 3 sections, a contact button, and one revision. Client supplies copy and images.'},
    CUSTOM:{id:'landing-custom',price:300,nameAr:'صفحة هبوط مخصصة',nameEn:'Custom landing page',descriptionAr:'تصميم مخصص حتى ٥ أقسام، مع زر تواصل أو نموذج طلب، وتعديل واحد.',descriptionEn:'Custom design with up to 5 sections, a contact button or enquiry form, and one revision.'},
    FREE_AUDIT:{id:'free-audit',price:0,nameAr:'تحليل سريع مجاني',nameEn:'Free quick review',descriptionAr:'تحليل أولي مختصر لصفحة واحدة. لا يشمل إعادة تصميم أو تنفيذ التعديلات.',descriptionEn:'A brief first review of one page. Redesign and implementation are not included.'},
    SCOPE:{id:'custom-quote',price:null,nameAr:'عرض سعر حسب النطاق',nameEn:'Custom scoped quote',descriptionAr:'الطلب يحتاج مراجعة نطاق قبل تحديد السعر؛ المتاجر والتطبيقات لا تدخل بباقات صفحات الهبوط.',descriptionEn:'The scope needs review before pricing. Stores and apps are outside landing page packages.'}
  };
  const pack=packages[choice]||packages.SCOPE;
  return {packageId:pack.id,price:pack.price,name:language==='en'?pack.nameEn:pack.nameAr,description:language==='en'?pack.descriptionEn:pack.descriptionAr,aiActive};
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers, ...(STAGING_MODE ? { 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet' } : {}) });
  res.end(JSON.stringify(data));
}
function cookieValue(req, key) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [name, ...val] = part.trim().split('=');
    if (name === key) return decodeURIComponent(val.join('='));
  }
  return '';
}
function stagingAuthorized(req) {
  if (!STAGING_MODE) return true;
  const sessionId = cookieValue(req, 'zezo_staging_access');
  const session = stagingSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) { if (sessionId) stagingSessions.delete(sessionId); return false; }
  return true;
}
function stagingLoginPage(message = '') {
  return '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>دخول بيئة اختبار ZEZO</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070a;color:#edf3ff;font-family:Segoe UI,Tahoma,Arial,sans-serif;padding:24px}.card{width:min(100%,430px);padding:34px;border:1px solid #233149;background:linear-gradient(145deg,#0d1521,#080b10);box-shadow:0 24px 80px #0009}.brand{color:#a3ff12;font-size:12px;letter-spacing:.2em;font-weight:800}.planet{color:#0066ff}.eyebrow{margin:28px 0 8px;color:#91a1b8;font-size:12px;letter-spacing:.08em}.card h1{margin:0 0 10px;font-size:28px}.card p{margin:0 0 24px;color:#9ba9bb;line-height:1.8;font-size:14px}label{display:block;font-size:13px;margin-bottom:9px}input{width:100%;height:48px;border:1px solid #31415a;background:#05070a;color:#fff;padding:0 14px;font-size:16px;direction:ltr;text-align:left}input:focus{outline:2px solid #0066ff;border-color:transparent}button{width:100%;margin-top:16px;height:48px;border:0;background:#a3ff12;color:#071006;font-weight:800;font-size:14px;cursor:pointer}button:hover{filter:brightness(1.06)}.error{padding:10px 12px;margin:0 0 16px;border:1px solid #743d43;color:#ffb5bb;background:#35151a;font-size:13px}.foot{margin-top:22px!important;margin-bottom:0!important;font-size:11px!important;color:#728099!important}</style><main class="card"><div class="brand">ZEZO<span class="planet">.</span> / STAGING</div><div class="eyebrow">PRIVATE TEST ENVIRONMENT</div><h1>دخول بيئة الاختبار</h1><p>أدخل كلمة المرور التي ظهرت في نافذة تشغيل ZEZO على جهازك.</p>' + (message ? '<div class="error" role="alert">' + message + '</div>' : '') + '<form method="post" action="/__staging/login"><label for="password">كلمة مرور المعاينة</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required autofocus><button type="submit">دخول آمن ↗</button></form><p class="foot">بيانات تجريبية مستقلة. لا تستخدم بيانات حقيقية.</p></main></html>';
}
const cookie = (key, value, maxAge, req) => `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${requestIsSecure(req) ? '; Secure' : ''}`;
function sessionUser(req) {
  const sid = cookieValue(req, 'zezo_session');
  const session = sessions.get(sid);
  if (!session || session.expires < Date.now()) { if (sid) sessions.delete(sid); return null; }
  const user = store.users.find(u => u.id === session.userId && u.active);
  return user ? { user, sid } : null;
}
function requireAuth(req, res, allowed = allRoles) {
  const auth = sessionUser(req);
  if (!auth) { json(res, 401, { error: 'سجّل الدخول للمتابعة / Please sign in to continue' }); return null; }
  const route = new URL(req.url, 'http://localhost').pathname;
  if (auth.user.mustChangePassword && !['/api/auth/password','/api/auth/logout'].includes(route)) { json(res, 428, { error:'غيّر كلمة المرور المؤقتة أولاً / Change the temporary password first', mustChangePassword:true }); return null; }
  if (sensitiveManagementRole(auth.user.role) && !auth.user.mfaEnabledAt && !['/api/auth/mfa/setup','/api/auth/mfa/enable','/api/auth/password','/api/auth/logout'].includes(route)) { json(res, 428, { error:'أكمل إعداد التحقق بخطوتين قبل استخدام مساحة الإدارة / Complete two-step verification setup before using the management workspace', mfaSetupRequired:true }); return null; }
  if (!allowed.includes(auth.user.role)) { json(res, 403, { error: 'ليس لديك صلاحية لهذه العملية / Not permitted' }); return null; }
  return auth;
}
async function bodyBuffer(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) throw Object.assign(new Error('حجم الطلب أكبر من المسموح (6MB)'), { status: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('حجم الطلب أكبر من المسموح (6MB)'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  const buf = await bodyBuffer(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('صيغة البيانات غير صالحة / Invalid request data'), { status: 400 }); }
}
function parseMultipart(buf, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw Object.assign(new Error('طلب الملف غير صالح'), { status: 400 });
  const marker = Buffer.from(`--${boundary}`); const fields = {}; let file = null; let cursor = 0;
  while (true) {
    const start = buf.indexOf(marker, cursor);
    if (start < 0) break;
    const after = start + marker.length;
    if (buf.subarray(after, after + 2).toString() === '--') break;
    let partStart = after;
    if (buf.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), partStart);
    const next = buf.indexOf(marker, headerEnd + 4);
    if (headerEnd < 0 || next < 0) break;
    const headers = buf.subarray(partStart, headerEnd).toString('utf8');
    let end = next;
    if (buf.subarray(end - 2, end).toString() === '\r\n') end -= 2;
    const content = buf.subarray(headerEnd + 4, end);
    const disposition = /content-disposition:\s*form-data;[^\r\n]*/i.exec(headers)?.[0] || '';
    const fieldName = /name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (fieldName && filename) { if (filename && content.length) file = { fieldName, filename: basename(filename), content, contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || 'application/octet-stream' }; }
    else if (fieldName) fields[fieldName] = content.toString('utf8');
    cursor = next;
  }
  return { fields, file };
}
function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, passwordHash: scryptSync(password, salt, 64).toString('hex') };
}
function passwordMatches(password, user) {
  try { return timingSafeEqual(Buffer.from(scryptSync(password, user.salt, 64).toString('hex'), 'hex'), Buffer.from(user.passwordHash, 'hex')); }
  catch { return false; }
}
const base32Alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer){let bits=0,value=0,out='';for(const byte of buffer){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=base32Alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=base32Alphabet[(value<<(5-bits))&31];return out;}
function base32Decode(input){let bits=0,value=0,out=[];for(const char of String(input||'').toUpperCase().replace(/=+$/,'')){const index=base32Alphabet.indexOf(char);if(index<0)continue;value=(value<<5)|index;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
function totpCode(secret,step=Math.floor(Date.now()/30_000)){
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const digest=createHmac('sha1',base32Decode(secret)).update(counter).digest(),offset=digest[digest.length-1]&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1_000_000).padStart(6,'0');
}
function validTotp(secret,code){
  if(!secret||!/^\d{6}$/.test(String(code||'')))return false;const current=Math.floor(Date.now()/30_000),candidate=Buffer.from(String(code));
  for(let drift=-1;drift<=1;drift++){const expected=Buffer.from(totpCode(secret,current+drift));if(candidate.length===expected.length&&timingSafeEqual(candidate,expected))return true;}return false;
}
const sensitiveManagementRole=role=>['admin','marketing_manager','hr_manager','order_manager'].includes(role);
function effectivePermission(user,key){
  if(user?.role==='admin')return 'all';
  const value=user?.permissionOverrides&&Object.hasOwn(user.permissionOverrides,key)?user.permissionOverrides[key]:defaultRolePermissions[user?.role]?.[key];
  if(value===true)return 'all';if(value===false||value==null)return 'none';return String(value);
}
function permissionEnabled(user,key){return user?.role==='admin'||Boolean(permissionDefinitions[key]?.includes(effectivePermission(user,key)));}
function roleDepartment(role){return role==='order_manager'?'orders':role==='hr_manager'?'people':role==='marketing_manager'||role==='marketer'?'marketing':role==='developer'?'development':'';}
function hasPermission(user,key,resource={}){
  if(user?.role==='admin')return true;
  const scope=effectivePermission(user,key);if(!permissionDefinitions[key]?.includes(scope))return false;
  if(scope==='all')return true;
  if(scope==='own')return resource.ownerId===user.id;
  if(scope==='assigned')return resource.assigneeId===user.id;
  if(scope==='department')return key==='employees.read'&&user.role==='hr_manager'?resource.department!=='owner':resource.department===user.department||(!user.department&&resource.department===roleDepartment(user.role));
  return false;
}
function requirePermission(auth,res,key,resource={}){
  if(!auth)return false;
  if(!hasPermission(auth.user,key,resource)){json(res,403,{error:'لا تملك الصلاحية أو نطاق الوصول لهذه البيانات / You do not have permission or scope for this data'},{'Cache-Control':'no-store'});return false;}
  return true;
}
function conversationAccess(user,conversation,permission='conversations.read'){
  if(!user||!conversation)return false;
  if(user.role==='client')return conversation.clientId===user.id;
  return hasPermission(user,permission,{assigneeId:conversation.assignedUserId||'',ownerId:conversation.clientId||'',department:conversation.department||'orders'});
}
function conversationAssigneesFor(user){
  if(!user||!hasPermission(user,'conversations.assign',{department:'orders'}))return [];
  return store.users.filter(row=>row.active&&!row.accountDisabledAt&&row.role!=='admin'&&hasPermission(row,'conversations.read',{assigneeId:row.id,department:'orders'})).map(row=>({id:row.id,name:row.name,role:row.role,active:true}));
}
function safeConversation(conversation,includeContact=false){
  const client=conversation.clientId?store.users.find(user=>user.id===conversation.clientId&&user.role==='client'):null;
  let attachmentIndex=0;
  return {id:conversation.id,createdAt:conversation.createdAt,updatedAt:conversation.updatedAt,templateId:conversation.templateId,templateName:conversation.templateName,templateService:conversation.templateService,templateCategory:conversation.templateCategory,source:conversation.source||'website',referralCode:conversation.referralCode||'',referralLinkId:conversation.referralLinkId||null,referralUserId:conversation.referralUserId||null,clientId:conversation.clientId||null,clientName:client?.name||'',clientEmail:includeContact?(client?.email||''):undefined,status:conversation.status,department:conversation.department,assignedUserId:conversation.assignedUserId||'',assignedUserName:store.users.find(user=>user.id===conversation.assignedUserId)?.name||'',leadId:conversation.leadId||null,conversionRequested:Boolean(conversation.conversionRequestedAt),quote:conversation.quote||null,agreedPriceSnapshot:conversation.agreedPriceSnapshot||null,messages:(conversation.messages||[]).map(message=>({id:message.id,senderType:message.senderType,senderName:message.senderType==='staff'?(store.users.find(user=>user.id===message.senderId)?.name||'ZEZO'):message.senderType==='client'?(client?.name||'Client'):'ZEZO visitor',text:message.text,createdAt:message.createdAt,attachments:(message.attachments||[]).map(file=>({index:attachmentIndex++,name:file.originalName,size:file.size}))}))};
}
function guestSessionValue(req){const value=cookieValue(req,'zezo_guest');return /^[A-Za-z0-9_-]{32,100}$/.test(value)?value:'';}
function customerCanSeeConversation(req,auth,conversation){
  if(auth?.user.role==='client')return conversation.clientId===auth.user.id||Boolean(guestSessionValue(req)&&conversation.guestSessionHash===hash(guestSessionValue(req)));
  if(auth)return conversationAccess(auth.user,conversation,'conversations.read');
  const guest=guestSessionValue(req);return Boolean(guest&&conversation.guestSessionHash===hash(guest));
}
function appendConversationMessage(conversation,{senderType,senderId='',text='',attachment=null}){
  const message={id:id('msg'),senderType,senderId:senderId||null,text:clean(text,2000),createdAt:now(),attachments:attachment?[attachment]:[]};
  conversation.messages??=[];conversation.messages.push(message);conversation.updatedAt=message.createdAt;return message;
}
function notifyConversation(conversation,kind,actor=null){
  const key=`conversation:${conversation.id}:${kind}:${conversation.updatedAt}`;
  const copy=kind==='created'?{type:'inquiry',importance:'high',titleAr:'محادثة قالب جديدة',titleEn:'New template conversation',descriptionAr:`وصل استفسار حول ${conversation.templateName}. عيّن مسؤول متابعة للرد.`,descriptionEn:`A new enquiry arrived for ${conversation.templateName}. Assign an owner to reply.`}:{type:'inquiry',importance:'normal',titleAr:'رسالة جديدة في محادثة قالب',titleEn:'New message in template conversation',descriptionAr:`توجد رسالة جديدة في محادثة ${conversation.templateName}.`,descriptionEn:`There is a new message in the ${conversation.templateName} conversation.`};
  if(actor?.role==='client'||!actor){notifyRoles(['admin','order_manager'],key,copy,{excludeUserId:actor?.id||'',tabs:{admin:'conversations',order_manager:'conversations'},targetId:conversation.id,targetKind:'conversation'});if(conversation.assignedUserId)notifyUser(conversation.assignedUserId,key,copy,{tab:'conversations',targetId:conversation.id,targetKind:'conversation'});}
  else if(conversation.clientId)notifyUser(conversation.clientId,key,{...copy,titleAr:'رد فريق ZEZO على محادثتك',titleEn:'ZEZO replied to your conversation',descriptionAr:'افتح المحادثة لمتابعة الرد.',descriptionEn:'Open the conversation to read the reply.'},{tab:'conversations',targetId:conversation.id,targetKind:'conversation'});
}
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 200; }
function validTemporaryPassword(value) { return typeof value === 'string' && value.length >= 9 && value.length <= 200; }
function rateAllowed(key) {
  const item = loginAttempts.get(key);
  if (!item || item.until < Date.now()) { loginAttempts.set(key, { count: 1, until: Date.now() + 15 * 60_000 }); return true; }
  item.count += 1; return item.count <= 8;
}
function rateAllowedFor(map,key,max,windowMs) {
  const item=map.get(key);
  if(!item||item.until<Date.now()){map.set(key,{count:1,until:Date.now()+windowMs});return true;}
  item.count+=1;return item.count<=max;
}
function publicRateAllowed(key) {
  const item = leadAttempts.get(key);
  if (!item || item.until < Date.now()) { leadAttempts.set(key, { count: 1, until: Date.now() + 60 * 60_000 }); return true; }
  item.count += 1; return item.count <= 8;
}
function saveUpload(file) {
  if (!file) return Promise.resolve(null);
  const ext = extname(file.filename).toLowerCase();
  const allowed = { '.pdf': ['application/pdf', '%PDF-'], '.png': ['image/png', '\x89PNG'], '.jpg': ['image/jpeg', '\xff\xd8\xff'], '.jpeg': ['image/jpeg', '\xff\xd8\xff'], '.webp': ['image/webp', 'RIFF'] };
  const rule = allowed[ext];
  const prefix = rule ? file.content.subarray(0, Buffer.byteLength(rule[1])).toString('binary') : '';
  if (!rule || file.content.length > 4 * 1024 * 1024 || prefix !== rule[1]) return Promise.reject(Object.assign(new Error('الملف غير مدعوم أو يتجاوز 4MB / Unsupported file or over 4MB'), { status: 400 }));
  const storedName = `${randomBytes(18).toString('hex')}${ext}`;
  return writeFile(join(UPLOAD_DIR, storedName), file.content, { flag: 'wx', mode: 0o600 }).then(() => ({ storedName, originalName: clean(file.filename, 120), type: rule[0], size: file.content.length }));
}
function normalizedDetails(value) { return clean(value, 3000).toLowerCase().replace(/\s+/g, ' '); }
function findDuplicateLead(candidate) {
  const email = normalizeEmail(candidate.email), phone = normalizePhone(candidate.phone).replace(/\D/g, '');
  const details = normalizedDetails(candidate.details), cutoff = Date.now() - duplicateRequestWindowMs;
  if ((!email && phone.length < 8) || details.length < 12) return null;
  return store.leads.find(lead => {
    const created = new Date(lead.createdAt).getTime();
    const sameContact = (email && normalizeEmail(lead.email) === email) || (phone.length >= 8 && normalizePhone(lead.phone).replace(/\D/g, '') === phone);
    return lead.id !== candidate.excludeLeadId && !lead.isDuplicate && created >= cutoff && created <= Date.now() && sameContact && lead.service === candidate.service && lead.category === candidate.category && normalizedDetails(lead.details) === details;
  }) || null;
}
function qualifiedSales(userId) {
  return store.leads.filter(lead => lead.referralUserId === userId && !lead.isDuplicate && !lead.duplicateOfLeadId && !lead.refunded && lead.status === 'completed' && Number(lead.contractAmount) > 0 && Number(lead.paidTotal) >= Number(lead.contractAmount)).length;
}
function currentRankRate(user) {
  if (user.rank === 'team_leader') return Number(user.activeCommissionRate ?? 35);
  return marketerRankRates[user.rank] ?? 15;
}
function marketerRankSummary(user) {
  const rank = marketerRankOrder.includes(user.rank) ? user.rank : 'rookie';
  const index = marketerRankOrder.indexOf(rank), nextRank = marketerRankOrder[index + 1] || null;
  const count = qualifiedSales(user.id), threshold = nextRank ? marketerRankThresholds[nextRank] : null;
  const request = nextRank ? store.rankRequests.find(item => item.userId === user.id && item.targetRank === nextRank) : null;
  return { rank, commissionRate: currentRankRate(user), qualifiedSales: count, nextRank, nextThreshold: threshold, progressPercent: threshold ? Math.min(100, Math.round(count / threshold * 100)) : 100, requestStatus: request?.status || null, teamLeaderTermsPending: Boolean(user.teamLeaderTermsPending) };
}
function syncRankRequest(user) {
  if (!referralEnabled(user)) return null;
  const index = marketerRankOrder.indexOf(user.rank || 'rookie'), targetRank = marketerRankOrder[index + 1];
  if (!targetRank) return null;
  const sales = qualifiedSales(user.id), threshold = marketerRankThresholds[targetRank];
  const pending = store.rankRequests.find(item => item.userId === user.id && item.targetRank === targetRank && item.status === 'pending');
  if (pending) {
    if (sales < threshold) { pending.status = 'invalidated'; pending.updatedAt = now(); pending.note = 'Qualified sales fell below the threshold after a cancellation, refund, or duplicate review.'; audit(null, 'rank_request_invalidated', pending.id, `${sales}/${threshold} qualified sales`); }
    else return null;
  }
  if (sales < threshold) return null;
  const prior = store.rankRequests.find(item => item.userId === user.id && item.targetRank === targetRank);
  if (prior?.status === 'approved') return null;
  if (prior?.status === 'rejected' && sales <= Number(prior.salesAtRequest || 0)) return null;
  const request = { id:id('rank'), userId:user.id, username:user.username, name:user.name, fromRank:user.rank || 'rookie', targetRank, threshold, salesAtRequest:sales, status:'pending', createdAt:now(), updatedAt:now(), decidedBy:'', decidedAt:null, note:'' };
  store.rankRequests.unshift(request);
  audit(null, 'rank_promotion_requested', request.id, `${user.username}: ${request.fromRank} -> ${targetRank}; ${sales} qualified sales`);
  return request;
}
function syncAllRankRequests() {
  const created = [];
  for (const user of store.users) { const request = syncRankRequest(user); if (request) created.push(request); }
  return created;
}
async function queueRankRequestMail(request) {
  await queueMail({ recipientType:'admin', kind:'rank_promotion_requested', subject:`طلب ترقية مسوّق — ${request.name}`, text:`بلغ المسوّق ${request.name} مستوى ${marketerRankTitles[request.targetRank]}\nالرتبة الحالية: ${marketerRankTitles[request.fromRank]}\nالمبيعات المؤهلة مدى الحياة: ${request.salesAtRequest}\nالحد المطلوب: ${request.threshold}\nراجع الطلب واتخذ قرار الموافقة أو الرفض من لوحة ZEZO.` });
}
function safeLead(lead, revealContact = false) {
  return {
    id: lead.id, createdAt: lead.createdAt, name: revealContact ? lead.name : 'بيانات العميل محمية',
    email: revealContact ? lead.email : '', phone: revealContact ? (lead.clientWhatsappPhone||lead.phone) : '', whatsappUrl:!STAGING_MODE&&revealContact&&isE164Phone(lead.clientWhatsappPhone||lead.phone)?`https://wa.me/${(lead.clientWhatsappPhone||lead.phone).replace(/\D/g,'')}`:'',
    service: lead.service, category: lead.category, details: revealContact ? lead.details : '',
    budget: revealContact ? lead.budget : '', status: lead.status, contractAmount: lead.contractAmount,
    paymentStatus:Number(lead.paidTotal||0)<=0?'unpaid':Number(lead.paidTotal||0)<Number(lead.contractAmount||0)?'partial':'collected',
    balanceDue:money(Math.max(0,Number(lead.contractAmount||0)-Number(lead.paidTotal||0))),
    financeSettlement:revealContact?(lead.financeSettlement||null):undefined,
    financeSettlementReview:revealContact?(lead.financeSettlementReview||null):undefined,
    paidTotal: revealContact ? lead.paidTotal : undefined, commissionAmount: lead.commissionAmount,
    commissionStatus: lead.commissionStatus, commissionRate: revealContact ? lead.commissionRate : undefined,
    commissionRank: revealContact ? lead.commissionRank : undefined, isDuplicate: revealContact ? Boolean(lead.isDuplicate) : undefined,
    duplicateOfLeadId: revealContact ? lead.duplicateOfLeadId || null : undefined, referralCode: lead.referralCode, referralLinkId:lead.referralLinkId||null, quoteAcceptedAt:lead.quoteAcceptedAt||null,
    templateId: lead.templateId || '', templateName: lead.templateName || '', templateAction: lead.templateAction || '',
    publicStatusNote: lead.publicStatusNote || '',
    priceSnapshot:revealContact?(lead.priceSnapshot||null):undefined,
    agreedPriceSnapshot:revealContact?(lead.agreedPriceSnapshot||null):undefined,
    referralUserId:revealContact?(lead.referralUserId||''):undefined,
    projectCostTotal:revealContact?Number(lead.projectCostTotal||0):undefined,
    attachments: revealContact ? lead.attachments.map(a => ({ name: a.originalName, size: a.size })) : [],
    ...(revealContact ? {
      conversationId:lead.conversationId||null,source:lead.source||'website',orderManagerUserId:lead.orderManagerUserId||null,
      developerUserId:lead.developerUserId||'', developerName:store.users.find(u=>u.id===lead.developerUserId)?.name||'',
      developerTaskStatus:lead.developerTaskStatus||'', developerDueDate:lead.developerDueDate||'', developerTaskNote:lead.developerTaskNote||'',
      developerCommissionRate:developerCommissionRate, developerCommissionAmount:lead.developerCommissionAmount||0,
      developerCommissionStatus:lead.developerCommissionStatus||'none', developerReviewStatus:lead.developerReviewStatus||'',
      developerCommissionReview:lead.developerCommissionReview||null,
      developerAttachments:(lead.developerAttachments||[]).map(a=>({name:a.originalName,size:a.size})),
      projectStage:lead.projectStage||projectStageFromOrderStatus[lead.status]||'new_request',projectStartedAt:lead.projectStartedAt||'',projectDeliveredAt:lead.projectDeliveredAt||'',
      projectHistory:(lead.projectHistory||[]).map(item=>({stage:item.stage,at:item.at,by:item.by||'',note:item.note||''}))
    } : {})
  };
}
function safeOrderLead(lead, revealContact = false) {
  return {
    id:lead.id, createdAt:lead.createdAt, name:revealContact?lead.name:'بيانات العميل محمية', email:revealContact?lead.email:'', phone:revealContact?(lead.clientWhatsappPhone||lead.phone):'',
    whatsappUrl:!STAGING_MODE&&revealContact&&isE164Phone(lead.clientWhatsappPhone||lead.phone)?`https://wa.me/${(lead.clientWhatsappPhone||lead.phone).replace(/\D/g,'')}`:'',
    service:lead.service, category:lead.category, details:lead.details, budget:lead.budget,
    status:lead.status, contractAmount:lead.contractAmount, publicStatusNote:lead.publicStatusNote||'',
    templateId:lead.templateId||'', templateName:lead.templateName||'', templateAction:lead.templateAction||'',templatePriceSnapshot:lead.priceSnapshot?.amount??null,
    attachments:lead.attachments.map(a=>({name:a.originalName,size:a.size})),supportNotes:lead.supportNotes||[]
  };
}
function safeTechnicalLead(lead) {
  return { id:lead.id, createdAt:lead.createdAt, service:lead.service, category:lead.category, details:lead.details, status:lead.status, attachments:lead.attachments.map(a=>({name:a.originalName,size:a.size})) };
}
function safeDeveloperProject(lead) {
  return { id:lead.id, createdAt:lead.createdAt, service:lead.service, category:lead.category, requirements:lead.details, status:lead.status,
    templateId:lead.templateId||'',templateName:lead.templateName||'',projectStage:lead.projectStage||projectStageFromOrderStatus[lead.status]||'new_request',projectHistory:(lead.projectHistory||[]).map(item=>({stage:item.stage,at:item.at,note:item.note||''})),projectStartedAt:lead.projectStartedAt||'',
    contractAmount:lead.contractAmount, developerCommissionRate:developerCommissionRate,
    collectedAmount:money(Math.min(Number(lead.paidTotal||0),Number(lead.contractAmount||0))),expectedCommission:money(Number(lead.contractAmount||0)*developerCommissionRate/100), dueDate:lead.developerDueDate||'',
    taskStatus:lead.developerTaskStatus||'offered', taskNote:lead.developerTaskNote||'', reviewNote:lead.developerCommissionReview?.note||'',
    commissionAmount:money(lead.developerCommissionAmount||0), commissionStatus:lead.developerCommissionStatus||'pending',
    attachments:(lead.attachments||[]).map(a=>({name:a.originalName,size:a.size})),
    developerAttachments:(lead.developerAttachments||[]).map(a=>({name:a.originalName,size:a.size})) };
}
function safeClientOrder(lead){
  const canSeeDeliverables=lead.developerReviewStatus==='approved'&&['ready_delivery','waiting_client_review','delivered','completed'].includes(lead.projectStage||'');
  return {
    id:lead.id,createdAt:lead.createdAt,language:lead.language||'ar',name:lead.name,email:lead.email,phone:lead.clientWhatsappPhone||lead.phone||'',
    service:lead.service,category:lead.category,details:lead.details,budget:lead.budget||'',status:lead.status,publicStatusNote:lead.publicStatusNote||'',
    projectStage:lead.projectStage||projectStageFromOrderStatus[lead.status]||'new_request',projectHistory:(lead.projectHistory||[]).map(item=>({stage:item.stage,at:item.at,note:item.clientNote||''})),canConfirmDelivery:['ready_delivery','waiting_client_review'].includes(lead.projectStage||''),projectStartedAt:lead.projectStartedAt||'',dueDate:lead.developerDueDate||'',
    contractAmount:lead.contractAmount===null?null:Number(lead.contractAmount||0),quoteSentAt:lead.quoteSentAt||null,quoteAcceptedAt:lead.quoteAcceptedAt||null,
    templateId:lead.templateId||'',templateName:lead.templateName||'',templateAction:lead.templateAction||'',
    paymentStatus:Number(lead.paidTotal||0)<=0?'unpaid':Number(lead.paidTotal||0)<Number(lead.contractAmount||0)?'partial':'collected',
    paidTotal:Number(lead.paidTotal||0),balanceDue:money(Math.max(0,Number(lead.contractAmount||0)-Number(lead.paidTotal||0))),
    payments:store.payments.filter(payment=>payment.leadId===lead.id).map(payment=>({id:payment.id,at:payment.at||payment.createdAt,kind:payment.kind,amount:Number(payment.amount||0)})),
    history:(lead.statusHistory||[{status:lead.status,at:lead.createdAt,note:''}]).map(item=>({status:item.status,at:item.at,note:item.note||''})),
    files:[...(lead.attachments||[]).map(a=>({name:a.originalName,size:a.size,kind:'customer_upload'})),...(canSeeDeliverables?(lead.developerAttachments||[]).map((a,index)=>({name:a.originalName,size:a.size,kind:'deliverable',index})):[])],
    canAcceptQuote:lead.status==='proposal'&&Number.isFinite(Number(lead.contractAmount))&&Number(lead.contractAmount)>=0&&!lead.quoteAcceptedAt
  };
}
const publicStatusLabels = {
  new: { ar:'طلب جديد', en:'New request' }, review:{ ar:'قيد المراجعة', en:'Under review' },
  proposal:{ ar:'بانتظار عرض السعر', en:'Awaiting quote' }, waiting_customer_approval:{ ar:'بانتظار موافقتك على العرض', en:'Waiting for your quote approval' },
  waiting_payment:{ ar:'بانتظار الدفع', en:'Awaiting payment' }, active:{ ar:'قيد التنفيذ', en:'In progress' },
  technical_review:{ ar:'قيد المراجعة الفنية', en:'Technical review' }, ready_delivery:{ ar:'جاهز للتسليم', en:'Ready for delivery' },
  completed:{ ar:'مكتمل', en:'Complete' }, cancelled:{ ar:'ملغي', en:'Cancelled' }
};
function updateDeveloperCommission(lead) {
  lead.developerCommissionRate=developerCommissionRate;
  const wasEarned=Number(lead.developerCommissionAmount||0)>0;
  const eligible=Boolean(lead.developerUserId&&lead.developerReviewStatus==='approved'&&lead.projectStage==='completed'&&lead.status==='completed'&&lead.status!=='cancelled'&&!lead.isDuplicate&&Number(lead.paidTotal||0)>0);
  const collected=Math.min(Number(lead.paidTotal||0),Number(lead.contractAmount||0));
  const amount=eligible?money(collected*developerCommissionRate/100):0;
  lead.developerCommissionAmount=amount;
  lead.developerCommissionDebtRemaining=money(Math.max(0,Number(lead.developerCommissionPaidAmount||0)-Number(lead.developerCommissionOffsetAmount||0)-amount));
  if(lead.developerTaskStatus==='declined'&&!lead.developerCommissionPaidAmount){lead.developerCommissionStatus='none';return;}
  if(!lead.developerUserId){lead.developerCommissionStatus='none';return;}
  if(!eligible){
    lead.developerCommissionStatus=lead.developerCommissionDebtRemaining>0?'reversed':(wasEarned&&Number(lead.developerCommissionPaidAmount||0)>0?'reversed':'pending');
    return;
  }
  const unpaid=money(Math.max(0,amount-Number(lead.developerCommissionPaidAmount||0)));
  if(unpaid<=0){lead.developerCommissionStatus=lead.developerCommissionDebtRemaining>0?'reversed':'paid';return;}
  const holdDays=Math.max(0,Math.min(90,Number(store.settings.commissionHoldDays??14)));
  const holdStart=new Date(lead.developerCommissionHoldUntil||lead.developerReviewApprovedAt||lead.createdAt).getTime();
  lead.developerCommissionStatus=Date.now()>=holdStart+holdDays*86400000?'confirmed':'pending';
}
function outstandingDeveloperCommission(lead){return money(Math.max(0,Number(lead.developerCommissionAmount||0)-Number(lead.developerCommissionPaidAmount||0)));}
function developerCommissionDebt(userId){return money(store.leads.filter(lead=>lead.developerUserId===userId).reduce((sum,lead)=>sum+Number(lead.developerCommissionDebtRemaining||0),0));}
function walletFor(userId){
  const referrals=store.leads.filter(lead=>lead.referralUserId===userId),projects=store.leads.filter(lead=>lead.developerUserId===userId);
  const refPending=money(referrals.filter(lead=>lead.commissionStatus==='pending').reduce((sum,lead)=>sum+outstandingCommission(lead),0));
  const devPending=money(projects.filter(lead=>lead.developerCommissionStatus==='pending').reduce((sum,lead)=>sum+outstandingDeveloperCommission(lead),0));
  const refGross=money(referrals.filter(lead=>lead.commissionStatus==='confirmed'&&!lead.withdrawalId).reduce((sum,lead)=>sum+outstandingCommission(lead),0));
  const devGross=money(projects.filter(lead=>lead.developerCommissionStatus==='confirmed'&&!lead.developerWithdrawalId).reduce((sum,lead)=>sum+outstandingDeveloperCommission(lead),0));
  const refDebt=outstandingCommissionDebt(userId),devDebt=developerCommissionDebt(userId),debt=money(refDebt+devDebt);
  const activeWithdrawalStatuses=['pending','under_review','approved','awaiting_transfer','requested'];
  const requested=money(store.withdrawals.filter(item=>item.userId===userId&&activeWithdrawalStatuses.includes(item.status)).reduce((sum,item)=>sum+Number(item.amount||0),0));
  const paid=money(store.withdrawals.filter(item=>item.userId===userId&&item.status==='paid').reduce((sum,item)=>sum+Number(item.amount||0),0));
  const refPaid=money(store.withdrawals.filter(item=>item.userId===userId&&item.status==='paid').reduce((sum,item)=>sum+Number(item.referralAmount||0),0));
  const devPaid=money(store.withdrawals.filter(item=>item.userId===userId&&item.status==='paid').reduce((sum,item)=>sum+Number(item.developerAmount||0),0));
  return {pending:money(refPending+devPending),confirmed:money(Math.max(0,refGross+devGross-debt)),requested,paid,debt,
    referral:{pending:refPending,available:money(Math.max(0,refGross-refDebt)),reserved:money(store.withdrawals.filter(item=>item.userId===userId&&activeWithdrawalStatuses.includes(item.status)).reduce((sum,item)=>sum+Number(item.referralAmount||0),0)),paid:refPaid},
    developer:{pending:devPending,available:money(Math.max(0,devGross-devDebt)),reserved:money(store.withdrawals.filter(item=>item.userId===userId&&activeWithdrawalStatuses.includes(item.status)).reduce((sum,item)=>sum+Number(item.developerAmount||0),0)),paid:devPaid},
    ledger:store.financeLedger.filter(row=>row.employeeId===userId&&row.type.startsWith('commission_')).slice(0,80).map(row=>({id:row.id,postedAt:row.postedAt,leadId:row.leadId,type:row.type,commissionKind:row.commissionKind,amount:fromCents(row.amountCents),currency:row.currency,status:row.statusSnapshot}))};
}
function dashboardFor(user) {
  const allLeads = store.leads;
  if (user.role === 'admin') return {
    role: user.role, user: publicUser(user), currentPermissions:Object.fromEntries(Object.keys(permissionDefinitions).map(key=>[key,effectivePermission(user,key)])), summary: { leads: allLeads.length, open: allLeads.filter(l => !['completed','cancelled'].includes(l.status)).length, paid: money(allLeads.reduce((n,l) => n + l.paidTotal, 0)), employees: store.users.filter(u=>roles.includes(u.role)&&u.role!=='admin').length, commissionPending: money(allLeads.reduce((n,l)=>n+Number(l.commissionAmount||0)+Number(l.developerCommissionAmount||0),0)), visits: new Set(store.referralEvents.filter(event=>event.type==='visit'&&!event.reversedAt).map(event=>event.visitorHash).filter(Boolean)).size, withdrawals: store.withdrawals.filter(w=>['pending','under_review','approved','awaiting_transfer'].includes(w.status)).length },
    ownerDecisions:ownerDecisionsFor(),
    leads: allLeads.map(l => safeLead(l, true)), users: store.users.filter(u=>roles.includes(u.role)&&u.id!==user.id).map(row=>({...publicUser(row),department:row.department||roleDepartment(row.role),permissionOverrides:row.permissionOverrides||{},effectivePermissions:Object.fromEntries(Object.keys(permissionDefinitions).map(key=>[key,effectivePermission(row,key)]))})),
    permissionDefinitions, permissionDefaults:defaultRolePermissions,
    marketerRanks: store.users.filter(referralEnabled).map(u=>({id:u.id,name:u.name,username:u.username,role:u.role,code:u.currentReferralCode||u.referralCode,...marketerRankSummary(u)})),
    rankRequests: store.rankRequests.map(request=>({...request,qualifiedSales:qualifiedSales(request.userId)})),
    settings: store.settings, notificationsConfigured:emailReady()&&adminEmailReady(), payments: store.payments, withdrawals: store.withdrawals, campaigns:store.campaigns, conversations:store.conversations.map(item=>safeConversation(item,true)), crmSummary:crmSummaryFor(user), referralIntelligence:referralIntelligenceFor(user),financeSummary:financeTreasuryFor(),financeLedger:store.financeLedger.slice(0,250),expenses:store.expenses.slice(0,100),
    invitations:store.users.filter(u=>u.inviteCreatedBy||u.inviteApprovalStatus==='pending_approval').map(publicUser),
    mailQueue: store.mailQueue.slice(0, 50).map(({id,kind,createdAt,state,attempts,lastError})=>({id,kind,createdAt,state,attempts,lastError})), audit: store.audit.slice(0, 80)
  };
  if (user.role === 'hr_manager') {
    const canPeople=hasPermission(user,'employees.read',{department:'people'}),canWithdrawals=hasPermission(user,'withdrawals.review',{department:'people'}),canInvite=hasPermission(user,'team.invite',{department:'people'}),canManageOrders=permissionEnabled(user,'orders.manage');
    return {role:user.role,user:publicUser(user),currentPermissions:Object.fromEntries(Object.keys(permissionDefinitions).map(key=>[key,effectivePermission(user,key)])),crmSummary:crmSummaryFor(user),users:canPeople?store.users.filter(u=>roles.includes(u.role)&&u.role!=='admin').map(publicUser):[],
      referralIntelligence:canPeople?referralIntelligenceForViewer(user):{employees:[],links:[],orders:[],events:[]},
      ranks:canPeople?store.users.filter(u=>referralEnabled(u)&&hasPermission(user,'employees.read',{ownerId:u.id,department:u.department||roleDepartment(u.role)})).map(u=>({id:u.id,name:u.name,username:u.username,role:u.role,...marketerRankSummary(u)})):[],
      withdrawals:canWithdrawals?store.withdrawals.map(w=>({...w})):[],
      financeReviews:canPeople?allLeads.filter(l=>(l.referralUserId&&hasPermission(user,'employees.read',{ownerId:l.referralUserId,department:store.users.find(u=>u.id===l.referralUserId)?.department||'marketing'}))||(l.developerUserId&&hasPermission(user,'employees.read',{ownerId:l.developerUserId,department:store.users.find(u=>u.id===l.developerUserId)?.department||'development'}))).map(l=>({id:l.id,service:l.service,status:l.status,referralUser:store.users.find(u=>u.id===l.referralUserId)?.name||'',referralCommission:l.commissionAmount||0,referralStatus:l.commissionStatus||'none',developerUser:store.users.find(u=>u.id===l.developerUserId)?.name||'',developerCommission:l.developerCommissionAmount||0,developerStatus:l.developerCommissionStatus||'none',developerReview:l.developerCommissionReview||null,financialReview:l.financialReview||null})):[],
      projects:canPeople?allLeads.filter(l=>l.developerUserId&&hasPermission(user,'employees.read',{ownerId:l.developerUserId,department:store.users.find(u=>u.id===l.developerUserId)?.department||'development'})).map(l=>({id:l.id,developer:store.users.find(u=>u.id===l.developerUserId)?.name||'',service:l.service,status:l.status,taskStatus:l.developerTaskStatus||'offered',dueDate:l.developerDueDate||''})):[],
      orders:canManageOrders?allLeads.filter(l=>hasPermission(user,'orders.manage',{assigneeId:l.orderManagerUserId||'',ownerId:l.clientId||'',department:'orders'})).map(l=>safeOrderLead(l,true)):[],
      conversations:store.conversations.filter(item=>conversationAccess(user,item,'conversations.read')).map(item=>safeConversation(item,false)),conversationAssignees:conversationAssigneesFor(user),
      invitations:canInvite?store.users.filter(u=>u.inviteCreatedBy===user.id||u.inviteApprovalStatus==='pending_approval').map(publicUser):[],
      pendingInvitations:canInvite?store.users.filter(u=>u.inviteApprovalStatus==='pending_approval').map(publicUser):[]};
  }
  if (user.role === 'marketing_manager') {const canViewEmployees=hasPermission(user,'employees.read',{department:'marketing'});return {
    role:user.role,user:publicUser(user),currentPermissions:Object.fromEntries(Object.keys(permissionDefinitions).map(key=>[key,effectivePermission(user,key)])),crmSummary:crmSummaryFor(user),
    referralIntelligence:canViewEmployees?referralIntelligenceForViewer(user):{employees:[],links:[],orders:[],events:[]},
    summary:{visits:new Set(store.referralEvents.filter(event=>event.type==='visit'&&!event.reversedAt).map(event=>event.visitorHash).filter(Boolean)).size,referrals:allLeads.filter(l=>l.referralUserId).length},
    performance:canViewEmployees?store.users.filter(u=>referralEnabled(u)&&hasPermission(user,'employees.read',{ownerId:u.id,department:u.department||roleDepartment(u.role)})).map(u=>({name:u.name,code:u.currentReferralCode||u.referralCode,role:u.role,visits:new Set(store.referralEvents.filter(event=>event.userId===u.id&&event.type==='visit'&&!event.reversedAt).map(event=>event.visitorHash).filter(Boolean)).size,leads:allLeads.filter(l=>l.referralUserId===u.id).length,...marketerRankSummary(u)})):[],
    team:canViewEmployees?store.users.filter(u=>roles.includes(u.role)&&u.role!=='admin'&&hasPermission(user,'employees.read',{ownerId:u.id,department:u.department||roleDepartment(u.role)})).map(publicUser):[],leads:permissionEnabled(user,'orders.manage')?allLeads.filter(l=>hasPermission(user,'orders.manage',{assigneeId:l.orderManagerUserId||'',ownerId:l.clientId||'',department:'orders'})).map(l=>safeOrderLead(l,true)):[],conversations:store.conversations.filter(item=>conversationAccess(user,item,'conversations.read')).map(item=>safeConversation(item,false)),conversationAssignees:conversationAssigneesFor(user),campaigns:store.campaigns
  };}
  if(user.role==='order_manager')return {role:user.role,user:publicUser(user),currentPermissions:Object.fromEntries(Object.keys(permissionDefinitions).map(key=>[key,effectivePermission(user,key)])),orders:permissionEnabled(user,'orders.manage')?allLeads.filter(l=>hasPermission(user,'orders.manage',{assigneeId:l.orderManagerUserId||'',ownerId:l.clientId||'',department:'orders'})).map(l=>safeOrderLead(l,true)):[],conversations:store.conversations.filter(item=>conversationAccess(user,item,'conversations.read')).map(item=>safeConversation(item,false)),conversationAssignees:conversationAssigneesFor(user)};
  if(user.role==='client')return {role:'client',user:publicUser(user),profile:clientProfile(user),orders:allLeads.filter(lead=>lead.clientId===user.id).map(safeClientOrder),conversations:store.conversations.filter(item=>item.clientId===user.id).map(item=>safeConversation(item,false)),mailConfigured:emailReady()};
  const referrals = allLeads.filter(l => l.referralUserId === user.id);
  const wallet=walletFor(user.id);
  const referralMetrics=referralMetricsFor(user.id);
  const currentWithdrawalMonth=referralMonth(new Date());
  const common={role:user.role,user:publicUser(user),crmSummary:crmSummaryFor(user),referralLink:`/?ref=${encodeURIComponent(user.currentReferralCode||user.referralCode)}`,rank:marketerRankSummary(user),referralMetrics,referralLinks:store.referralLinks.filter(link=>link.userId===user.id).map(link=>({id:link.id,code:link.code,month:link.month,kind:link.kind,createdAt:link.createdAt,current:link.id===user.currentReferralLinkId})),referralIntelligence:referralIntelligenceFor(user),payoutHandle:user.payoutHandle||'',wallet,summary:{...wallet,visits:referralMetrics.visits,leads:referrals.length,withdrawalAlreadyUsed:store.withdrawals.some(w=>w.userId===user.id&&w.month===currentWithdrawalMonth)},commissionTerms:{baseRate:currentRankRate(user),holdDays:Number(store.settings.commissionHoldDays??14)},withdrawals:store.withdrawals.filter(w=>w.userId===user.id).map(withdrawalForMarketer),
    leads:referrals.map(l=>({id:l.id,createdAt:l.createdAt,service:l.service,status:l.status,commissionAmount:l.commissionAmount,commissionStatus:l.commissionStatus,withdrawalId:l.withdrawalId||null}))};
  if(user.role==='developer')common.projects=allLeads.filter(l=>l.developerUserId===user.id).map(safeDeveloperProject);
  return common;
}
function withdrawalForMarketer(w) { return { id:w.id, createdAt:w.createdAt, amount:w.amount, referralAmount:w.referralAmount||0, developerAmount:w.developerAmount||0, method:w.method, status:w.status, updatedAt:w.updatedAt || null, transferReference:w.status === 'paid' ? w.transferReference : undefined }; }
function availableCommissionLeads(userId) { return store.leads.filter(l=>l.referralUserId===userId&&l.commissionStatus==='confirmed'&&!l.withdrawalId&&outstandingCommission(l)>0); }
function availableDeveloperCommissionLeads(userId) { return store.leads.filter(l=>l.developerUserId===userId&&l.developerCommissionStatus==='confirmed'&&!l.developerWithdrawalId&&outstandingDeveloperCommission(l)>0); }
function updateCommission(lead) {
  if (!lead.contractAmount || !lead.referralUserId || lead.status === 'proposal' || lead.status === 'review' || lead.status === 'new') {
    lead.commissionAmount = null; lead.commissionDebtRemaining = 0; lead.commissionStatus = lead.referralUserId ? 'pending_setup' : 'none'; return;
  }
  if (lead.commissionRate == null) {
    const marketer = store.users.find(user=>user.id===lead.referralUserId&&referralEnabled(user));
    lead.commissionRate = marketer ? currentRankRate(marketer) : Number(store.settings.commissionPercent ?? 15);
    lead.commissionRank = marketer?.rank || 'rookie';
    lead.commissionRateSetAt = now();
  }
  const everPaidInFull = Boolean(lead.everFullyPaid || lead.fullyPaidAt);
  const cancelled = lead.status === 'cancelled';
  const hadCommission = Number(lead.commissionAmount || 0) > 0;
  const netPaid = Math.max(0, Math.min(Number(lead.paidTotal || 0), Number(lead.contractAmount)));
  const eligibleAmount = !cancelled && !lead.isDuplicate && everPaidInFull ? money(netPaid * lead.commissionRate / 100) : 0;
  lead.commissionAmount = money(eligibleAmount);
  lead.commissionDebtRemaining = money(Math.max(0, Number(lead.commissionPaidAmount || 0) - Number(lead.commissionOffsetAmount || 0) - eligibleAmount));
  if (cancelled || lead.isDuplicate || eligibleAmount <= 0) {
    lead.commissionStatus = lead.commissionDebtRemaining > 0 || ((cancelled || lead.isDuplicate || lead.refunded) && (hadCommission || everPaidInFull)) ? 'reversed' : (Number(lead.commissionPaidAmount || 0) > 0 ? 'paid' : 'none');
    return;
  }
  const unpaidCommission = money(Math.max(0, eligibleAmount - Number(lead.commissionPaidAmount || 0)));
  if (unpaidCommission <= 0) { lead.commissionStatus = lead.commissionDebtRemaining > 0 ? 'reversed' : 'paid'; return; }
  if (!lead.everFullyPaid || lead.paidTotal < lead.contractAmount || !lead.fullyPaidAt || lead.status !== 'completed') { lead.commissionStatus = 'pending'; return; }
  const holdDays = Math.max(0,Math.min(90,Number(store.settings.commissionHoldDays ?? 14)));
  const holdStart = new Date(lead.commissionHoldUntil || lead.fullyPaidAt).getTime();
  lead.commissionStatus = Date.now() >= holdStart + holdDays * 86400000 ? 'confirmed' : 'pending';
}
function outstandingCommission(lead) { return money(Math.max(0, Number(lead.commissionAmount || 0) - Number(lead.commissionPaidAmount || 0))); }
function outstandingCommissionDebt(userId) { return money(store.leads.filter(l=>l.referralUserId===userId).reduce((sum,l)=>sum+Number(l.commissionDebtRemaining||0),0)); }
function cancelWithdrawalForLead(lead, actor = null) {
  const withdrawalIds=new Set([lead.withdrawalId,lead.developerWithdrawalId].filter(Boolean));
  for(const withdrawalId of withdrawalIds){
    const withdrawal=store.withdrawals.find(w=>w.id===withdrawalId);if(!withdrawal||!['pending','under_review','approved','awaiting_transfer','requested'].includes(withdrawal.status))continue;
    const priorStatus=withdrawal.status;withdrawal.status='rejected';withdrawal.updatedAt=now();withdrawal.note='Released because a related project was refunded or cancelled.';
    withdrawal.statusHistory??=[];withdrawal.statusHistory.push({status:'rejected',from:priorStatus,at:withdrawal.updatedAt,by:actor?.username||'system',reason:'related_refund_or_cancellation'});
    for(const item of withdrawal.commissionItems||[]){const reserved=store.leads.find(l=>l.id===item.leadId);if(!reserved)continue;if(item.kind==='developer'&&reserved.developerWithdrawalId===withdrawal.id)delete reserved.developerWithdrawalId;if(item.kind!=='developer'&&reserved.withdrawalId===withdrawal.id)delete reserved.withdrawalId;}
    audit(actor,'withdrawal_cancelled',withdrawal.id,'Related project was refunded or cancelled');
    appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:released`,type:'withdrawal_released',employeeId:withdrawal.userId,withdrawalId:withdrawal.id,amountCents:cents(withdrawal.amount),statusSnapshot:'rejected',actor:actor?.username||'system',note:'Related project refunded or cancelled'});
    if(withdrawal.email)void queueMail({to:withdrawal.email,kind:'withdrawal_cancelled',subject:'تحديث طلب السحب لدى ZEZO',text:`مرحباً ${withdrawal.name}، أُلغي طلب السحب رقم ${withdrawal.id} بعد تعديل مالي على أحد المشاريع المرتبطة به. راجع رصيدك وقدم طلباً جديداً عند توفر الرصيد.`});
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const security = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  };
  if (STAGING_MODE) security['X-Robots-Tag'] = 'noindex, nofollow, noarchive, nosnippet';
  if (STAGING_MODE && path === '/robots.txt') {
    res.writeHead(200, { ...security, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('User-agent: *\nDisallow: /\n');
  }
  if (STAGING_MODE && req.method === 'POST' && path === '/__staging/login') {
    const attemptKey = req.socket.remoteAddress || 'unknown';
    if (!rateAllowedFor(stagingLoginAttempts, attemptKey, 12, 15 * 60_000)) {
      res.writeHead(429, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '900' });
      return res.end(stagingLoginPage('محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.'));
    }
    const raw = await bodyBuffer(req);
    if (raw.length > 1024) {
      res.writeHead(400, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(stagingLoginPage('تعذر قراءة كلمة المرور. حاول مرة أخرى.'));
    }
    const submittedPassword = new URLSearchParams(raw.toString('utf8')).get('password') || '';
    const submittedHash = createHash('sha256').update(submittedPassword).digest();
    if (!timingSafeEqual(submittedHash, STAGING_ACCESS_PASSWORD_HASH)) {
      res.writeHead(401, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(stagingLoginPage('كلمة المرور غير صحيحة.'));
    }
    const sessionId = randomBytes(32).toString('base64url');
    const maxAge = 12 * 60 * 60;
    stagingSessions.set(sessionId, { expiresAt: Date.now() + maxAge * 1000 });
    const accessCookie = 'zezo_staging_access=' + sessionId + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Strict' + (requestIsSecure(req) ? '; Secure' : '');
    res.writeHead(303, { ...security, Location: '/', 'Set-Cookie': accessCookie, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (STAGING_MODE && path === '/__staging/logout') {
    stagingSessions.delete(cookieValue(req, 'zezo_staging_access'));
    const clearCookie = 'zezo_staging_access=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' + (requestIsSecure(req) ? '; Secure' : '');
    res.writeHead(303, { ...security, Location: '/', 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (!stagingAuthorized(req)) {
    if (path.startsWith('/api/')) return json(res, 401, { error: 'كلمة مرور بيئة الاختبار مطلوبة / Staging password required', stagingAccessRequired: STAGING_MODE }, security);
    if (STAGING_MODE && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return req.method === 'HEAD' ? res.end() : res.end(stagingLoginPage());
    }
    res.writeHead(401, { ...security, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('ZEZO Forge staging access required.');
  }
  if (path.startsWith('/api/')) {
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, app: 'ZEZO', storage: 'local-json', staging: STAGING_MODE }, security);
    if (req.method === 'GET' && path === '/api/public') {
      const legacyPhone = process.env.ZEZO_WHATSAPP_NUMBER;
      const customerSupportPhone = STAGING_MODE ? '' : normalizeWhatsAppNumber(process.env.ZEZO_CUSTOMER_SUPPORT_WHATSAPP !== undefined ? process.env.ZEZO_CUSTOMER_SUPPORT_WHATSAPP : legacyPhone);
      const ordersPhone = STAGING_MODE ? '' : normalizeWhatsAppNumber(process.env.ZEZO_ORDERS_WHATSAPP !== undefined ? process.env.ZEZO_ORDERS_WHATSAPP : legacyPhone);
      const ordersUrl = buildWhatsAppUrl(ordersPhone);
      return json(res, 200, { prices: store.settings.prices.filter(price=>price.active!==false), templatePrices: store.settings.templatePrices || {}, templateInclusions:store.settings.templateInclusions||{}, templateActive:store.settings.templateActive||{}, commissionConfigured: store.settings.commissionPercent != null, customerSupportWhatsappNumber:customerSupportPhone, ordersWhatsappNumber:ordersPhone, customerSupportWhatsappUrl:buildWhatsAppUrl(customerSupportPhone), ordersWhatsappUrl:ordersUrl, whatsappUrl:ordersUrl, emailReady: emailReady() && adminEmailReady(), aiQuoteReady:!STAGING_MODE&&Boolean(process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL), adminSetupAvailable:firstAdminSetupAvailable(), stagingMode:STAGING_MODE }, security);
    }
    if(req.method==='POST'&&path==='/api/conversations'){
      if(!rateAllowedFor(conversationAttempts,`create:${req.socket.remoteAddress||'unknown'}`,15,60*60_000))return json(res,429,{error:'وصلنا الحد المؤقت للمحادثات. حاول لاحقاً / Conversation limit reached. Try again later.'},security);
      let b={},file=null;if((req.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data')){const parsed=parseMultipart(await bodyBuffer(req),req.headers['content-type']);b=parsed.fields;file=parsed.file;}else b=await jsonBody(req);const templateId=clean(b.templateId,80),template=templateById.get(templateId),message=clean(b.message,2000),auth=sessionUser(req);
      if(auth&&auth.user.role!=='client')return json(res,403,{error:'إنشاء محادثة قالب متاح للعميل فقط / Template conversations are for customers'},security);
      if(!template||store.settings.templateActive?.[templateId]===false||message.length<5)return json(res,400,{error:'اختر قالباً متاحاً واكتب استفسارك / Choose an available template and enter your question'},security);
      let guest=guestSessionValue(req),headers={};if(!auth&&!guest){guest=token(32);headers['Set-Cookie']=cookie('zezo_guest',guest,30*24*60*60,req);}
      const referralCode=clean(b.referralCode||url.searchParams.get('ref'),40),resolved=referralForRequest(req,{...b,referralCode}),conv={id:id('chat'),createdAt:now(),updatedAt:now(),templateId:template.id,templateName:template.title.ar,templateService:template.service,templateCategory:template.category,source:clean(b.source,40)||'template_catalog',department:'orders',status:'new',clientId:auth?.user.role==='client'?auth.user.id:null,guestSessionHash:auth?null:hash(guest),assignedUserId:null,referralCode:resolved?.code||'',referralLinkId:resolved?.link?.id||null,referralUserId:resolved?.user?.id||null,leadId:null,messages:[],quote:null,agreedPriceSnapshot:null};
      const attachment=await saveUpload(file),first=appendConversationMessage(conv,{senderType:conv.clientId?'client':'guest',senderId:conv.clientId||'',text:message,attachment});store.conversations.unshift(conv);
      if(conv.referralUserId)recordReferralEvent({userId:conv.referralUserId,code:conv.referralCode,linkId:conv.referralLinkId,type:'inquiry_confirmed',resourceId:conv.id,idempotencyKey:`conversation_inquiry:${conv.id}`});
      audit(auth?.user||null,'template_conversation_created',conv.id,`${conv.templateId}; referral=${conv.referralCode||'none'}`);notifyConversation(conv,'created',auth?.user||null);await persist();
      return json(res,201,{ok:true,conversation:safeConversation(conv,false),messageId:first.id}, {...security,...headers});
    }
    if(req.method==='GET'&&path==='/api/conversations'){
      const auth=requireAuth(req,res);if(!auth)return;let changed=false;
      if(auth.user.role==='client'&&guestSessionValue(req)){const guestHash=hash(guestSessionValue(req));for(const conv of store.conversations)if(conv.guestSessionHash===guestHash&&!conv.clientId){conv.clientId=auth.user.id;conv.guestSessionHash=null;conv.updatedAt=now();changed=true;}}
      const rows=store.conversations.filter(conv=>auth.user.role==='client'?conv.clientId===auth.user.id:conversationAccess(auth.user,conv,'conversations.read')).map(conv=>safeConversation(conv,auth.user.role==='admin'));
      if(changed)await persist();return json(res,200,{conversations:rows},security);
    }
    const conversationRoute=/^\/api\/conversations\/([^/]+)(?:\/(messages|quote|accept-quote|convert|files\/(\d+)))?$/.exec(path);
    if(conversationRoute){
      const conversationId=conversationRoute[1],action=conversationRoute[2]||'',conversation=store.conversations.find(item=>item.id===conversationId);
      if(!conversation)return json(res,404,{error:'المحادثة غير موجودة / Conversation not found'},security);
      const auth=sessionUser(req),staff=Boolean(auth&&auth.user.role!=='client');
      if(req.method==='GET'&&action===''){
        if(!customerCanSeeConversation(req,auth,conversation))return json(res,404,{error:'المحادثة غير موجودة / Conversation not found'},security);
        return json(res,200,{conversation:safeConversation(conversation,auth?.user.role==='admin')},security);
      }
      if(req.method==='GET'&&action.startsWith('files/')){
        if(!customerCanSeeConversation(req,auth,conversation))return json(res,404,{error:'الملف غير موجود / File not found'},security);
        const index=Number(conversationRoute[3]),all=(conversation.messages||[]).flatMap(message=>message.attachments||[]),file=all[index];if(!Number.isInteger(index)||!file)return json(res,404,{error:'الملف غير موجود / File not found'},security);
        res.writeHead(200,{...security,'Content-Type':file.type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,'Cache-Control':'private, no-store'});return createReadStream(join(UPLOAD_DIR,file.storedName)).pipe(res);
      }
      if(req.method==='POST'&&action==='messages'){
        let b={},file=null;if((req.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data')){const parsed=parseMultipart(await bodyBuffer(req),req.headers['content-type']);b=parsed.fields;file=parsed.file;}else b=await jsonBody(req);
        const text=clean(b.message,2000);if(text.length<1&&!file)return json(res,400,{error:'اكتب رسالة أو أرفق ملفاً صالحاً / Enter a message or attach a valid file'},security);
        if(staff){if(!conversationAccess(auth.user,conversation,'conversations.read')||!requirePermission(auth,res,'conversations.reply',{assigneeId:conversation.assignedUserId||'',ownerId:conversation.clientId||'',department:conversation.department||'orders'}))return;}
        else if(!customerCanSeeConversation(req,auth,conversation))return json(res,404,{error:'المحادثة غير موجودة / Conversation not found'},security);
        const attachment=await saveUpload(file),senderType=staff?'staff':auth?'client':'guest',message=appendConversationMessage(conversation,{senderType,senderId:auth?.user.id||'',text,attachment});
        if(staff&&conversation.status==='waiting_customer')conversation.status='in_progress';else if(!staff&&conversation.status==='waiting_customer')conversation.status='in_progress';
        audit(auth?.user||null,'conversation_message_sent',conversation.id,`${senderType}; ${message.id}; attachment=${Boolean(attachment)}`);notifyConversation(conversation,'message',auth?.user||null);await persist();return json(res,201,{ok:true,conversation:safeConversation(conversation,auth?.user.role==='admin')},security);
      }
      if(req.method==='PATCH'&&action===''){
        const staffAuth=requireAuth(req,res,['admin','hr_manager','marketing_manager','order_manager']);if(!staffAuth)return;
        if(!conversationAccess(staffAuth.user,conversation,'conversations.read')||!requirePermission(staffAuth,res,'conversations.update',{assigneeId:conversation.assignedUserId||'',ownerId:conversation.clientId||'',department:conversation.department||'orders'}))return;
        const b=await jsonBody(req);if(b.status!==undefined&&!['new','in_progress','waiting_customer','converted','closed'].includes(b.status))return json(res,400,{error:'حالة المحادثة غير صالحة / Invalid conversation status'},security);
        if(b.assignedUserId!==undefined){if(!requirePermission(staffAuth,res,'conversations.assign',{assigneeId:conversation.assignedUserId||'',ownerId:conversation.clientId||'',department:conversation.department||'orders'}))return;const target=store.users.find(user=>user.id===b.assignedUserId&&user.active&&user.role!=='admin');if(b.assignedUserId&&!target)return json(res,400,{error:'الموظف المختار غير متاح / Selected staff member is unavailable'},security);if(target&&target.department!=='orders'&&!hasPermission(target,'conversations.read',{assigneeId:target.id,department:'orders'}))return json(res,400,{error:'الموظف لا يملك صلاحية المحادثات / Selected staff member cannot access conversations'},security);conversation.assignedUserId=target?.id||null;}
        if(b.status!==undefined)conversation.status=b.status;conversation.updatedAt=now();audit(staffAuth.user,'conversation_updated',conversation.id,`${conversation.status}; assigned=${conversation.assignedUserId||'none'}`);
        if(conversation.assignedUserId)notifyUser(conversation.assignedUserId,`conversation-assigned:${conversation.id}:${conversation.updatedAt}`,{type:'inquiry',importance:'high',titleAr:'أُسندت إليك محادثة عميل',titleEn:'A customer conversation was assigned to you',descriptionAr:`محادثة حول ${conversation.templateName} بانتظار المتابعة.`,descriptionEn:`A conversation about ${conversation.templateName} is ready for follow-up.`},{tab:'conversations',targetId:conversation.id,targetKind:'conversation'});
        await persist();return json(res,200,{conversation:safeConversation(conversation,staffAuth.user.role==='admin')},security);
      }
      if(req.method==='POST'&&action==='quote'){
        const staffAuth=requireAuth(req,res,['admin','order_manager','hr_manager','marketing_manager']);if(!staffAuth)return;
        if(!conversationAccess(staffAuth.user,conversation,'conversations.read')||!requirePermission(staffAuth,res,'quotes.draft',{assigneeId:conversation.assignedUserId||'',ownerId:conversation.clientId||'',department:conversation.department||'orders'}))return;
        const b=await jsonBody(req),amount=Number(b.amount),scope=clean(b.scope,1600),included=clean(b.included,1200);
        if(!Number.isFinite(amount)||amount<0||amount>10000000||scope.length<8)return json(res,400,{error:'أدخل مبلغاً ووصف نطاق واضحين للعرض / Enter a valid amount and clear quote scope'},security);
        conversation.quote={id:id('quote'),amount:money(amount),currency:'ILS',scope,included,exclusions:clean(b.exclusions,1200),status:'sent',createdBy:staffAuth.user.id,createdAt:now(),acceptedAt:null};conversation.status='waiting_customer';conversation.updatedAt=now();
        appendConversationMessage(conversation,{senderType:'staff',senderId:staffAuth.user.id,text:`${staffAuth.user.name} · عرض سعر أولي: ${money(amount)} ₪\n${scope}${included?`\n${included}`:''}${conversation.quote.exclusions?`\nغير مشمول: ${conversation.quote.exclusions}`:''}\nالسعر لا يعتمد إلا بعد قبولك.`});
        audit(staffAuth.user,'conversation_quote_sent',conversation.id,`${conversation.quote.id}; ${conversation.quote.amount} ILS`);notifyConversation(conversation,'message',staffAuth.user);await persist();return json(res,201,{conversation:safeConversation(conversation,staffAuth.user.role==='admin')},security);
      }
      if(req.method==='POST'&&action==='convert'){
        const staffAuth=requireAuth(req,res,['admin','hr_manager','marketing_manager','order_manager']);if(!staffAuth)return;
        if(!conversationAccess(staffAuth.user,conversation,'conversations.read')||!requirePermission(staffAuth,res,'orders.convert',{assigneeId:conversation.assignedUserId||'',ownerId:conversation.clientId||'',department:conversation.department||'orders'}))return;
        if(conversation.leadId)return json(res,409,{error:'هذه المحادثة مرتبطة بطلب رسمي بالفعل / This conversation is already linked to a formal order'},security);
        if(conversation.status==='closed')return json(res,409,{error:'المحادثة مغلقة. أعد فتحها قبل متابعة الطلب / Reopen the conversation before continuing'},security);
        if(!conversation.conversionRequestedAt){conversation.conversionRequestedAt=now();conversation.status='waiting_customer';conversation.updatedAt=conversation.conversionRequestedAt;appendConversationMessage(conversation,{senderType:'staff',senderId:staffAuth.user.id,text:'إذا رغبت بمتابعة هذا المشروع، سجّل الدخول أو أنشئ حساب عميل ثم اضغط «تابع إلى طلب رسمي» لإرسال تفاصيلك ورقم واتساب وموافقتك. لن يُنشأ طلب أو سعر نهائي قبل إرسال النموذج وموافقتك.'});audit(staffAuth.user,'conversation_order_conversion_requested',conversation.id,`template=${conversation.templateId}`);notifyConversation(conversation,'message',staffAuth.user);await persist();}
        return json(res,200,{ok:true,conversation:safeConversation(conversation,staffAuth.user.role==='admin')},security);
      }
      if(req.method==='POST'&&action==='accept-quote'){
        if(!customerCanSeeConversation(req,auth,conversation))return json(res,404,{error:'المحادثة غير موجودة / Conversation not found'},security);
        if(!conversation.quote||conversation.quote.status!=='sent')return json(res,409,{error:'لا يوجد عرض سعر ينتظر القبول / No quote is awaiting acceptance'},security);
        conversation.quote.status='accepted';conversation.quote.acceptedAt=now();conversation.agreedPriceSnapshot={amount:conversation.quote.amount,currency:'ILS',quoteId:conversation.quote.id,acceptedAt:conversation.quote.acceptedAt};conversation.updatedAt=conversation.quote.acceptedAt;
        appendConversationMessage(conversation,{senderType:auth?'client':'guest',senderId:auth?.user.id||'',text:`تم قبول عرض السعر ${conversation.quote.amount} ₪.`});
        if(auth?.user.role==='client'){conversation.clientId=auth.user.id;conversation.guestSessionHash=null;}
        audit(auth?.user||null,'conversation_quote_accepted',conversation.id,conversation.quote.id);notifyConversation(conversation,'message',auth?.user||null);await persist();return json(res,200,{ok:true,conversation:safeConversation(conversation,false)},security);
      }
      return json(res,405,{error:'العملية غير مدعومة / Method not allowed'},security);
    }
    if (req.method === 'POST' && path === '/api/referral-events') {
      if(!rateAllowedFor(quoteAttempts,`referral:${req.socket.remoteAddress||'unknown'}`,300,60*60_000))return json(res,429,{error:'حاول لاحقاً / Try again later'},security);
      const b=await jsonBody(req),code=clean(b.code,40),type=clean(b.type,32),visitorId=clean(b.visitorId,80),eventId=clean(b.eventId,80);
      const allowedTypes=['visit','service_view','template_view','whatsapp_click'];
      if(!allowedTypes.includes(type)||!code||!visitorId||!eventId||!/^[-_a-zA-Z0-9]{12,80}$/.test(visitorId)||!/^[-_a-zA-Z0-9]{12,80}$/.test(eventId))return json(res,400,{error:'حدث الإحالة غير صالح / Invalid referral event'},security);
      const resolved=referralLinkForCode(code);if(!resolved)return json(res,404,{error:'رابط الإحالة غير متاح / Referral link is unavailable'},security);
      const resourceId=clean(b.resourceId,100);
      if(type==='service_view'&&!['web','apps','ai','ideas'].includes(resourceId))return json(res,400,{error:'الخدمة غير صالحة / Invalid service'},security);
      if(type==='template_view'&&!templateById.has(resourceId))return json(res,400,{error:'القالب غير صالح / Invalid template'},security);
      if(type==='whatsapp_click'&&!/^ZRI-[A-Z0-9]{8,24}$/.test(clean(b.followupId,32)))return json(res,400,{error:'رقم المتابعة غير صالح / Invalid follow-up ID'},security);
      const attribution=rememberReferralAttribution({visitorHash:hash(visitorId),userId:resolved.user.id,code,linkId:resolved.link.id});
      const event=recordReferralEvent({userId:attribution?.userId||resolved.user.id,code:attribution?.code||code,linkId:attribution?.linkId||resolved.link.id,type,visitorHash:hash(visitorId),resourceId,followupId:type==='whatsapp_click'?clean(b.followupId,32):'',idempotencyKey:`public:${eventId}`});
      await persist();return json(res,202,{ok:true,eventId:event.id},security);
    }
    if(req.method==='POST'&&path==='/api/referral-consent/revoke'){
      const b=await jsonBody(req),visitorId=clean(b.visitorId,80);
      if(!/^[\-_a-zA-Z0-9]{12,80}$/.test(visitorId))return json(res,400,{error:'معرّف القياس غير صالح / Invalid analytics identifier'},security);
      const visitorHash=hash(visitorId),beforeEvents=store.referralEvents.length,beforeAttributions=store.referralAttributions.length;
      store.referralEvents=store.referralEvents.filter(event=>!(event.visitorHash===visitorHash&&['visit','service_view','template_view','whatsapp_click'].includes(event.type)));
      store.referralAttributions=store.referralAttributions.filter(row=>row.visitorHash!==visitorHash);
      if(beforeEvents!==store.referralEvents.length||beforeAttributions!==store.referralAttributions.length)await persist();
      return json(res,202,{ok:true},security);
    }
    if (req.method === 'POST' && path === '/api/referral-inquiries') {
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;
      if(auth.user.role!=='admin'&&!requirePermission(auth,res,'conversations.update',{department:'orders'}))return;
      const b=await jsonBody(req),followupId=clean(b.followupId,32).toUpperCase(),code=clean(b.code,40),note=clean(b.note,300);
      if(!/^ZRI-[A-Z0-9]{8,24}$/.test(followupId)||!code)return json(res,400,{error:'أدخل رقم المتابعة ورمز الإحالة / Enter a follow-up ID and referral code'},security);
      const resolved=referralLinkForCode(code);if(!resolved)return json(res,404,{error:'رمز الإحالة غير صالح / Referral code not found'},security);
      const click=store.referralEvents.find(event=>event.type==='whatsapp_click'&&event.followupId===followupId);
      if(!click||click.userId!==resolved.user.id)return json(res,409,{error:'لا يوجد ضغط واتساب مطابق لرقم المتابعة ورمز الإحالة / No matching WhatsApp click for this follow-up ID and referral'},security);
      const already=store.referralEvents.find(event=>event.type==='inquiry_confirmed'&&event.followupId===followupId);
      if(already){if(already.userId!==resolved.user.id)return json(res,409,{error:'رقم المتابعة مرتبط بإحالة أخرى / Follow-up ID is already linked to another referral'},security);return json(res,200,{ok:true,duplicate:true},security);}
      recordReferralEvent({userId:resolved.user.id,code,linkId:resolved.link.id,type:'inquiry_confirmed',followupId,idempotencyKey:`inquiry:${followupId}`});
      audit(auth.user,'referral_inquiry_confirmed',followupId,`${resolved.user.username}; ${note}`);await persist();return json(res,201,{ok:true},security);
    }
    if (req.method === 'GET' && path === '/api/referral-intelligence') {
      const auth=requireAuth(req,res,['admin','hr_manager','marketing_manager','marketer','developer']);if(!auth)return;
      const canViewTeam=auth.user.role==='admin'||(auth.user.role==='hr_manager'&&hasPermission(auth.user,'employees.read',{department:'people'}))||(auth.user.role==='marketing_manager'&&hasPermission(auth.user,'employees.read',{department:'marketing'}));
      if(['hr_manager','marketing_manager'].includes(auth.user.role)&&!canViewTeam)return json(res,403,{error:'إحصاءات الفريق تحتاج صلاحية مشاهدة الموظفين / Team analytics require employee-view permission'},security);
      const requestedUser=clean(url.searchParams.get('employee'),80);
      if(requestedUser&&!canViewTeam&&requestedUser!==auth.user.id)return json(res,403,{error:'لا يمكنك عرض موظف آخر / You cannot view another employee'},security);
      const from=clean(url.searchParams.get('from'),10),to=clean(url.searchParams.get('to'),10),status=clean(url.searchParams.get('status'),20);
      if((from&&!/^\d{4}-\d{2}-\d{2}$/.test(from))||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to))||(status&&!['new','review','proposal','active','waiting_payment','completed','cancelled'].includes(status)))return json(res,400,{error:'الفلاتر غير صالحة / Invalid filters'},security);
      const intel=referralIntelligenceForViewer(auth.user),allowedIds=new Set(intel.employees.map(row=>row.id));
      const employee=requestedUser&&allowedIds.has(requestedUser)?requestedUser:'';
      const start=from?Date.parse(`${from}T00:00:00.000Z`):-Infinity,end=to?Date.parse(`${to}T23:59:59.999Z`):Infinity;
      const matchingOrders=intel.orders.filter(order=>(!employee||order.userId===employee)&&(!status||order.status===status));
      const matchingOrderById=new Map(matchingOrders.map(order=>[order.id,order]));
      const orders=matchingOrders.filter(order=>Date.parse(order.createdAt)>=start&&Date.parse(order.createdAt)<=end);
      const events=store.referralEvents.filter(event=>allowedIds.has(event.userId)&&(!employee||event.userId===employee)&&Date.parse(event.createdAt)>=start&&Date.parse(event.createdAt)<=end&&(!status||(event.leadId&&matchingOrderById.has(event.leadId)))).map(event=>({id:event.id,userId:event.userId,employeeName:intel.employees.find(row=>row.id===event.userId)?.name||'',code:event.code,linkId:event.linkId,month:event.month,type:event.type,createdAt:event.createdAt,resourceId:event.resourceId,leadId:event.leadId,followupId:event.followupId,reversed:Boolean(event.reversedAt),status:event.leadId?matchingOrderById.get(event.leadId)?.status||'':'',visitorHash:event.type==='visit'?event.visitorHash:null}));
      events.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      const active=events.filter(event=>!event.reversed),counts=type=>active.filter(event=>event.type===type).length;
      const visitors=new Set(active.filter(event=>event.type==='visit').map(event=>event.visitorHash).filter(Boolean)).size;
      const linkStats=intel.links.filter(link=>(!employee||link.userId===employee)).map(link=>{const subset=active.filter(event=>event.linkId===link.id);const count=type=>subset.filter(event=>event.type===type).length;return {...link,visits:new Set(subset.filter(event=>event.type==='visit').map(event=>event.visitorHash).filter(Boolean)).size,serviceViews:count('service_view'),templateViews:count('template_view'),whatsappClicks:count('whatsapp_click'),inquiries:count('inquiry_confirmed'),requests:new Set(orders.filter(order=>order.linkId===link.id).map(order=>order.id)).size,sales:new Set(subset.filter(event=>event.type==='qualified_sale'&&event.leadId).map(event=>event.leadId)).size};});
      for(const event of events)delete event.visitorHash;
      const summary={visits:visitors,serviceViews:counts('service_view'),templateViews:counts('template_view'),whatsappClicks:counts('whatsapp_click'),inquiries:counts('inquiry_confirmed'),requests:new Set(orders.map(order=>order.id)).size,quoteAcceptances:counts('quote_accepted'),payments:counts('payment_received'),sales:new Set(active.filter(event=>event.type==='qualified_sale'&&event.leadId).map(event=>event.leadId)).size,orders:orders.length};
      const rate=(numerator,denominator)=>denominator?Math.round(numerator/denominator*1000)/10:0;
      summary.conversionRates={visitToRequest:rate(summary.requests,summary.visits),requestToSale:rate(summary.sales,summary.requests),whatsappToInquiry:rate(summary.inquiries,summary.whatsappClicks)};
      return json(res,200,{retentionDays:90,filters:{from,to,employee,status},summary,employees:intel.employees.filter(row=>!employee||row.id===employee),links:linkStats,orders:orders.slice(0,500),events:events.filter(event=>event.type!=='visit').slice(0,500)},security);
    }
    if (req.method === 'POST' && path.startsWith('/api/admin/leads/') && path.endsWith('/quote-accepted')) {
      const auth=requireAuth(req,res,['admin']);if(!auth)return;
      const leadId=path.split('/').at(-2),lead=store.leads.find(row=>row.id===leadId);if(!lead)return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      if(lead.isDuplicate||lead.status==='cancelled')return json(res,409,{error:'لا يمكن اعتماد عرض طلب مكرر أو ملغي / Cannot confirm a quote on a duplicate or cancelled request'},security);
      if(lead.quoteAcceptedAt)return json(res,200,{ok:true,duplicate:true},security);
      lead.quoteAcceptedAt=now();if(['new','review','proposal'].includes(lead.status))lead.status='active';
      recordLeadMilestone(lead,'quote_accepted',auth.user);syncCrmCaseForOrder(lead,auth.user);audit(auth.user,'quote_acceptance_recorded',lead.id,'Customer acceptance confirmed manually');await persist();return json(res,201,{ok:true,quoteAcceptedAt:lead.quoteAcceptedAt},security);
    }
    if (req.method === 'POST' && path === '/api/quote') {
      const key=req.socket.remoteAddress||'unknown';if(!rateAllowedFor(quoteAttempts,key,15,60*60_000))return json(res,429,{error:'حاول تقدير فكرتك مرة أخرى بعد قليل / Please try again later'},security);
      const b=await jsonBody(req),brief=clean(b.brief,800);
      if(brief.length<8) return json(res,400,{error:'اكتب وصفاً أوضح قليلاً للفكرة / Add a little more detail about the idea'},security);
      if(process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL&&b.consentAi!==true)return json(res,400,{error:'وافق على إرسال الوصف إلى خدمة الذكاء الاصطناعي أو أوقف التفعيل / Consent to AI processing or disable AI'},security);
      const quote=await generateQuote(brief,b.lang==='en'?'en':'ar');
      return json(res,200,quote,security);
    }
    if (req.method === 'GET' && path === '/api/track') {
      const trackToken = clean(url.searchParams.get('token'), 120);
      const lead = store.leads.find(item=>item.trackingHash===hash(trackToken)&&item.trackingExpires>Date.now());
      if (!lead) return json(res,404,{error:'رابط التتبع غير صالح أو منتهي / Tracking link is invalid or expired'},security);
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ar';
      return json(res,200,{createdAt:lead.createdAt,service:lead.service,status:lead.status,statusText:publicStatusLabels[lead.status]?.[lang]||publicStatusLabels.new[lang],note:lead.publicStatusNote||''},security);
    }
    if(req.method==='GET'&&path==='/api/crm'){
      const auth=requireAuth(req,res,['admin','marketing_manager','hr_manager','marketer','developer']);if(!auth)return;
      const all=store.crmLeads||[];
      if(auth.user.role==='hr_manager')return json(res,200,{scope:'aggregate',summary:crmSummaryFor(auth.user)},security);
      if(['marketer','developer'].includes(auth.user.role))return json(res,200,{scope:'own_referrals',summary:crmSummaryFor(auth.user)},security);
      if(auth.user.role!=='admin'&&!permissionEnabled(auth.user,'orders.manage'))return json(res,403,{error:'لا تملك صلاحية إدارة سجلات العملاء / You cannot manage CRM records'},security);
      const from=clean(url.searchParams.get('from'),10),to=clean(url.searchParams.get('to'),10),status=clean(url.searchParams.get('status'),32),employee=clean(url.searchParams.get('employee'),80),service=clean(url.searchParams.get('service'),60),search=clean(url.searchParams.get('q'),120).toLowerCase();
      if((from&&!/^\d{4}-\d{2}-\d{2}$/.test(from))||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to))||(status&&!crmStatuses.includes(status))||(service&&!Object.hasOwn(serviceCategories,service)))return json(res,400,{error:'فلاتر CRM غير صالحة / Invalid CRM filters'},security);
      const fromTime=from?Date.parse(`${from}T00:00:00.000Z`):-Infinity,toTime=to?Date.parse(`${to}T23:59:59.999Z`):Infinity;
      const selected=all.filter(row=>crmAccess(auth.user,row)&&Date.parse(row.createdAt)>=fromTime&&Date.parse(row.createdAt)<=toTime&&(!status||row.status===status)&&(!employee||row.referralUserId===employee||row.assignedUserId===employee)&&(!service||row.service===service)&&(!search||[row.name,row.phone,row.email,row.service,row.details,row.referralCode].some(value=>String(value||'').toLowerCase().includes(search)))).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
      return json(res,200,{scope:'team',summary:crmAggregate(selected,{from,to,service}),filtered:selected.length,items:selected.slice(0,500).map(crmRecordForViewer),filters:{from,to,status,employee,service,q:search}},security);
    }
    if(req.method==='GET'&&path==='/api/crm/export'){
      const auth=requireAuth(req,res,['admin','marketing_manager','hr_manager','marketer']);if(!auth)return;
      if(auth.user.role==='marketing_manager'&&!permissionEnabled(auth.user,'orders.manage'))return json(res,403,{error:'لا تملك صلاحية تصدير سجلات العملاء / You cannot export CRM records'},security);
      const records=store.crmLeads||[],from=clean(url.searchParams.get('from'),10),to=clean(url.searchParams.get('to'),10),status=clean(url.searchParams.get('status'),32),employee=clean(url.searchParams.get('employee'),80),service=clean(url.searchParams.get('service'),60),search=['admin','marketing_manager'].includes(auth.user.role)?clean(url.searchParams.get('q'),120).toLowerCase():'';
      if((from&&!/^\d{4}-\d{2}-\d{2}$/.test(from))||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to))||(status&&!crmStatuses.includes(status))||(service&&!Object.hasOwn(serviceCategories,service)))return json(res,400,{error:'فلاتر CRM غير صالحة / Invalid CRM filters'},security);
      const scope=auth.user.role==='marketer'?records.filter(row=>row.referralUserId===auth.user.id):auth.user.role==='marketing_manager'?records.filter(row=>crmAccess(auth.user,row)):records,fromTime=from?Date.parse(`${from}T00:00:00.000Z`):-Infinity,toTime=to?Date.parse(`${to}T23:59:59.999Z`):Infinity;
      const filtered=scope.filter(row=>Date.parse(row.createdAt)>=fromTime&&Date.parse(row.createdAt)<=toTime&&(!status||row.status===status)&&(!employee||['admin','marketing_manager','hr_manager'].includes(auth.user.role)&&(row.referralUserId===employee||row.assignedUserId===employee))&&(!service||row.service===service)&&(!search||[row.name,row.phone,row.email,row.service,row.details,row.referralCode].some(value=>String(value||'').toLowerCase().includes(search))));let rows;
      if(['hr_manager','marketer'].includes(auth.user.role)){const summary=crmAggregate(filtered,{from,to,service});rows=[['metric','value'],...Object.entries(summary)];}
      else rows=[['id','createdAt','name','phone','email','service','status','source','referrer','referralCode','assignedTo','followUpAt','orderIds'],...filtered.map(row=>[row.id,row.createdAt,row.name,row.phone,row.email,row.service,row.status, row.source,store.users.find(user=>user.id===row.referralUserId)?.name||'',row.referralCode,store.users.find(user=>user.id===row.assignedUserId)?.name||'',row.followUpAt,(row.orderIds||[]).join('|')])];
      const csv=rows.map(row=>row.map(value=>{let text=String(value??'');if(/^[=+@-]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;}).join(',')).join('\r\n');
      res.writeHead(200,{...security,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="zezo-crm.csv"','Cache-Control':'no-store'});res.end(`\uFEFF${csv}`);return;
    }
    if(req.method==='POST'&&path==='/api/crm/inquiries'){
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;
      if(auth.user.role!=='admin'&&!permissionEnabled(auth.user,'orders.manage'))return json(res,403,{error:'لا تملك صلاحية إنشاء سجل CRM / You cannot create CRM records'},security);
      const b=await jsonBody(req),name=clean(b.name,100),phone=normalizePhone(b.phone),email=normalizeEmail(b.email),service=clean(b.service,60),category=clean(b.category,80),details=clean(b.details,3000),source=clean(b.source,24)||'whatsapp',code=clean(b.referralCode,40);
      if(b.confirmedConversation!==true&&b.confirmedConversation!=='true')return json(res,409,{error:'وثّق تأكيد المحادثة أولاً؛ النقر وحده ليس استفساراً / Confirm the conversation first; a click alone is not an enquiry'},security);
      if((name&&name.length<2)||!isE164Phone(phone)||(email&&!/^\S+@\S+\.\S+$/.test(email))||!['whatsapp','phone','social','website','referral','other'].includes(source)||details.length<5||(service&&!Object.hasOwn(serviceCategories,service)))return json(res,400,{error:'تحقق من رقم واتساب الدولي والبيانات المطلوبة / Check the international WhatsApp number and required details'},security);
      const resolved=code?referralLinkForCode(code):null;if(code&&!resolved)return json(res,404,{error:'رمز الإحالة غير صالح / Referral code not found'},security);
      const createdAt=now(),record={id:id('crm'),name,phone,email,service,category,templateId:clean(b.templateId,80),templateName:clean(b.templateName,120),details,source,referralUserId:resolved?.user.id||null,referralCode:resolved?.code||'',referralLinkId:resolved?.link.id||null,createdAt,updatedAt:createdAt,status:'new_enquiry',assignedUserId:effectivePermission(auth.user,'orders.manage')==='assigned'?auth.user.id:'',followUpAt:'',orderIds:[],notes:[],history:[{kind:'confirmed_enquiry',status:'new_enquiry',by:auth.user.username,at:createdAt,note:`Confirmed contact recorded via ${source}.`}],duplicateCandidates:[]};
      record.duplicateCandidates=crmDuplicateCandidates({phone,email}).map(row=>({id:row.id,kind:row.kind}));store.crmLeads.unshift(record);
      if(resolved)recordReferralEvent({userId:resolved.user.id,code:resolved.code,linkId:resolved.link.id,type:'inquiry_confirmed',leadId:'',followupId:record.id,idempotencyKey:`crm_inquiry:${record.id}`});
      const key=`crm:new:${record.id}`,notice={type:'inquiry',importance:'high',titleAr:'استفسار مؤكد جديد في CRM',titleEn:'New confirmed CRM enquiry',descriptionAr:`استفسار ${record.service||'عام'} ينتظر التعيين والمتابعة.`,descriptionEn:`A ${record.service||'general'} enquiry is ready for assignment and follow-up.`};
      notifyRoles(['admin','marketing_manager'],key,notice,{tabs:{admin:'crm',marketing_manager:'crm'},targetId:record.id,targetKind:'crm'});
      if(resolved)notifyUser(resolved.user.id,key,{type:'inquiry',importance:'normal',titleAr:'تم تأكيد استفسار من إحالتك',titleEn:'An enquiry from your referral was confirmed',descriptionAr:'سجل الفريق استفساراً مؤكداً. لا يُعد الاستفسار مبيعة.',descriptionEn:'The team logged a confirmed enquiry. An enquiry is not a sale.'},{tab:'referral',targetId:record.id,targetKind:'crm'});
      audit(auth.user,'crm_enquiry_created',record.id,`source=${source}; referral=${record.referralCode||'none'}; duplicateCandidates=${record.duplicateCandidates.length}`);await persist();
      return json(res,201,{record:crmRecordForViewer(record),duplicateCandidates:record.duplicateCandidates},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/crm/')&&path.split('/').length===4){
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;const record=store.crmLeads.find(row=>row.id===path.split('/').at(-1));if(!record)return json(res,404,{error:'سجل CRM غير موجود / CRM record not found'},security);
      if(!crmAccess(auth.user,record))return json(res,403,{error:'سجل CRM خارج نطاق صلاحيتك / CRM record is outside your permission scope'},security);
      const b=await jsonBody(req),before=record.status,beforeAssigned=record.assignedUserId,changes=[];
      const allowedStatuses=['new_enquiry','awaiting_contact','contacted','interested','follow_up','quote_pending','quote_sent','not_interested','unresponsive','cancelled'];
      if(b.status!==undefined){if(!allowedStatuses.includes(b.status))return json(res,400,{error:'لا يمكن ضبط الحالة المالية أو طلب المشروع من CRM؛ استخدم سجل الطلب الأصلي / Financial and order statuses must come from the existing order'},security);if(before!==b.status){record.status=b.status;record.history??=[];record.history.unshift({kind:'status_changed',status:b.status,by:auth.user.username,at:now(),note:clean(b.statusNote,300)});changes.push(`status:${before}->${b.status}`);}}
      if(b.assignedUserId!==undefined){const assignedId=clean(b.assignedUserId,80),assigned=assignedId?store.users.find(row=>row.id===assignedId&&row.role==='marketing_manager'&&row.active&&!row.accountDisabledAt):null;if(assignedId&&!assigned)return json(res,400,{error:'يمكن التعيين إلى مسؤول تسويق وخدمة عملاء نشط فقط / Assign to an active marketing and support manager'},security);record.assignedUserId=assignedId;changes.push(`assigned:${assignedId||'none'}`);}
      if(b.followUpAt!==undefined){const value=clean(b.followUpAt,32);if(value&&(!Number.isFinite(Date.parse(value))||Date.parse(value)<Date.now()-86400000))return json(res,400,{error:'موعد المتابعة غير صالح / Invalid follow-up date'},security);record.followUpAt=value;changes.push(`followup:${value||'cleared'}`);}
      if(b.note!==undefined){const note=clean(b.note,1000);if(note){record.notes??=[];record.notes.unshift({id:id('crmnote'),by:auth.user.username,at:now(),note});record.notes=record.notes.slice(0,100);record.history??=[];record.history.unshift({kind:'internal_note',status:record.status,by:auth.user.username,at:now(),note:'Internal note added.'});changes.push('internal_note');}}
      record.updatedAt=now();record.history=(record.history||[]).slice(0,100);
      if(before!==record.status)notifyCrmStageChange(record,auth.user);
      if(record.assignedUserId&&record.assignedUserId!==beforeAssigned&&record.assignedUserId!==auth.user.id)notifyUser(record.assignedUserId,`crm:assigned:${record.id}:${record.updatedAt}`,{type:'inquiry',importance:'high',titleAr:'أُسند إليك استفسار عميل',titleEn:'A customer enquiry was assigned to you',descriptionAr:'افتح لوحة CRM لمراجعة الاستفسار وموعد المتابعة.',descriptionEn:'Open CRM to review the enquiry and follow-up date.'},{tab:'crm',targetId:record.id,targetKind:'crm'});
      audit(auth.user,'crm_record_updated',record.id,changes.join('; '));await persist();return json(res,200,{record:crmRecordForViewer(record)},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/crm/')&&path.endsWith('/link-order')){
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;const crmId=path.split('/').at(-2),record=store.crmLeads.find(row=>row.id===crmId);if(!record)return json(res,404,{error:'سجل CRM غير موجود / CRM record not found'},security);
      if(!crmAccess(auth.user,record))return json(res,403,{error:'سجل CRM خارج نطاق صلاحيتك / CRM record is outside your permission scope'},security);
      const b=await jsonBody(req),order=store.leads.find(row=>row.id===clean(b.orderId,80));if(!order)return json(res,404,{error:'الطلب غير موجود؛ استقبل الطلب عبر حساب العميل أولاً / Order not found; receive it from the customer account first'},security);
      const contactMatches=(record.phone&&normalizePhone(record.phone).replace(/\D/g,'')===normalizePhone(order.clientWhatsappPhone||order.phone).replace(/\D/g,''))||(record.email&&normalizeEmail(record.email)===normalizeEmail(order.email));if(!contactMatches)return json(res,409,{error:'بيانات التواصل لا تطابق الطلب؛ لم يتم ربطهما / Contact details do not match; records were not linked'},security);
      record.orderIds??=[];if(!record.orderIds.includes(order.id))record.orderIds.push(order.id);order.crmLeadId=record.id;record.status=crmStatusForOrder(order);record.updatedAt=now();record.history??=[];record.history.unshift({kind:'order_linked',status:record.status,by:auth.user.username,at:record.updatedAt,note:`Linked existing order ${order.id}; order attribution and financial records were left unchanged.`});record.duplicateCandidates=crmDuplicateCandidates({phone:record.phone,email:record.email,excludeId:record.id,orderId:order.id}).map(row=>({id:row.id,kind:row.kind}));audit(auth.user,'crm_order_linked',record.id,`existing order ${order.id}; referral preserved`);await persist();return json(res,200,{record:crmRecordForViewer(record),orderId:order.id},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/crm/')&&path.endsWith('/merge')){
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;const source=store.crmLeads.find(row=>row.id===path.split('/').at(-2)),b=await jsonBody(req),target=store.crmLeads.find(row=>row.id===clean(b.targetId,80));
      if(source&&!crmAccess(auth.user,source)||target&&!crmAccess(auth.user,target))return json(res,403,{error:'سجل CRM خارج نطاق صلاحيتك / CRM record is outside your permission scope'},security);
      if(!source||!target)return json(res,404,{error:'اختر سجلين موجودين / Select two existing CRM records'},security);if(source.id===target.id||source.mergedInto)return json(res,409,{error:'لا يمكن دمج السجل مع نفسه أو إعادة دمجه / Cannot merge a record into itself or merge it twice'},security);
      target.notes??=[];target.history??=[];source.notes??=[];source.history??=[];target.referralHistory??=[];
      for(const item of [target,source])if(item.referralUserId||item.referralCode)target.referralHistory.push({recordId:item.id,userId:item.referralUserId||null,code:item.referralCode||'',linkId:item.referralLinkId||null,source:item.source||'',at:item.createdAt});
      target.notes=[...source.notes,...target.notes].slice(0,100);target.history=[...source.history.map(item=>({...item,mergedFrom:source.id})),...target.history].slice(0,100);
      target.orderIds=[...new Set([...(target.orderIds||[]),...(source.orderIds||[])])];target.duplicateCandidates=[...new Map([...(target.duplicateCandidates||[]),...(source.duplicateCandidates||[])].map(item=>[typeof item==='string'?item:item.id,item])).values()].filter(item=>(typeof item==='string'?item:item.id)!==source.id&&(typeof item==='string'?item:item.id)!==target.id);
      const crmStatusPriority={new_enquiry:0,awaiting_contact:1,contacted:2,interested:3,follow_up:4,quote_pending:5,quote_sent:6,quote_accepted:7,official_order:8,completed_sale:9};if(!['not_interested','cancelled','duplicate'].includes(target.status)&&(crmStatusPriority[source.status]??-1)>(crmStatusPriority[target.status]??-1))target.status=source.status;
      target.updatedAt=now();
      const linkedOrders=target.orderIds.map(orderId=>store.leads.find(row=>row.id===orderId)).filter(Boolean),completed=linkedOrders.find(order=>crmStatusForOrder(order)==='completed_sale');if(completed)target.status='completed_sale';target.history.unshift({kind:'records_merged',status:target.status,by:auth.user.username,at:target.updatedAt,note:`Merged CRM record ${source.id}. Referral histories were retained; existing orders, payments, and commissions were not changed.`});
      source.status='duplicate';source.mergedInto=target.id;source.orderIds=[];source.notes=[];source.history.unshift({kind:'merged_into',status:'duplicate',by:auth.user.username,at:target.updatedAt,note:`Merged into ${target.id}.`});source.updatedAt=target.updatedAt;
      for(const order of store.leads.filter(row=>row.crmLeadId===source.id))order.crmLeadId=target.id;
      audit(auth.user,'crm_records_merged',target.id,`source=${source.id}; referral and finance unchanged`);await persist();return json(res,200,{record:crmRecordForViewer(target),mergedRecordId:source.id},security);
    }
    if(req.method==='GET'&&path==='/api/notifications'){
      const auth=requireAuth(req,res);if(!auth)return;
      const deadlineChanged=emitDeadlineNotifications();if(deadlineChanged)await persist();
      const type=clean(url.searchParams.get('type'),32),status=clean(url.searchParams.get('status'),12),from=clean(url.searchParams.get('from'),10),to=clean(url.searchParams.get('to'),10),limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50));
      const notificationTypes=['project','inquiry','withdrawal','rank','sale','commission','quote','payment','team','deadline','finance','referral','update'];
      if((type&&!notificationTypes.includes(type))||(status&&!['all','read','unread'].includes(status))||(from&&!/^\d{4}-\d{2}-\d{2}$/.test(from))||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to)))return json(res,400,{error:'فلاتر الإشعارات غير صالحة / Invalid notification filters'},security);
      const unreadCount=store.notifications.filter(row=>row.userId===auth.user.id&&!row.readAt).length,start=from?Date.parse(`${from}T00:00:00.000Z`):-Infinity,end=to?Date.parse(`${to}T23:59:59.999Z`):Infinity;
      const notifications=store.notifications.filter(row=>row.userId===auth.user.id&&(!type||row.type===type)&&(!status||status==='all'||(status==='read'?Boolean(row.readAt):!row.readAt))&&Date.parse(row.createdAt)>=start&&Date.parse(row.createdAt)<=end).slice(0,limit).map(safeNotification);
      return json(res,200,{notifications,unreadCount,authenticated:true,emailReady:emailReady()&&adminEmailReady()},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/notifications/')){
      const auth=requireAuth(req,res);if(!auth)return;const notificationId=path.split('/').at(-1),notification=store.notifications.find(row=>row.id===notificationId&&row.userId===auth.user.id);
      if(!notification)return json(res,404,{error:'الإشعار غير موجود / Notification not found'},security);
      if(!notification.readAt){notification.readAt=now();await persist();}
      return json(res,200,{notification:safeNotification(notification),unreadCount:store.notifications.filter(row=>row.userId===auth.user.id&&!row.readAt).length},security);
    }
    if(req.method==='POST'&&path==='/api/notifications/read-all'){
      const auth=requireAuth(req,res);if(!auth)return;let changed=false;const at=now();
      for(const notification of store.notifications)if(notification.userId===auth.user.id&&!notification.readAt){notification.readAt=at;changed=true;}
      if(changed)await persist();return json(res,200,{ok:true,unreadCount:0},security);
    }
    if (req.method === 'GET' && path === '/api/dashboard') {
      const auth = requireAuth(req,res); if (!auth) return;
      let guestConversationsClaimed=false;if(auth.user.role==='client'&&guestSessionValue(req)){const guestHash=hash(guestSessionValue(req));for(const conversation of store.conversations)if(conversation.guestSessionHash===guestHash&&!conversation.clientId){conversation.clientId=auth.user.id;conversation.guestSessionHash=null;conversation.updatedAt=now();guestConversationsClaimed=true;}}
      let changed=guestConversationsClaimed||ensureMonthlyReferralLinks(); const eventCountBeforeCleanup=store.referralEvents.length;cleanReferralEvents();if(eventCountBeforeCleanup!==store.referralEvents.length)changed=true; const previousRankState=JSON.stringify(store.rankRequests);
      for (const lead of store.leads) { const before=JSON.stringify([lead.commissionStatus,lead.commissionAmount,lead.developerCommissionStatus,lead.developerCommissionAmount]); updateCommission(lead); updateDeveloperCommission(lead);syncLeadFinanceLedger(lead); if(before!==JSON.stringify([lead.commissionStatus,lead.commissionAmount,lead.developerCommissionStatus,lead.developerCommissionAmount])) { changed=true;notifyCurrentCommissions(lead); } }
      const rankRequestsCreated=syncAllRankRequests();
      if(changed||previousRankState!==JSON.stringify(store.rankRequests)) await persist();
      for(const request of rankRequestsCreated) await queueRankRequestMail(request);
      void processMailQueue();
      return json(res, 200, dashboardFor(auth.user), security);
    }
    if(req.method==='GET'&&path==='/api/admin/finance'){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;
      return json(res,200,financeTreasuryFor(Object.fromEntries(url.searchParams)),security);
    }
    if (req.method === 'POST' && path === '/api/setup') {
      const b = await jsonBody(req);
      if (store.users.some(u=>u.role==='admin'&&u.active)) return json(res,409,{error:'تم إنشاء حساب المدير مسبقاً / Initial administrator already exists'},security);
      if (!canSetUpFirstAdmin()) return json(res,403,{error:'إنشاء المدير الأول متاح في المعاينة المحلية فقط / First administrator setup is available only in local development'},security);
      const setupKey=`first-admin:${req.socket.remoteAddress||'unknown'}`;
      if (!rateAllowed(setupKey)) return json(res,429,{error:'محاولات كثيرة. حاول بعد 15 دقيقة / Too many attempts; try again in 15 minutes'},security);
      const name = clean(b.name,80), username = clean(b.username,40).toLowerCase();
      if (name.length < 2 || !/^[a-z0-9._-]{3,40}$/.test(username) || !validTemporaryPassword(b.password)) return json(res,400,{error:'أدخل اسماً واسم مستخدم صالحاً وكلمة مرور مؤقتة من 9 خانات على الأقل / Use a valid name, username, and a temporary password of at least 9 characters'},security);
      const record = passwordRecord(b.password);
      const admin = { id:id('usr'), name, username, role:'admin', active:true, mustChangePassword:true, createdAt:now(), ...record };
      store.users.push(admin); loginAttempts.delete(setupKey); audit(admin,'admin_setup','account','First administrator created; temporary password must be changed'); await persist();
      const sid=token(); sessions.set(sid,{userId:admin.id,expires:Date.now()+SESSION_TTL});
      return json(res,201,{user:publicUser(admin)}, {...security,'Set-Cookie':cookie('zezo_session',sid,SESSION_TTL/1000,req)});
    }
    if (req.method === 'POST' && path === '/api/client/register') {
      const b=await jsonBody(req),ip=req.socket.remoteAddress||'unknown';
      const email=normalizeEmail(b.email),name=clean(b.name,100),password=String(b.password||'');
      if(!rateAllowedFor(clientRegistrationAttempts,ip,8,60*60_000))return json(res,429,{error:'محاولات تسجيل كثيرة. حاول لاحقاً / Too many registration attempts. Try again later.'},security);
      if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!validPassword(password)||String(b.confirmPassword||'')!==password)return json(res,400,{error:'أكمل الاسم والبريد، وتأكد من تطابق كلمتي المرور (12 خانة على الأقل) / Enter your name and email, and make sure both passwords match (12+ characters).'},security);
      if(store.users.some(user=>normalizeEmail(user.email)===email||user.username===email))return json(res,409,{error:'يوجد حساب بهذا البريد. سجّل الدخول بدلاً من إنشاء حساب جديد / An account already exists for this email. Please sign in.'},security);
      const attribution=referralForRequest(req,b),createdAt=now(),verificationToken=emailReady()?token(32):'';
      const student=b.student==='true'||b.student===true;
      const user={id:id('usr'),name,username:email,email,phone:'',role:'client',active:!emailReady(),student,university:student?clean(b.university,120):'',emailVerified:false,createdAt,...passwordRecord(password)};
      bindClientReferral(user,attribution);
      if(verificationToken){user.emailVerificationHash=hash(verificationToken);user.emailVerificationExpires=Date.now()+24*60*60_000;}
      store.users.push(user);audit(user,'client_registered',user.id,user.referralCode?`Referral ${user.referralCode}`:'');await persist();
      if(verificationToken){const verifyUrl=`${siteBase(req)}/?verifyEmail=${encodeURIComponent(verificationToken)}`;await queueMail({to:email,kind:'client_email_verification',subject:'تأكيد بريد حساب ZEZO',text:`مرحباً ${name}،\n\nأكد بريدك لتفعيل حسابك في ZEZO خلال 24 ساعة:\n${verifyUrl}\n\nإذا لم تنشئ هذا الحساب، تجاهل الرسالة.`});void processMailQueue();return json(res,201,{verificationRequired:true,emailQueued:emailReady()},security);}
      const sid=token();sessions.set(sid,{userId:user.id,expires:Date.now()+SESSION_TTL});
      return json(res,201,{user:publicUser(user),verificationRequired:false,emailConfigured:false}, {...security,'Set-Cookie':cookie('zezo_session',sid,SESSION_TTL/1000,req)});
    }
    if(req.method==='POST'&&path==='/api/auth/verify-email'){
      const b=await jsonBody(req),verificationToken=String(b.token||'');
      const user=store.users.find(row=>row.role==='client'&&row.emailVerificationHash===hash(verificationToken)&&Number(row.emailVerificationExpires)>Date.now());
      if(!user)return json(res,400,{error:'رابط تأكيد البريد غير صالح أو منتهي / Verification link is invalid or expired'},security);
      user.emailVerificationHash=null;user.emailVerificationExpires=0;user.emailVerified=true;user.active=true;user.emailVerifiedAt=now();audit(user,'client_email_verified',user.id);await persist();
      const sid=token();sessions.set(sid,{userId:user.id,expires:Date.now()+SESSION_TTL});
      return json(res,200,{user:publicUser(user)}, {...security,'Set-Cookie':cookie('zezo_session',sid,SESSION_TTL/1000,req)});
    }
    if(req.method==='POST'&&path==='/api/auth/forgot-password'){
      const b=await jsonBody(req),email=normalizeEmail(b.email),ip=req.socket.remoteAddress||'unknown',user=store.users.find(row=>row.active&&normalizeEmail(row.email)===email);
      if(!rateAllowedFor(passwordResetAttempts,ip,8,60*60_000))return json(res,429,{error:'محاولات كثيرة. حاول لاحقاً / Too many reset requests. Try again later.'},security);
      if(user&&emailReady()){const resetToken=token(32);user.passwordResetHash=hash(resetToken);user.passwordResetExpires=Date.now()+60*60_000;await persist();const resetUrl=`${siteBase(req)}/?resetPassword=${encodeURIComponent(resetToken)}`;await queueMail({to:user.email,kind:'account_password_reset',subject:'إعادة تعيين كلمة مرور ZEZO',text:`استخدم الرابط خلال ساعة لإعادة تعيين كلمة المرور:\n${resetUrl}\n\nإذا لم تطلب ذلك، تجاهل الرسالة.`});void processMailQueue();}
      return json(res,202,{ok:true,message:'إذا كان البريد مرتبطاً بحساب نشط وخدمة البريد مفعّلة، فستصلك رسالة بالخطوات.'},security);
    }
    if(req.method==='POST'&&path==='/api/auth/reset-password'){
      const b=await jsonBody(req),resetToken=String(b.token||''),resetHash=hash(resetToken),user=store.users.find(row=>row.passwordResetHash===resetHash&&row.active);
      if(!user)return json(res,400,{error:'رابط إعادة التعيين غير صالح أو منتهي / Reset link is invalid or expired'},security);
      if(Number(user.passwordResetExpires)<=Date.now()){user.passwordResetHash=null;user.passwordResetExpires=0;await persist();return json(res,400,{error:'انتهت صلاحية رابط إعادة التعيين / Password reset link has expired'},security);}
      if(!validPassword(b.password))return json(res,400,{error:'كلمة المرور يجب أن تكون 12 خانة على الأقل / Password must contain at least 12 characters'},security);
      Object.assign(user,passwordRecord(String(b.password)));user.passwordResetHash=null;user.passwordResetExpires=0;user.mustChangePassword=false;audit(user,'password_reset',user.id);for(const [sid,session] of sessions)if(session.userId===user.id)sessions.delete(sid);await persist();
      const sid=token();sessions.set(sid,{userId:user.id,expires:Date.now()+SESSION_TTL});return json(res,200,{user:publicUser(user)}, {...security,'Set-Cookie':cookie('zezo_session',sid,SESSION_TTL/1000,req)});
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      const b=await jsonBody(req); const username=clean(b.username,150).toLowerCase(); const key=`${req.socket.remoteAddress}:${username}`;
      if (!rateAllowed(key)) return json(res,429,{error:'محاولات كثيرة. جرّب بعد 15 دقيقة / Too many attempts; try again in 15 minutes'},security);
      const user=store.users.find(u=>u.username===username&&u.active);
      if (!user || !passwordMatches(String(b.password||''),user) || !accountTypes[b.accountType]?.includes(user.role)) return json(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة لهذا النوع من الدخول / Incorrect username or password for this sign-in type'},security);
      if(sensitiveManagementRole(user.role)&&user.mfaEnabledAt&&!validTotp(user.mfaSecret,b.mfaCode))return json(res,401,{error:'أدخل رمز تطبيق المصادقة الحالي / Enter the current authenticator code',mfaRequired:true},security);
      loginAttempts.delete(key); const sid=token(); sessions.set(sid,{userId:user.id,expires:Date.now()+SESSION_TTL}); audit(user,'login',user.id); await persist();
      return json(res,200,{user:publicUser(user)}, {...security,'Set-Cookie':cookie('zezo_session',sid,SESSION_TTL/1000,req)});
    }
    if(req.method==='GET'&&path==='/api/auth/mfa/setup'){
      const auth=requireAuth(req,res,['admin','marketing_manager','hr_manager','order_manager']);if(!auth)return;
      if(auth.user.mfaEnabledAt)return json(res,409,{error:'التحقق بخطوتين مفعّل مسبقاً / Two-step verification is already enabled'},security);
      auth.user.mfaSetupSecret ||= base32Encode(randomBytes(20));await persist();
      const issuer='ZEZO Forge',label=encodeURIComponent(`${issuer}:${auth.user.username}`),otpAuthUri=`otpauth://totp/${label}?secret=${auth.user.mfaSetupSecret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
      return json(res,200,{secret:auth.user.mfaSetupSecret,otpAuthUri},security);
    }
    if(req.method==='POST'&&path==='/api/auth/mfa/enable'){
      const auth=requireAuth(req,res,['admin','marketing_manager','hr_manager','order_manager']);if(!auth)return;const b=await jsonBody(req);
      if(auth.user.mfaEnabledAt)return json(res,409,{error:'التحقق بخطوتين مفعّل مسبقاً / Two-step verification is already enabled'},security);
      if(!validTotp(auth.user.mfaSetupSecret,b.code))return json(res,400,{error:'رمز التحقق غير صحيح؛ افحص الساعة والرمز الحالي / Invalid code; check the device clock and current code'},security);
      auth.user.mfaSecret=auth.user.mfaSetupSecret;delete auth.user.mfaSetupSecret;auth.user.mfaEnabledAt=now();audit(auth.user,'management_mfa_enabled',auth.user.id);await persist();
      return json(res,200,{ok:true,user:publicUser(auth.user)},security);
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      const sid=cookieValue(req,'zezo_session'); const auth=sessionUser(req); if(auth) audit(auth.user,'logout',auth.user.id); sessions.delete(sid); await persist();
      return json(res,200,{ok:true}, {...security,'Set-Cookie':cookie('zezo_session','',0,req)});
    }
    if (req.method === 'POST' && path === '/api/auth/password') {
      const auth=requireAuth(req,res); if(!auth)return; const b=await jsonBody(req);
      if(!passwordMatches(String(b.currentPassword||''),auth.user)) return json(res,401,{error:'كلمة المرور الحالية غير صحيحة / Current password is incorrect'},security);
      if(!validPassword(b.newPassword)) return json(res,400,{error:'كلمة المرور الجديدة يجب أن تكون 12 خانة على الأقل / New password must be at least 12 characters'},security);
      Object.assign(auth.user,passwordRecord(b.newPassword)); auth.user.mustChangePassword=false; audit(auth.user,'password_changed',auth.user.id); await persist();
      return json(res,200,{ok:true},security);
    }
    if (req.method === 'PATCH' && path === '/api/profile') {
      const auth=requireAuth(req,res); if(!auth)return; const b=await jsonBody(req);
      const email=normalizeEmail(b.email); const phone=normalizePhone(b.phone);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:'أدخل بريداً إلكترونياً صالحاً / Enter a valid email address'},security);
      if(store.users.some(u=>u.id!==auth.user.id&&normalizeEmail(u.email)===email)) return json(res,409,{error:'البريد مستخدم لحساب آخر / Email is already used by another account'},security);
      if(auth.user.role==='client'){
        if(email!==normalizeEmail(auth.user.email))return json(res,409,{error:'لتغيير بريد تسجيل الدخول، تواصل مع خدمة العملاء حتى نتحقق من الحساب / Contact support to verify your account before changing its sign-in email'},security);
        const international=internationalPhone(b.whatsappCountryCode,b.whatsappLocalNumber,b.phone);
        if(phone&&!international)return json(res,400,{error:'أدخل رقم واتساب دولياً صالحاً / Enter a valid international WhatsApp number'},security);
        auth.user.phone=international||'';
        if(b.name!==undefined){const name=clean(b.name,100);if(name.length<2)return json(res,400,{error:'أدخل الاسم الكامل / Enter your full name'},security);auth.user.name=name;}
        if(b.student!==undefined)auth.user.student=b.student==='true'||b.student===true;
        if(b.university!==undefined)auth.user.university=auth.user.student?clean(b.university,120):'';
      }else auth.user.phone=phone;
      auth.user.email=email;
      if(b.instagram!==undefined)auth.user.instagram=clean(b.instagram,160);
      if(b.socialLinks!==undefined)auth.user.socialLinks=clean(b.socialLinks,800);
      if(b.telegramUsername!==undefined)auth.user.telegramUsername=clean(b.telegramUsername,80).replace(/^@/,'');
      if(['marketer','developer'].includes(auth.user.role)&&b.payoutHandle!==undefined) auth.user.payoutHandle=clean(b.payoutHandle,120);
      audit(auth.user,'profile_updated',auth.user.id); await persist();
      return json(res,200,{user:publicUser(auth.user),payoutHandle:auth.user.payoutHandle||''},security);
    }
    if (req.method === 'POST' && path === '/api/auth/activate') {
      const b=await jsonBody(req); const t=String(b.token||''),activationHash=hash(t),user=store.users.find(u=>u.activationHash===activationHash);
      if (!user) return json(res,400,{error:'رابط التفعيل غير صالح أو منتهي أو سبق استخدامه / Invalid, expired, or already used activation link'},security);
      if(Number(user.activationExpires)<=Date.now()){user.activationHash=null;user.activationExpires=0;user.inviteStatus='expired';await persist();return json(res,400,{error:'انتهت صلاحية الدعوة / Invitation has expired'},security);}
      if (!validPassword(b.password)) return json(res,400,{error:'كلمة المرور يجب أن تكون 12 خانة على الأقل / Password must be at least 12 characters'},security);
      Object.assign(user,passwordRecord(b.password)); user.activationHash=null; user.activationExpires=0; user.inviteStatus='accepted';user.inviteAcceptedAt=now();user.active=true; ensureMonthlyReferralLinks(); audit(user,'account_activated',user.id); await persist();
      const sid=token(); sessions.set(sid,{userId:user.id,expires:Date.now()+SESSION_TTL});
      return json(res,200,{user:publicUser(user)}, {...security,'Set-Cookie':cookie('zezo_session',sid,SESSION_TTL/1000,req)});
    }
    if(req.method==='POST'&&/^\/api\/client\/orders\/[^/]+\/quote-accept$/.test(path)){
      const auth=requireAuth(req,res,['client']);if(!auth)return;const orderId=path.split('/').at(-2),lead=store.leads.find(row=>row.id===orderId&&row.clientId===auth.user.id);
      if(!lead)return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      if(lead.isDuplicate||lead.status==='cancelled')return json(res,409,{error:'لا يمكن قبول عرض طلب ملغي أو مكرر / A cancelled or duplicate order cannot be accepted'},security);
      if(lead.quoteAcceptedAt)return json(res,200,{ok:true,duplicate:true},security);
      if(lead.status!=='proposal'||!Number.isFinite(Number(lead.contractAmount))||Number(lead.contractAmount)<0)return json(res,409,{error:'لا يوجد عرض سعر جاهز للقبول / No quote is ready to accept'},security);
      lead.quoteAcceptedAt=now();lead.agreedPriceSnapshot={amount:Number(lead.contractAmount),currency:'ILS',acceptedAt:lead.quoteAcceptedAt};lead.status='waiting_payment';lead.statusHistory??=[];lead.statusHistory.push({status:lead.status,at:lead.quoteAcceptedAt,note:'Quote accepted by customer'});setProjectStage(lead,'waiting_payment_to_start',auth.user,'Customer accepted the quote.');
      recordLeadMilestone(lead,'quote_accepted',auth.user);syncCrmCaseForOrder(lead,auth.user);audit(auth.user,'client_quote_accepted',lead.id,String(lead.contractAmount));await persist();
      await queueMail({recipientType:'admin',kind:'client_quote_accepted',subject:`تم قبول عرض السعر للطلب ${lead.id}`,text:`قبل العميل ${lead.name} عرض السعر بقيمة ${lead.contractAmount} ₪ للطلب ${lead.id}.`});void processMailQueue();
      return json(res,200,{ok:true,quoteAcceptedAt:lead.quoteAcceptedAt,status:lead.status},security);
    }
    if(req.method==='POST'&&/^\/api\/client\/orders\/[^/]+\/delivery$/.test(path)){
      const auth=requireAuth(req,res,['client']);if(!auth)return;const orderId=path.split('/').at(-2),lead=store.leads.find(row=>row.id===orderId&&row.clientId===auth.user.id);
      if(!lead)return json(res,404,{error:'المشروع غير موجود / Project not found'},security);
      const b=await jsonBody(req);if(!['received','revision'].includes(b.decision))return json(res,400,{error:'اختر تأكيد الاستلام أو طلب تعديل / Choose receipt confirmation or a revision request'},security);
      if(lead.clientDeliveryAt){if(b.decision==='received')return json(res,200,{ok:true,alreadyConfirmed:true,projectStage:lead.projectStage},security);return json(res,409,{error:'تم تأكيد الاستلام؛ تواصل مع ZEZO لطلب متابعة / Receipt is confirmed; contact ZEZO to request follow-up'},security);}
      if(!['ready_delivery','waiting_client_review'].includes(lead.projectStage)||lead.developerReviewStatus!=='approved')return json(res,409,{error:'لا توجد ملفات معتمدة لمراجعتها بعد / No approved delivery is ready to review'},security);
      if(b.decision==='revision'){
        lead.clientRevisionNote=clean(b.note,500);lead.clientRevisionAt=now();setProjectStage(lead,'needs_revisions',auth.user,'Client requested a revision.',lead.clientRevisionNote);lead.developerTaskStatus='revision_requested';lead.developerTaskNote=lead.clientRevisionNote;lead.developerReviewStatus='revision';lead.developerCommissionReview={decision:'revision',note:lead.clientRevisionNote,by:auth.user.username,at:now()};
        audit(auth.user,'client_delivery_revision_requested',lead.id,lead.clientRevisionNote||'');
        if(lead.developerUserId)notifyUser(lead.developerUserId,`client-revision:${lead.id}:${lead.clientRevisionAt}`,{type:'project',importance:'high',titleAr:'طلب العميل تعديلاً على التسليم',titleEn:'Customer requested a delivery revision',descriptionAr:'راجع ملاحظة العميل في المشروع المسند إليك.',descriptionEn:'Review the customer note on your assigned project.'},{tab:'development',targetId:lead.id,targetKind:'lead'});
        notifyRoles(['admin'],`client-revision:${lead.id}:${lead.clientRevisionAt}`,{type:'project',importance:'high',titleAr:'العميل يطلب تعديلاً على التسليم',titleEn:'Customer requested a delivery revision',descriptionAr:'راجع ملاحظة العميل وتابع المشروع.',descriptionEn:'Review the customer note and follow up on the project.'},{tabs:{admin:'requests'},targetId:lead.id,targetKind:'lead'});
      } else {
        lead.clientDeliveryAt=now();setProjectStage(lead,'delivered',auth.user,'Customer confirmed receipt.');audit(auth.user,'client_delivery_confirmed',lead.id);
        notifyRoles(['admin'],`client-delivered:${lead.id}:${lead.clientDeliveryAt}`,{type:'project',importance:'normal',titleAr:'العميل أكد استلام المشروع',titleEn:'Customer confirmed project receipt',descriptionAr:'يمكنك إغلاق المشروع بعد مراجعة سجل التسليم.',descriptionEn:'Review the delivery record and close the project when ready.'},{tabs:{admin:'requests'},targetId:lead.id,targetKind:'lead'});
      }
      syncCrmCaseForOrder(lead,auth.user);await persist();return json(res,200,{ok:true,projectStage:lead.projectStage},security);
    }
    if(req.method==='GET'&&/^\/api\/client\/orders\/[^/]+\/files\/(customer_upload|deliverable)\/\d+$/.test(path)){
      const auth=requireAuth(req,res,['client']);if(!auth)return;const pathParts=path.split('/'),orderId=pathParts[4],kind=pathParts[6],indexText=pathParts[7],lead=store.leads.find(row=>row.id===orderId&&row.clientId===auth.user.id);if(!lead)return json(res,404,{error:'الملف غير موجود / File not found'},security);
      const index=Number(indexText),canSeeDeliverables=lead.developerReviewStatus==='approved'&&['ready_delivery','waiting_client_review','delivered','completed'].includes(lead.projectStage||''),file=kind==='customer_upload'?lead.attachments?.[index]:canSeeDeliverables?lead.developerAttachments?.[index]:null;
      if(!file)return json(res,404,{error:'الملف غير موجود / File not found'},security);
      res.writeHead(200,{...security,'Content-Type':file.type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,'Cache-Control':'private, no-store'});return createReadStream(join(UPLOAD_DIR,file.storedName)).pipe(res);
    }
    if (req.method === 'POST' && path === '/api/leads') {
      const auth=requireAuth(req,res,['client']);if(!auth)return;
      if(!publicRateAllowed(req.socket.remoteAddress||'unknown')) return json(res,429,{error:'وصلنا الحد المؤقت للطلبات من هذا الاتصال. حاول لاحقاً / Too many enquiries from this connection. Please try again later.'},security);
      let b, file;
      if ((req.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data')) { const parsed=parseMultipart(await bodyBuffer(req),req.headers['content-type']); b=parsed.fields; file=parsed.file; }
      else b=await jsonBody(req);
      if (clean(b.website,120)) return json(res,201,{ok:true});
      const name=auth.user.name, email=normalizeEmail(auth.user.email), phone=internationalPhone(b.whatsappCountryCode,b.whatsappLocalNumber,b.phone), details=clean(b.details,3000);
      const requestedTemplateId=clean(b.templateId,80), requestedTemplate= requestedTemplateId ? templateById.get(requestedTemplateId) : null;
      const requestedAction=clean(b.templateAction,24);
      if(name.length<2||!email||!isE164Phone(phone)||details.length<12||!serviceCategories[b.service]?.includes(b.category)||b.consent!=='true') return json(res,400,{error:'أكمل بيانات الطلب وأدخل رقم واتساب صحيحاً مع مفتاح الدولة / Complete the request and enter a valid WhatsApp number with country code'},security);
      if(requestedTemplateId && (!requestedTemplate || requestedTemplate.service!==b.service || requestedTemplate.category!==b.category || !['order','customize'].includes(requestedAction))) return json(res,400,{error:'القالب المختار غير صالح لهذا الطلب / The selected template does not match this request'},security);
      if(requestedTemplateId&&store.settings.templateActive?.[requestedTemplateId]===false)return json(res,409,{error:'هذا القالب متوقف للطلبات حالياً؛ تواصل معنا لطلب بديل / This template is temporarily unavailable for orders; contact us for an alternative'},security);
      const conversationId=clean(b.conversationId,80),linkedConversation=conversationId?store.conversations.find(item=>item.id===conversationId):null,guest=guestSessionValue(req);
      if(conversationId&&(!linkedConversation||!(linkedConversation.clientId===auth.user.id||(!linkedConversation.clientId&&guest&&linkedConversation.guestSessionHash===hash(guest)))))return json(res,403,{error:'لا يمكن ربط الطلب بهذه المحادثة / This conversation cannot be linked to your request'},security);
      if(linkedConversation&&(linkedConversation.leadId||linkedConversation.status==='converted'))return json(res,409,{error:'هذه المحادثة مرتبطة بطلب رسمي مسبقاً / This conversation already has an official request'},security);
      if(linkedConversation?.templateId&&linkedConversation.templateId!==requestedTemplateId)return json(res,400,{error:'القالب لا يطابق المحادثة / Template does not match the conversation'},security);
      const attachment=await saveUpload(file); const existingClientReferral=auth.user.referralUserId?referralLinkForCode(auth.user.referralCode||''):null;const conversationReferral=linkedConversation?.referralCode?referralLinkForCode(linkedConversation.referralCode):null;const resolvedReferral=existingClientReferral||conversationReferral||referralForRequest(req,b);const ref=resolvedReferral?.code||resolvedReferral?.user?.currentReferralCode||resolvedReferral?.user?.referralCode||'';let refUser=resolvedReferral?.user||null;
      const selfReferral=Boolean(refUser&&((refUser.email&&normalizeEmail(refUser.email)===email)||(refUser.phone&&normalizePhone(refUser.phone)===phone)));
      if(selfReferral){audit(null,'self_referral_blocked',refUser.id,'Matching employee email or phone');refUser=null;}
      const trackingToken=token(32), createdAt=now(), service=clean(b.service,60), category=clean(b.category,80),acceptedQuote=linkedConversation?.quote?.status==='accepted'?linkedConversation.agreedPriceSnapshot:null,initialStatus=acceptedQuote?'waiting_payment':'new';
      const duplicateLead=findDuplicateLead({email,phone,service,category,details});
      const lead={id:id('lead'),createdAt,language:b.lang==='en'?'en':'ar',name,email,phone,clientId:auth.user.id,clientWhatsappPhone:phone,service,category,details,budget:clean(b.budget,80),templateId:requestedTemplate?.id||'',templateName:requestedTemplate?.title?.ar||'',templateAction:requestedAction||'',priceSnapshot:requestedTemplate?{templateId:requestedTemplate.id,amount:store.settings.templatePrices?.[requestedTemplate.id]??200,currency:'ILS',capturedAt:createdAt}:null,priceSnapshotHistory:[],status:'new',statusHistory:[{status:'new',at:createdAt,note:''}],projectStage:'new_request',projectHistory:[{stage:'new_request',at:createdAt,by:auth.user.username,note:'Project request received.',clientNote:'استلمنا طلب مشروعك.'}],projectStartedAt:'',projectDeliveredAt:'',clientDeliveryAt:'',publicStatusNote:'',referralCode:refUser?ref:null,referralUserId:refUser?.id||null,referralLinkId:refUser?resolvedReferral?.link?.id||null:null,contractAmount:null,paidTotal:0,commissionAmount:null,commissionRate:null,commissionStatus:refUser?'pending_setup':'none',attachments:attachment?[attachment]:[],refunded:false,isDuplicate:Boolean(duplicateLead),duplicateOfLeadId:duplicateLead?.id||null,trackingHash:hash(trackingToken),trackingExpires:Date.now()+TRACKING_TTL_MS};
      if(requestedTemplate){const amount=store.settings.templatePrices?.[requestedTemplate.id]??200;lead.priceSnapshot={templateId:requestedTemplate.id,amount,currency:'ILS',kind:'starting_price',includedScope:store.settings.templateInclusions?.[requestedTemplate.id]||defaultTemplateInclusion,capturedAt:createdAt};}
      lead.conversationId=linkedConversation?.id||null;lead.source=linkedConversation?.source||(refUser?'referral':'website');lead.orderManagerUserId=linkedConversation?.assignedUserId||null;
      if(acceptedQuote){lead.agreedPriceSnapshot={...acceptedQuote};lead.quoteAcceptedAt=acceptedQuote.acceptedAt;lead.contractAmount=Number(acceptedQuote.amount);lead.status='waiting_payment';lead.statusHistory=[{status:'waiting_payment',at:createdAt,note:'Customer accepted the template quote.'}];lead.projectStage='waiting_payment_to_start';lead.projectHistory=[{stage:'waiting_payment_to_start',at:createdAt,by:auth.user.username,note:'Customer accepted a quote in the template conversation.',clientNote:'استلمنا طلب مشروعك بعد قبول عرض السعر.'}];}
      auth.user.phone=phone;bindClientReferral(auth.user,resolvedReferral);store.leads.unshift(lead);ensureCrmCaseForOrder(lead);if(linkedConversation){linkedConversation.clientId=auth.user.id;linkedConversation.guestSessionHash=null;linkedConversation.leadId=lead.id;linkedConversation.status='converted';linkedConversation.updatedAt=now();appendConversationMessage(linkedConversation,{senderType:'client',senderId:auth.user.id,text:`تم إنشاء الطلب الرسمي ${lead.id} وربطه بهذه المحادثة.`});}if(refUser&&!lead.isDuplicate)recordLeadMilestone(lead,'project_request');audit(auth.user,'client_project_request',lead.id,duplicateLead?`Duplicate of ${duplicateLead.id}`:refUser?`Referral ${ref}`:'No referral');await persist();
      const trackingUrl=`${siteBase(req)}/?track=${encodeURIComponent(trackingToken)}`;
      await queueMail({recipientType:'admin',kind:'new_lead',subject:`طلب جديد من ${name}`,text:`طلب مشروع جديد في ZEZO\nالاسم: ${name}\nالبريد: ${email}\nواتساب: ${phone}\nالخدمة: ${lead.service} / ${lead.category}${lead.templateName?`\nالقالب: ${lead.templateName} (${lead.templateAction})`:''}\nالميزانية: ${lead.budget||'غير محددة'}\nالإحالة: ${lead.referralCode||'بدون إحالة'}\nتفاصيل الطلب:\n${details}\nإدارة الطلب: ${siteBase(req)}/`});
      await queueMail({to:email,kind:'customer_thanks',subject:lead.language==='en'?'Thank you for your ZEZO enquiry':'شكراً لطلبك من ZEZO',text:lead.language==='en'?`Hello ${name},\n\nThank you for reaching out to ZEZO. We received your project enquiry and will review it.\n\nTrack your request securely here: ${trackingUrl}\n\nZEZO Digital Solutions & AI`:`مرحباً ${name}،\n\nشكراً لتواصلك مع ZEZO. وصلنا طلب مشروعك وسنراجعه.\n\nتابع حالة طلبك عبر هذا الرابط الخاص: ${trackingUrl}\n\nZEZO للحلول الرقمية والذكاء الاصطناعي`});
      return json(res,201,{ok:true,id:lead.id,attributed:Boolean(refUser),trackingToken,emailQueued:emailReady()&&adminEmailReady(),mail:{customerConfigured:emailReady(),adminConfigured:emailReady()&&adminEmailReady()}},security);
    }
    if (req.method === 'POST' && path === '/api/admin/invite') {
      const auth=requireAuth(req,res,['admin','hr_manager']); if(!auth)return; const b=await jsonBody(req);
      const name=clean(b.name,80), username=clean(b.username,40).toLowerCase(), email=normalizeEmail(b.email); let role=clean(b.role,40);
      if(role==='admin'&&(auth.user.role!=='admin'||!auth.user.mfaEnabledAt||!validTotp(auth.user.mfaSecret,b.ownerMfaCode)))return json(res,403,{error:'إنشاء دعوة مالك يحتاج تحققاً إضافياً من تطبيق المصادقة / Creating an Owner invitation requires fresh authenticator verification'},security);
      if(auth.user.role==='hr_manager'&&!hasPermission(auth.user,'team.invite',{department:'people'}))return json(res,403,{error:'لا تملك تفويض إنشاء دعوات / You are not delegated to create invitations'},security);
      if(auth.user.role==='hr_manager'&&!(['marketer','developer'].includes(role)||(role==='order_manager'&&effectivePermission(auth.user,'team.invite')==='all'))) return json(res,403,{error:'مسؤول الموظفين لا يعيّن إلا الأدوار المفوضة له صراحة / HR cannot invite roles beyond its explicit delegation'},security);
      if(!roles.includes(role) || (role==='admin'&&auth.user.role!=='admin') || name.length<2 || !/^[a-z0-9._-]{3,40}$/.test(username)||!/^\S+@\S+\.\S+$/.test(email)) return json(res,400,{error:'بيانات الموظف غير مكتملة أو الدور غير مسموح / Invalid employee details or role'},security);
      if(store.users.some(u=>u.username===username)) return json(res,409,{error:'اسم المستخدم مستخدم / Username is already in use'},security);
      if(store.users.some(u=>normalizeEmail(u.email)===email)) return json(res,409,{error:'البريد مستخدم لحساب آخر / Email is already used by another account'},security);
      const activation=token(32),createdAt=now(),expiresAt=new Date(Date.now()+24*60*60_000).toISOString();
       const user={id:id('usr'),name,username,email,phone:'',instagram:'',socialLinks:clean(b.socialLinks,800),telegramUsername:'',role,department:roleDepartment(role),permissionOverrides:{},active:false,createdAt,inviteCreatedBy:auth.user.id,inviteCreatedByName:auth.user.name,inviteStatus:'pending',inviteExpiresAt:expiresAt,inviteApprovalStatus:'approved',activationHash:hash(activation),activationExpires:Date.parse(expiresAt)};
      if(referralEnabled(user)){user.referralCode=newReferralCode();user.rank='rookie';user.activeCommissionRate=15;user.teamLeaderTermsPending=false;}
      store.users.push(user); audit(auth.user,'employee_invited',user.id,`${role} ${username}`); await persist();
      const activationUrl=siteBase(req)+'/activate?token='+encodeURIComponent(activation);await queueMail({to:email,kind:'team_invitation',subject:'دعوة للانضمام إلى ZEZO',text:'مرحباً '+name+'،\n\nأنشأنا لك حساباً في مساحة فريق ZEZO بدور: '+role+'.\nفعّل الحساب وأنشئ كلمة مرورك خلال 24 ساعة عبر الرابط التالي:\n'+activationUrl+'\n\nبعد التفعيل ادخل إلى مساحة الفريق عبر: '+siteBase(req)+'/team\n\nإذا لم تكن تتوقع هذه الدعوة، تجاهل الرسالة.'});void processMailQueue();
      return json(res,201,{user:publicUser(user),activationToken:activation,approvalRequired:false,expiresInHours:24,emailQueued:emailReady()},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/admin/invitations/')) {
      const auth=requireAuth(req,res,['admin']); if(!auth)return; const userId=path.split('/').at(-1),target=store.users.find(u=>u.id===userId);
      if(!target||target.active)return json(res,404,{error:'الدعوة غير موجودة أو تم تفعيلها / Invitation not found or already accepted'},security);
      const b=await jsonBody(req),decision=clean(b.status||b.action,20);
      if(decision!=='revoked')return json(res,400,{error:'الإجراء المسموح هو إلغاء الدعوة المعلّقة / Only pending invitations can be revoked'},security);
      if(!['pending','pending_approval'].includes(invitationStatus(target)))return json(res,409,{error:'الدعوة لم تعد معلّقة / Invitation is no longer pending'},security);
      target.inviteStatus='revoked';target.inviteRevokedAt=now();target.inviteRevokedBy=auth.user.id;target.activationHash=null;target.activationExpires=0;target.inviteExpiresAt=null;
      audit(auth.user,'employee_invitation_revoked',target.id,target.role);await persist();
      return json(res,200,{user:publicUser(target)},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/admin/invitations/')&&path.endsWith('/resend')){
      const auth=requireAuth(req,res,['admin','hr_manager']);if(!auth)return;const invitationId=path.split('/').at(-2),target=store.users.find(u=>u.id===invitationId);
      if(!target||target.active)return json(res,404,{error:'الدعوة غير موجودة أو سبق تفعيلها / Invitation not found or already accepted'},security);
      if(auth.user.role==='hr_manager'&&(target.inviteCreatedBy!==auth.user.id||!inviteableEmployeeRoles.includes(target.role)))return json(res,403,{error:'يمكنك تجديد الدعوات التشغيلية التي أنشأتها فقط / You can resend only operational invitations you created'},security);
      if(!['expired','revoked'].includes(invitationStatus(target)))return json(res,409,{error:'لا يمكن تجديد دعوة صالحة أو قيد الانتظار / Only expired or revoked invitations can be reissued'},security);
      const activation=token(32),expiresAt=new Date(Date.now()+24*60*60_000).toISOString();target.inviteStatus='pending';target.inviteExpiresAt=expiresAt;target.activationHash=hash(activation);target.activationExpires=Date.parse(expiresAt);target.inviteApprovalStatus='approved';delete target.inviteRevokedAt;delete target.inviteRevokedBy;
      const activationUrl=siteBase(req)+'/activate?token='+encodeURIComponent(activation);audit(auth.user,'employee_invitation_resent',target.id,target.role);await persist();await queueMail({to:target.email,kind:'team_invitation',subject:'تجديد دعوة ZEZO',text:'مرحباً '+target.name+'،\n\nتم إصدار رابط تفعيل جديد لحسابك في مساحة فريق ZEZO. الرابط صالح لمرة واحدة ولمدة 24 ساعة:\n'+activationUrl+'\n\nبوابة الفريق: '+siteBase(req)+'/team'});void processMailQueue();
      return json(res,200,{user:publicUser(target),activationToken:activation,expiresInHours:24,emailQueued:emailReady()},security);
    }
    if(req.method==='PATCH'&&/^\/api\/admin\/permissions\/[^/]+$/.test(path)){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const target=store.users.find(user=>user.id===path.split('/').at(-1));if(!target)return json(res,404,{error:'الحساب غير موجود / Account not found'},security);
      if(target.role==='admin')return json(res,409,{error:'حساب المالك محمي من تغيير الدور أو الصلاحيات من لوحة التفويض / Owner account is protected from permission changes here'},security);
      const b=await jsonBody(req),nextRole=b.role===undefined?target.role:clean(b.role,40);
      if(!roles.includes(nextRole)||nextRole==='admin')return json(res,400,{error:'اختر دور موظف صالحاً؛ تعيين Owner يحتاج دعوة مالك منفصلة / Choose a valid employee role; Owner accounts require a separate owner invitation'},security);
      const changes=b.permissions;
      if(changes!==undefined&&(!changes||typeof changes!=='object'||Array.isArray(changes)))return json(res,400,{error:'صيغة الصلاحيات غير صالحة / Invalid permission settings'},security);
      const overrides={...(target.permissionOverrides||{})};
      for(const [key,value] of Object.entries(changes||{})){
        if(!Object.hasOwn(permissionDefinitions,key))return json(res,400,{error:`صلاحية غير معروفة / Unknown permission: ${key}`},security);
        if(value===null||value==='default'){delete overrides[key];continue;}
        if(value!=='none'&&!permissionDefinitions[key].includes(value))return json(res,400,{error:`نطاق غير مسموح / Unsupported scope for ${key}`},security);
        overrides[key]=value;
      }
      if(b.active===false&&target.role==='admin')return json(res,409,{error:'حساب المالك محمي من التعطيل العرضي / Owner account is protected from accidental deactivation'},security);
      const before={role:target.role,active:target.active,permissionOverrides:target.permissionOverrides||{}};
      target.role=nextRole;target.department=b.department==='people'&&nextRole==='hr_manager'?'people':roleDepartment(nextRole);target.permissionOverrides=overrides;
      if(typeof b.active==='boolean'){target.active=b.active;if(b.active)delete target.accountDisabledAt;else target.accountDisabledAt=now();}
      if(target.inviteCreatedBy===auth.user.id&&b.active===false)target.inviteStatus='revoked';
      for(const [sid,session] of sessions)if(session.userId===target.id)sessions.delete(sid);
      audit(auth.user,'employee_permissions_updated',target.id,JSON.stringify({beforeRole:before.role,role:target.role,active:target.active,permissions:Object.keys(changes||{})}));await persist();
      return json(res,200,{ok:true,user:{...publicUser(target),department:target.department,permissionOverrides:target.permissionOverrides,effectivePermissions:Object.fromEntries(Object.keys(permissionDefinitions).map(key=>[key,effectivePermission(target,key)]))}},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/admin/team/')) {
      const auth=requireAuth(req,res,['admin']); if(!auth)return; const userId=path.split('/').at(-1); const target=store.users.find(u=>u.id===userId);
      if(!target||target.id===auth.user.id) return json(res,404,{error:'الموظف غير موجود / Employee not found'},security);
      const b=await jsonBody(req);
      if(target.role==='admin'||b.role==='admin')return json(res,409,{error:'حساب المالك محمي؛ لا يمكن تغيير الملكية أو دور Owner من هذا المسار / Owner accounts are protected from role transfer here'},security);
      if(['email','phone','instagram','socialLinks','telegramUsername'].some(key=>Object.hasOwn(b,key))) return json(res,403,{error:'يحدّث الموظف بيانات تواصله من ملفه الشخصي / Employees update their own contact details from their profile'},security);
      if(b.role!==undefined){if(!roles.includes(b.role))return json(res,400,{error:'الدور غير صالح / Invalid role'},security);if(target.role==='admin'&&b.role!=='admin'&&store.users.filter(u=>u.role==='admin'&&u.active).length<=1)return json(res,409,{error:'يجب أن يبقى حساب مالك نشط واحد على الأقل / Keep at least one active owner account'},security);target.role=b.role;if(referralEnabled(target)){target.referralCode ||= newReferralCode();target.rank ||= 'rookie';target.activeCommissionRate ??= 15;target.teamLeaderTermsPending ??= false;}}
      if(b.active===false&&target.role==='admin'&&store.users.filter(u=>u.role==='admin'&&u.active).length<=1)return json(res,409,{error:'لا يمكن تعطيل آخر حساب مالك نشط / Cannot disable the last active owner account'},security);
      if(typeof b.active==='boolean'){target.active=b.active;if(b.active)delete target.accountDisabledAt;else target.accountDisabledAt=now();}
      if(b.name) target.name=clean(b.name,80);
      if(b.role!==undefined||b.active===false){for(const [sid,session] of sessions)if(session.userId===target.id)sessions.delete(sid);}
      audit(auth.user,'employee_updated',target.id); await persist(); return json(res,200,{user:publicUser(target)},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/marketing/leads/')) {
      const auth=requireAuth(req,res,['admin','marketing_manager']); if(!auth)return;const lead=store.leads.find(l=>l.id===path.split('/').at(-1));if(!lead)return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      if(auth.user.role!=='admin'&&!requirePermission(auth,res,'orders.manage',{assigneeId:lead.orderManagerUserId||'',ownerId:lead.clientId||'',department:'orders'}))return;
      const b=await jsonBody(req);if(b.status!==undefined&&!['new','review','proposal'].includes(b.status))return json(res,403,{error:'مدير التسويق يستطيع متابعة الاستفسار حتى العرض فقط / Marketing support can update enquiries through proposal only'},security);
      if(b.status!==undefined)lead.status=b.status;
      if(b.supportNote!==undefined){const note=clean(b.supportNote,500);if(note){lead.supportNotes??=[];lead.supportNotes.unshift({id:id('note'),at:now(),by:auth.user.username,note});lead.supportNotes=lead.supportNotes.slice(0,30);}}
      syncCrmCaseForOrder(lead,auth.user);audit(auth.user,'customer_support_updated',lead.id,lead.status);await persist();
      return json(res,200,{lead:safeOrderLead(lead,true)},security);
    }
    if(req.method==='POST'&&path==='/api/marketing/campaigns'){
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;const b=await jsonBody(req),name=clean(b.name,100),channel=clean(b.channel,40),status=clean(b.status,20),budget=b.budget===''||b.budget==null?null:Number(b.budget);
      if(name.length<3||!['instagram','facebook','tiktok','whatsapp','email','other'].includes(channel)||!['planned','active','paused','complete'].includes(status)||(budget!==null&&(!Number.isFinite(budget)||budget<0||budget>1000000)))return json(res,400,{error:'تحقق من اسم الحملة وقناتها وميزانيتها / Check campaign name, channel, and budget'},security);
      const campaign={id:id('camp'),name,channel,status,budget:budget===null?null:money(budget),startDate:clean(b.startDate,20),notes:clean(b.notes,800),createdBy:auth.user.username,createdAt:now()};store.campaigns.unshift(campaign);audit(auth.user,'campaign_created',campaign.id,name);await persist();return json(res,201,{campaign},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/marketing/campaigns/')){
      const auth=requireAuth(req,res,['admin','marketing_manager']);if(!auth)return;const campaign=store.campaigns.find(item=>item.id===path.split('/').at(-1));if(!campaign)return json(res,404,{error:'الحملة غير موجودة / Campaign not found'},security);const b=await jsonBody(req);
      if(b.name!==undefined){const v=clean(b.name,100);if(v.length<3)return json(res,400,{error:'اسم الحملة قصير جداً / Campaign name is too short'},security);campaign.name=v;}
      if(b.status!==undefined){if(!['planned','active','paused','complete'].includes(b.status))return json(res,400,{error:'حالة الحملة غير صالحة / Invalid campaign status'},security);campaign.status=b.status;}
      if(b.budget!==undefined){const v=b.budget===''||b.budget===null?null:Number(b.budget);if(v!==null&&(!Number.isFinite(v)||v<0||v>1000000))return json(res,400,{error:'الميزانية غير صالحة / Invalid budget'},security);campaign.budget=v===null?null:money(v);}
      if(b.notes!==undefined)campaign.notes=clean(b.notes,800);audit(auth.user,'campaign_updated',campaign.id);await persist();return json(res,200,{campaign},security);
    }
    if(req.method==='PATCH'&&/^\/api\/projects\/[^/]+\/assignment$/.test(path)){
      const auth=requireAuth(req,res,['admin','marketing_manager','hr_manager','order_manager']);if(!auth)return;const leadId=path.split('/').at(-2),lead=store.leads.find(item=>item.id===leadId);if(!lead)return json(res,404,{error:'المشروع غير موجود / Project not found'},security);
      if(auth.user.role!=='admin'&&!requirePermission(auth,res,'projects.assign',{assigneeId:lead.developerUserId||'',ownerId:lead.clientId||'',department:'development'}))return;
      const b=await jsonBody(req),nextId=clean(b.developerUserId,80),developer=nextId?store.users.find(user=>user.id===nextId&&user.role==='developer'&&user.active&&!user.accountDisabledAt):null;
      if(nextId&&!developer)return json(res,400,{error:'اختر مبرمجاً نشطاً من الفريق / Select an active developer'},security);
      if(lead.developerUserId!==nextId&&lead.developerUserId&&['accepted','in_progress','review_requested','approved','revision_requested'].includes(lead.developerTaskStatus))return json(res,409,{error:'لا يمكن تغيير المبرمج بعد بدء المهمة / Developer cannot be changed after work starts'},security);
      if(lead.developerUserId!==nextId&&Number(lead.developerCommissionPaidAmount||0)>0)return json(res,409,{error:'لا يمكن تغيير المبرمج بعد صرف مستحقات تنفيذ / Developer cannot be changed after an execution payout'},security);
      const dueDate=clean(b.developerDueDate,10);if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))return json(res,400,{error:'موعد التسليم غير صالح / Invalid due date'},security);
      const priorDeveloper=lead.developerUserId;lead.developerUserId=developer?.id||null;lead.developerDueDate=dueDate;lead.developerCommissionRate=developerCommissionRate;lead.developerReviewStatus=null;lead.developerCommissionReview=null;lead.developerCommissionHoldUntil=null;lead.developerTaskStatus=developer?'offered':'';lead.developerAssignedAt=developer?now():null;
      if(developer)setProjectStage(lead,'waiting_developer_acceptance',auth.user,'Developer assignment sent.');else if(['waiting_developer_acceptance','in_progress','technical_review','needs_revisions'].includes(lead.projectStage))setProjectStage(lead,'under_review',auth.user,'Developer assignment cleared.');
      updateDeveloperCommission(lead);syncCrmCaseForOrder(lead,auth.user);audit(auth.user,'developer_assigned',lead.id,`developer=${developer?.id||'none'}; due=${dueDate||'none'}`);await persist();
      if(developer?.email)await queueMail({to:developer.email,kind:'developer_project_assigned',subject:`مهمة مشروع جديدة — ${lead.id}`,text:`لديك مهمة مشروع جديدة في مساحة ZEZO.\nرقم المشروع: ${lead.id}\nالخدمة: ${lead.service} / ${lead.category}\nقيمة الاتفاق: ${lead.contractAmount||0} ₪\nعمولة التنفيذ: 25٪ (المتوقع ${money(Number(lead.contractAmount||0)*0.25)} ₪)\nالموعد المطلوب: ${dueDate||'غير محدد'}\nافتح حسابك لمراجعة التفاصيل وقبول المهمة أو الاعتذار.`});
      if(developer&&developer.id!==priorDeveloper)notifyUser(developer.id,`developer-project:${lead.id}:${lead.developerAssignedAt}`,{type:'project',importance:'high',titleAr:'أُسند إليك مشروع جديد',titleEn:'A new project was assigned to you',descriptionAr:`مراجعة المهمة ${lead.id} وقبولها أو الاعتذار عنها.`,descriptionEn:`Review task ${lead.id} and accept it or decline.`},{tab:'development',targetId:lead.id,targetKind:'lead'});
      return json(res,200,{lead:safeOrderLead(lead,auth.user.role==='admin'||hasPermission(auth.user,'orders.manage',{assigneeId:lead.orderManagerUserId||'',department:'orders'}))},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/hr/withdrawals/')){
      const auth=requireAuth(req,res,['hr_manager']);if(!auth)return;if(!requirePermission(auth,res,'withdrawals.review',{department:'people'}))return;const withdrawal=store.withdrawals.find(item=>item.id===path.split('/').at(-1));if(!withdrawal||!['pending','under_review'].includes(withdrawal.status))return json(res,404,{error:'طلب السحب المعلّق غير موجود / Pending withdrawal not found'},security);const b=await jsonBody(req);
      if(!['recommend','needs_review','decline_recommendation'].includes(b.decision))return json(res,400,{error:'اختر نتيجة المراجعة / Choose a review result'},security);
      const priorStatus=withdrawal.status;withdrawal.status='under_review';withdrawal.hrReview={decision:b.decision,note:clean(b.note,300),by:auth.user.username,at:now()};withdrawal.updatedAt=now();withdrawal.statusHistory??=[];withdrawal.statusHistory.push({status:'under_review',from:priorStatus,at:withdrawal.updatedAt,by:auth.user.username,decision:b.decision});audit(auth.user,'withdrawal_reviewed',withdrawal.id,b.decision);await persist();return json(res,200,{id:withdrawal.id,status:withdrawal.status,hrReview:withdrawal.hrReview},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/hr/commissions/')){
      const auth=requireAuth(req,res,['hr_manager']);if(!auth)return;const lead=store.leads.find(item=>item.id===path.split('/').at(-1));if(!lead)return json(res,404,{error:'المشروع غير موجود / Project not found'},security);const b=await jsonBody(req);
      lead.financialReview={note:clean(b.note,500),by:auth.user.username,at:now()};audit(auth.user,'commission_reviewed',lead.id,lead.financialReview.note);await persist();return json(res,200,{id:lead.id,financialReview:lead.financialReview},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/orders/')) {
      const auth=requireAuth(req,res,['admin','hr_manager','marketing_manager','order_manager']); if(!auth)return; const leadId=path.split('/').at(-1); const lead=store.leads.find(l=>l.id===leadId);
      if(!lead) return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      if(auth.user.role!=='admin'&&!requirePermission(auth,res,'orders.manage',{assigneeId:lead.orderManagerUserId||'',ownerId:lead.clientId||'',department:'orders'}))return;
      const b=await jsonBody(req), allowedOrderStatuses=['new','review','proposal','active','waiting_payment'];
      if(b.status!==undefined&&!allowedOrderStatuses.includes(clean(b.status,30))) return json(res,403,{error:'هذه الحالة تحتاج موافقة المدير / This status requires administrator approval'},security);
      if(auth.user.role!=='admin'&&b.contractAmount!==undefined)return json(res,403,{error:'تعديل السعر النهائي يحتاج موافقة المالك / Final contract price changes require Owner approval'},security);
      const nextAmount=b.contractAmount===undefined?lead.contractAmount:(b.contractAmount===''||b.contractAmount===null?null:Number(b.contractAmount));
      if(nextAmount!==null&&nextAmount!==undefined&&(!Number.isFinite(nextAmount)||nextAmount<0||nextAmount>10000000)) return json(res,400,{error:'قيمة العقد غير صالحة / Invalid contract amount'},security);
      if(nextAmount===null&&lead.paidTotal>0) return json(res,409,{error:'لا يمكن مسح قيمة العقد بعد تسجيل دفعة / Contract amount cannot be cleared after a payment is recorded'},security);
      if(nextAmount!==null&&nextAmount!==undefined&&nextAmount<lead.paidTotal) return json(res,409,{error:'قيمة العقد أقل من الدفعات المسجلة / Contract amount is below recorded payments'},security);
      const oldStatus=lead.status,oldNote=lead.publicStatusNote||'';
      if(b.status!==undefined)lead.status=clean(b.status,30);
      if(b.contractAmount!==undefined)lead.contractAmount=nextAmount;
      if(b.publicStatusNote!==undefined)lead.publicStatusNote=clean(b.publicStatusNote,500);
      if(oldStatus!==lead.status){lead.statusHistory??=[];lead.statusHistory.push({status:lead.status,at:now(),by:auth.user.username,note:lead.publicStatusNote||''});}
      updateCommission(lead); audit(auth.user,'hr_order_updated',lead.id,lead.status+'; amount='+(lead.contractAmount??'')); await persist();
      if((oldStatus!==lead.status||oldNote!==(lead.publicStatusNote||''))&&lead.email){
        const statusText=publicStatusLabels[lead.status]?.[lead.language||'ar']||lead.status;
        const emailText=lead.language==='en'?'Hello '+lead.name+',\n\nYour project status is now: '+statusText+'.'+(lead.publicStatusNote?'\n\nUpdate: '+lead.publicStatusNote:'')+'\n\nUse the tracking link from your original confirmation email to follow progress.':'مرحباً '+lead.name+'،\n\nحالة طلبك الآن: '+statusText+'.'+(lead.publicStatusNote?'\n\nالتحديث: '+lead.publicStatusNote:'')+'\n\nاستخدم رابط التتبع الموجود في رسالة التأكيد لمتابعة التقدم.';
        await queueMail({to:lead.email,kind:'project_status',subject:lead.language==='en'?'Your ZEZO project update':'تحديث على طلبك لدى ZEZO',text:emailText});
      }
      return json(res,200,{lead:{id:lead.id,status:lead.status,contractAmount:lead.contractAmount,publicStatusNote:lead.publicStatusNote||''}},security);
    }
    if (req.method === 'POST' && path === '/api/admin/pricing') {
      const auth=requireAuth(req,res,['admin']); if(!auth)return; const b=await jsonBody(req);
      if(!Array.isArray(b.prices)||b.prices.length>100) return json(res,400,{error:'قائمة الأسعار غير صالحة / Invalid price list'},security);
      const prices=[...(store.settings.prices||[])];
      for(const item of b.prices){
        const priceId=clean(item.id,60),index=prices.findIndex(p=>p.id===priceId),base=index>=0?prices[index]:initialPrices.find(p=>p.id===priceId);
        if(!/^[a-z0-9][a-z0-9-]{2,59}$/.test(priceId)||(!base&&(!clean(item.ar,100)||!clean(item.en,100))))return json(res,400,{error:'أدخل معرّفاً واسمين عربي وإنجليزي صالحين للسعر / Enter a valid ID and Arabic and English names'},security);
        const mode=item.pricingMode??base?.pricingMode??'fixed';if(!['fixed','quote'].includes(mode))return json(res,400,{error:'نوع التسعير غير صالح / Invalid pricing mode'},security);
        const raw=item.price??base?.price,amount=raw===''||raw===null||raw===undefined?null:Number(raw);
        if(mode==='fixed'&&(!Number.isFinite(amount)||amount<0||amount>10000000))return json(res,400,{error:'أدخل سعراً ثابتاً صالحاً / Enter a valid fixed price'},security);
        const next={...(base||{}),id:priceId,ar:clean(item.ar??base?.ar,100),en:clean(item.en??base?.en,100),detailsAr:clean(item.detailsAr??base?.detailsAr,500),detailsEn:clean(item.detailsEn??base?.detailsEn,500),pricingMode:mode,price:mode==='fixed'?money(amount):null,active:item.active===undefined?(base?.active!==false):Boolean(item.active)};
        if(index>=0)prices[index]=next;else prices.push(next);
      }
      const holdDays=b.commissionHoldDays===''||b.commissionHoldDays===null?14:Number(b.commissionHoldDays);
      if(!Number.isInteger(holdDays)||holdDays<0||holdDays>90) return json(res,400,{error:'تحقق من فترة التراجع / Check the refund hold period'},security);
      store.settings={...store.settings,prices,commissionHoldDays:holdDays}; store.leads.forEach(updateCommission); const rankRequestsCreated=syncAllRankRequests(); audit(auth.user,'pricing_updated','settings',`hold=${holdDays}`); await persist();
      for(const request of rankRequestsCreated) await queueRankRequestMail(request);
      return json(res,200,{ok:true,settings:store.settings},security);
    }
    if(req.method==='POST'&&path==='/api/admin/finance/settings'){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const b=await jsonBody(req),start=Number(b.withdrawalWindowStart),end=Number(b.withdrawalWindowEnd),margin=Number(b.marginWarningPercent??10);
      if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end>31||start>end||!Number.isFinite(margin)||margin<0||margin>100)return json(res,400,{error:'حدد نافذة شهرية من يوم 1 إلى 31 وهامش تنبيه صالح / Choose a monthly day window from 1 to 31 and a valid margin warning'},security);
      store.settings={...store.settings,withdrawalMinimum:100,withdrawalWindowStart:start,withdrawalWindowEnd:end,marginWarningPercent:margin};audit(auth.user,'finance_settings_updated','treasury',`${start}-${end}; margin=${margin}%`);await persist();
      return json(res,200,{withdrawalMinimum:100,withdrawalWindowStart:start,withdrawalWindowEnd:end,marginWarningPercent:margin},security);
    }
    if(req.method==='POST'&&path==='/api/admin/finance/expenses'){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const b=await jsonBody(req),amount=Number(b.amount),description=clean(b.description,180),dateValue=clean(b.date,10)||now().slice(0,10),leadId=clean(b.leadId,100),employeeId=clean(b.employeeId,100),service=clean(b.service,80);
      if(!Number.isFinite(amount)||amount<=0||amount>10000000||description.length<3||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateValue)||(leadId&&!store.leads.some(lead=>lead.id===leadId))||(employeeId&&!store.users.some(user=>user.id===employeeId)))return json(res,400,{error:'أدخل مصروفاً صالحاً مع وصف وتاريخ صحيحين / Enter a valid expense, description, and date'},security);
      const expense={id:id('exp'),amount:money(amount),currency:'ILS',description,date:dateValue,leadId:leadId||null,employeeId:employeeId||null,service:service||'',createdBy:auth.user.username,createdAt:now()};store.expenses.unshift(expense);appendFinanceEntry({idempotencyKey:`expense:${expense.id}`,type:'operating_expense',expenseId:expense.id,leadId:expense.leadId,employeeId:expense.employeeId,amountCents:-cents(expense.amount),note:expense.description,actor:auth.user.username,postedAt:expense.date});audit(auth.user,'finance_expense_recorded',expense.id,`${expense.amount} ILS · ${expense.description}`);await persist();return json(res,201,{expense},security);
    }
    if (req.method === 'POST' && path === '/api/admin/template-prices') {
      const auth=requireAuth(req,res,['admin']); if(!auth)return; const b=await jsonBody(req);
      if(!b.templatePrices || typeof b.templatePrices!=='object' || Array.isArray(b.templatePrices)) return json(res,400,{error:'قائمة أسعار القوالب غير صالحة / Invalid template prices'},security);
      const next={...(store.settings.templatePrices||{})};
      for(const [templateId,value] of Object.entries(b.templatePrices)){
        if(!templateById.has(templateId)) return json(res,400,{error:'معرّف قالب غير معروف / Unknown template id'},security);
        if(value===''||value===null) next[templateId]=null;
        else {const amount=Number(value);if(!Number.isFinite(amount)||amount<0||amount>10000000)return json(res,400,{error:'السعر يجب أن يكون رقماً بين 0 و10,000,000 أو فارغاً لطلب عرض سعر / Price must be between 0 and 10,000,000, or blank to request a quote'},security);next[templateId]=money(amount);}
      }
      const active={...(store.settings.templateActive||{})};
      if(b.templateActive!==undefined){if(!b.templateActive||typeof b.templateActive!=='object'||Array.isArray(b.templateActive))return json(res,400,{error:'حالة إتاحة القوالب غير صالحة / Invalid template availability'},security);for(const [templateId,isActive] of Object.entries(b.templateActive)){if(!templateById.has(templateId)||typeof isActive!=='boolean')return json(res,400,{error:'معرّف القالب أو حالته غير صالح / Invalid template id or availability'},security);active[templateId]=isActive;}}
      const inclusions={...(store.settings.templateInclusions||{})};
      if(b.templateInclusions!==undefined){if(!b.templateInclusions||typeof b.templateInclusions!=='object'||Array.isArray(b.templateInclusions))return json(res,400,{error:'نطاقات التخصيص غير صالحة / Invalid template inclusion settings'},security);for(const [templateId,value] of Object.entries(b.templateInclusions)){if(!templateById.has(templateId)||!value||typeof value!=='object'||clean(value.ar,1200).length<10||clean(value.en,1200).length<10)return json(res,400,{error:'يجب تحديد نطاق مشمول واضح بالعربية والإنجليزية لكل قالب / Each template needs a clear Arabic and English included scope'},security);inclusions[templateId]={ar:clean(value.ar,1200),en:clean(value.en,1200)};}}
      store.settings.templatePrices=next;store.settings.templateInclusions=inclusions;store.settings.templateActive=active;audit(auth.user,'template_prices_updated','templates',`${Object.keys(b.templatePrices).length} prices; ${Object.keys(b.templateActive||{}).length} availability flags; ${Object.keys(b.templateInclusions||{}).length} scopes`); await persist();
      return json(res,200,{ok:true,templatePrices:store.settings.templatePrices,templateInclusions:store.settings.templateInclusions,templateActive:store.settings.templateActive},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/admin/rank-requests/')) {
      const auth=requireAuth(req,res,['admin']); if(!auth)return;
      const requestId=path.split('/').at(-1),request=store.rankRequests.find(item=>item.id===requestId);
      if(!request)return json(res,404,{error:'طلب الترقية غير موجود / Rank request not found'},security);
      if(request.status!=='pending')return json(res,409,{error:'تمت معالجة طلب الترقية مسبقاً / Rank request has already been handled'},security);
      const b=await jsonBody(req),decision=clean(b.status,20);
      if(!['approved','rejected'].includes(decision))return json(res,400,{error:'اختر الموافقة أو الرفض / Choose approve or reject'},security);
      const marketer=store.users.find(user=>user.id===request.userId&&referralEnabled(user));
      if(!marketer)return json(res,404,{error:'حساب الموظف غير موجود / Employee account not found'},security);
      const sales=qualifiedSales(marketer.id),threshold=marketerRankThresholds[request.targetRank];
      if(decision==='approved'&&sales<threshold)return json(res,409,{error:'انخفض عدد المبيعات المؤهلة عن الحد؛ حدّث البيانات قبل الموافقة / Qualified sales fell below the required threshold'},security);
      if(decision==='approved'&&marketer.rank!==request.fromRank)return json(res,409,{error:'تغيرت رتبة المسوّق؛ حدّث قائمة الطلبات / Marketer rank changed; refresh the request list'},security);
      request.status=decision;request.updatedAt=now();request.decidedAt=now();request.decidedBy=auth.user.username;request.salesAtDecision=sales;request.note=clean(b.note,300);
      if(decision==='approved'){
        marketer.rank=request.targetRank;marketer.rankUpdatedAt=request.decidedAt;
        if(request.targetRank==='team_leader')marketer.teamLeaderTermsPending=true;
        else {marketer.activeCommissionRate=marketerRankRates[request.targetRank];marketer.teamLeaderTermsPending=false;}
      }
      audit(auth.user,`rank_${decision}`,request.id,`${marketer.username}: ${marketer.rank}; sales=${sales}`);
      const nextRequest=decision==='approved'?syncRankRequest(marketer):null;
      await persist();if(nextRequest)await queueRankRequestMail(nextRequest);
      return json(res,200,{request:{id:request.id,status:request.status,targetRank:request.targetRank},marketerRank:marketer.rank,commissionRate:currentRankRate(marketer)},security);
    }
    if(req.method==='PATCH'&&/^\/api\/admin\/projects\/[^/]+\/stage$/.test(path)){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const projectId=path.split('/').at(-2),lead=store.leads.find(row=>row.id===projectId);if(!lead)return json(res,404,{error:'المشروع غير موجود / Project not found'},security);
      const b=await jsonBody(req);if(!projectStages.includes(b.stage))return json(res,400,{error:'مرحلة مشروع غير صالحة / Invalid project stage'},security);
      if(b.stage==='waiting_developer_acceptance'&&!lead.developerUserId)return json(res,409,{error:'عيّن مبرمجاً قبل انتظار القبول / Assign a developer before awaiting acceptance'},security);
      if(['waiting_client_review','ready_delivery','delivered'].includes(b.stage)&&lead.developerReviewStatus!=='approved')return json(res,409,{error:'اعتمد المراجعة الفنية قبل تسليم الملفات للعميل / Approve technical review before delivery'},security);
      if(b.stage==='completed'&&lead.developerUserId&&lead.developerReviewStatus!=='approved')return json(res,409,{error:'اعتمد تسليم المبرمج قبل إكمال المشروع / Approve the developer delivery before completing the project'},security);
      const previous=lead.projectStage;setProjectStage(lead,b.stage,auth.user,clean(b.note,500),clean(b.clientNote,500));if(b.clientNote!==undefined)lead.publicStatusNote=clean(b.clientNote,500);
      if(b.stage==='completed')lead.status='completed';
      if(b.stage==='cancelled'){lead.status='cancelled';lead.refunded=true;lead.developerTaskStatus='cancelled';cancelWithdrawalForLead(lead,auth.user);}
      updateCommission(lead);updateDeveloperCommission(lead);syncLeadFinanceLedger(lead,auth.user);syncLeadReferralMilestones(lead,auth.user);syncCrmCaseForOrder(lead,auth.user);const rankRequestsCreated=syncAllRankRequests();
      audit(auth.user,'project_stage_updated',lead.id,`${previous||'—'} -> ${b.stage}`);await persist();
      if(lead.clientId)notifyUser(lead.clientId,`project-stage:${lead.id}:${lead.projectHistory.at(-1).at}`,{type:'project',importance:['completed','cancelled','waiting_client_review'].includes(b.stage)?'high':'normal',titleAr:'تحدّثت مرحلة مشروعك',titleEn:'Your project stage changed',descriptionAr:clean(b.clientNote,320)||`المرحلة الجديدة: ${b.stage}`,descriptionEn:clean(b.clientNote,320)||`New stage: ${b.stage}`},{tab:'orders',targetId:lead.id,targetKind:'lead'});
      if(lead.developerUserId)notifyUser(lead.developerUserId,`project-stage:${lead.id}:${lead.projectHistory.at(-1).at}`,{type:'project',importance:'normal',titleAr:'تحدّثت مرحلة المشروع',titleEn:'Project stage changed',descriptionAr:`المرحلة الجديدة: ${b.stage}`,descriptionEn:`New stage: ${b.stage}`},{tab:'development',targetId:lead.id,targetKind:'lead'});
      for(const request of rankRequestsCreated)await queueRankRequestMail(request);
      return json(res,200,{lead:safeLead(lead,true)},security);
    }
    if(req.method==='POST'&&/^\/api\/admin\/projects\/[^/]+\/review$/.test(path)){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const projectId=path.split('/').at(-2),lead=store.leads.find(row=>row.id===projectId&&row.developerUserId);if(!lead)return json(res,404,{error:'المشروع المسند غير موجود / Assigned project not found'},security);
      const b=await jsonBody(req);if(!['approved','revision'].includes(b.decision))return json(res,400,{error:'اختر اعتماد التسليم أو طلب تعديل / Choose approve or request revision'},security);
      if(lead.developerTaskStatus!=='review_requested')return json(res,409,{error:'المبرمج لم يرسل العمل للمراجعة بعد / Developer has not submitted work for review'},security);
      if(b.decision==='approved'&&!(lead.developerAttachments||[]).length)return json(res,409,{error:'ارفع ملف تسليم واحداً على الأقل قبل اعتماد المراجعة / Upload at least one deliverable before approving the review'},security);
      const at=now(),note=clean(b.note,500);lead.developerCommissionReview={decision:b.decision,note,by:auth.user.username,at};lead.developerReviewStatus=b.decision==='approved'?'approved':'revision';
      if(b.decision==='approved'){lead.developerReviewApprovedAt=at;lead.developerCommissionHoldUntil=at;lead.developerTaskStatus='approved';setProjectStage(lead,'waiting_client_review',auth.user,'Technical delivery approved.',clean(b.clientNote,500));}
      else {lead.developerTaskStatus='revision_requested';lead.developerTaskNote=note;setProjectStage(lead,'needs_revisions',auth.user,note,clean(b.clientNote,500));}
      updateDeveloperCommission(lead);syncCrmCaseForOrder(lead,auth.user);audit(auth.user,b.decision==='approved'?'project_delivery_approved':'project_delivery_revision_requested',lead.id,note);
      notifyUser(lead.developerUserId,`quality-review:${lead.id}:${at}`,{type:'project',importance:'high',titleAr:b.decision==='approved'?'اعتمد المالك مراجعة التسليم':'طلب المالك تعديلات على التسليم',titleEn:b.decision==='approved'?'Owner approved the technical delivery':'Owner requested delivery revisions',descriptionAr:note||'راجع تحديثات المشروع في مساحتك.',descriptionEn:note||'Review the project update in your workspace.'},{tab:'development',targetId:lead.id,targetKind:'lead'});await persist();
      if(lead.clientId)notifyUser(lead.clientId,`project-review:${lead.id}:${at}`,{type:'project',importance:'high',titleAr:b.decision==='approved'?'تسليم مشروعك جاهز للمراجعة':'هناك تحديث على مراجعة مشروعك',titleEn:b.decision==='approved'?'Your delivery is ready for review':'Your project review was updated',descriptionAr:b.decision==='approved'?'راجع الملفات المعتمدة وأكد الاستلام أو أرسل ملاحظة تعديل.':clean(b.clientNote,320)||'يراجع فريق ZEZO التعديلات المطلوبة.',descriptionEn:b.decision==='approved'?'Review the approved files and confirm receipt or request a change.':clean(b.clientNote,320)||'The ZEZO team is reviewing the requested changes.'},{tab:'orders',targetId:lead.id,targetKind:'lead'});
      return json(res,200,{project:safeDeveloperProject(lead),projectStage:lead.projectStage},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/admin/leads/')) {
      const auth=requireAuth(req,res,['admin']); if(!auth)return; const leadId=path.split('/').at(-1); const lead=store.leads.find(l=>l.id===leadId);
      if(!lead) return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      const b=await jsonBody(req); const oldStatus=lead.status,oldPublicNote=lead.publicStatusNote||'',oldDuplicate=Boolean(lead.isDuplicate); if(b.status&&!statuses.includes(b.status)) return json(res,400,{error:'حالة غير صالحة / Invalid status'},security);
      if(b.status) lead.status=b.status;
      if(b.status==='proposal'&&!lead.quoteSentAt)lead.quoteSentAt=now();
      if(b.contractAmount!==undefined){const n=b.contractAmount===''||b.contractAmount===null?null:Number(b.contractAmount); if(n!==null&&(!Number.isFinite(n)||n<0||n>10000000))return json(res,400,{error:'قيمة العقد غير صالحة / Invalid contract amount'},security);if(n===null&&lead.paidTotal>0)return json(res,409,{error:'لا يمكن مسح قيمة العقد بعد تسجيل دفعة / Contract amount cannot be cleared after a payment is recorded'},security);if(n!==null&&n<lead.paidTotal)return json(res,409,{error:'قيمة العقد أقل من الدفعات المسجلة / Contract amount is below recorded payments'},security);if(n!==lead.contractAmount&&n!==null){lead.priceSnapshotHistory??=[];lead.priceSnapshotHistory.push({amount:money(n),currency:'ILS',capturedAt:now(),capturedBy:auth.user.username,source:'agreed_quote'});lead.agreedPriceSnapshot={amount:money(n),currency:'ILS',capturedAt:now(),capturedBy:auth.user.username};}lead.contractAmount=n;}
      if(b.isDuplicate!==undefined){if(typeof b.isDuplicate!=='boolean')return json(res,400,{error:'حالة التكرار غير صالحة / Invalid duplicate flag'},security);if(b.isDuplicate&&!oldDuplicate){const original=findDuplicateLead({...lead,excludeLeadId:lead.id});lead.duplicateOfLeadId=original?.id||'manual';cancelWithdrawalForLead(lead,auth.user);}if(!b.isDuplicate)lead.duplicateOfLeadId=null;lead.isDuplicate=b.isDuplicate;}
      if(b.publicStatusNote!==undefined) lead.publicStatusNote=clean(b.publicStatusNote,500);
      if(oldStatus!==lead.status){lead.statusHistory??=[];lead.statusHistory.push({status:lead.status,at:now(),by:auth.user.username,note:lead.publicStatusNote||''});}
      if(b.status==='completed'&&lead.projectStage!=='completed')setProjectStage(lead,'completed',auth.user,'Project marked completed by owner.');
      if(b.status==='cancelled'&&lead.projectStage!=='cancelled')setProjectStage(lead,'cancelled',auth.user,'Project cancelled by owner.');
      if(b.developerUserId!==undefined){
        const nextId=clean(b.developerUserId,80),next=nextId?store.users.find(u=>u.id===nextId&&u.role==='developer'&&u.active):null;
        if(nextId&&!next)return json(res,400,{error:'اختر مبرمجاً نشطاً من الفريق / Select an active developer'},security);
        if(lead.developerUserId!==nextId&&lead.developerUserId&&['accepted','in_progress','review_requested','approved','revision_requested'].includes(lead.developerTaskStatus))return json(res,409,{error:'لا يمكن تغيير المبرمج بعد بدء المهمة / Developer cannot be changed after work starts'},security);
        if(lead.developerUserId!==nextId&&Number(lead.developerCommissionPaidAmount||0)>0)return json(res,409,{error:'لا يمكن تغيير المبرمج بعد صرف مستحقات تنفيذ / Developer cannot be changed after an execution payout'},security);
        lead.developerUserId=nextId||null;lead.developerCommissionRate=developerCommissionRate;lead.developerReviewStatus=null;lead.developerCommissionReview=null;lead.developerCommissionHoldUntil=null;
        lead.developerTaskStatus=next?'offered':'';lead.developerAssignedAt=next?now():null;
        if(next){setProjectStage(lead,'waiting_developer_acceptance',auth.user,'Developer assignment sent.');}else if(['waiting_developer_acceptance','in_progress','technical_review','needs_revisions'].includes(lead.projectStage)){setProjectStage(lead,'under_review',auth.user,'Developer assignment cleared.');}
      }
      if(b.developerDueDate!==undefined){const dateValue=clean(b.developerDueDate,10);if(dateValue&&!/^\d{4}-\d{2}-\d{2}$/.test(dateValue))return json(res,400,{error:'موعد التسليم غير صالح / Invalid due date'},security);lead.developerDueDate=dateValue;}
      if(lead.status==='cancelled') { lead.refunded=true;lead.developerTaskStatus='cancelled'; cancelWithdrawalForLead(lead,auth.user); }
      updateCommission(lead);updateDeveloperCommission(lead);syncLeadFinanceLedger(lead,auth.user);syncLeadReferralMilestones(lead,auth.user);syncCrmCaseForOrder(lead,auth.user); const rankRequestsCreated=syncAllRankRequests(); audit(auth.user,oldDuplicate!==Boolean(lead.isDuplicate)?'lead_duplicate_updated':b.developerUserId!==undefined?'developer_assigned':'lead_updated',lead.id,`${lead.status}; amount=${lead.contractAmount??''}; developer=${lead.developerUserId||''}; duplicate=${Boolean(lead.isDuplicate)}`); await persist();
      if(b.developerUserId!==undefined&&lead.developerUserId){const assigned=store.users.find(u=>u.id===lead.developerUserId);if(assigned?.email)await queueMail({to:assigned.email,kind:'developer_project_assigned',subject:`مهمة مشروع جديدة — ${lead.id}`,text:`لديك مهمة مشروع جديدة في مساحة ZEZO.\nرقم المشروع: ${lead.id}\nالخدمة: ${lead.service} / ${lead.category}\nقيمة الاتفاق: ${lead.contractAmount||0} ₪\nعمولة التنفيذ: 25٪ (المتوقع ${money(Number(lead.contractAmount||0)*0.25)} ₪)\nالموعد المطلوب: ${lead.developerDueDate||'غير محدد'}\nافتح حسابك لمراجعة التفاصيل وقبول المهمة أو الاعتذار.`});}
      for(const request of rankRequestsCreated) await queueRankRequestMail(request);
      if((oldStatus!==lead.status||oldPublicNote!==(lead.publicStatusNote||''))&&lead.email){const statusText=publicStatusLabels[lead.status]?.[lead.language||'ar']||lead.status;await queueMail({to:lead.email,kind:'project_status',subject:lead.language==='en'?'Your ZEZO project update':'تحديث على طلبك لدى ZEZO',text:lead.language==='en'?`Hello ${lead.name},\n\nYour project status is now: ${statusText}.${lead.publicStatusNote?`\n\nUpdate: ${lead.publicStatusNote}`:''}\n\nUse the tracking link from your original confirmation email to follow progress.`:`مرحباً ${lead.name}،\n\nحالة طلبك الآن: ${statusText}.${lead.publicStatusNote?`\n\nالتحديث: ${lead.publicStatusNote}`:''}\n\nاستخدم رابط التتبع الموجود في رسالة التأكيد لمتابعة التقدم.`});}
      return json(res,200,{lead:safeLead(lead,true)},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/admin/leads/')&&path.endsWith('/settlement')){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const leadId=path.split('/').at(-2),lead=store.leads.find(row=>row.id===leadId);if(!lead)return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      if(lead.status!=='completed'||lead.status==='cancelled')return json(res,409,{error:'أكمل حالة تنفيذ المشروع أولاً / Mark the project as completed first'},security);
      const b=await jsonBody(req),amount=b.contractAmount===undefined?Number(lead.contractAmount||0):Number(b.contractAmount),costs=Number(b.projectCosts||0);
      if(!Number.isFinite(amount)||amount<=0||amount>10000000||amount<Number(lead.paidTotal||0)||!Number.isFinite(costs)||costs<0||costs>10000000)return json(res,400,{error:'تحقق من قيمة الاتفاق والمصاريف؛ قيمة الاتفاق لا تقل عن المقبوض / Check the contract price and costs; contract price cannot be below collected payments'},security);
      if(amount!==Number(lead.contractAmount||0)){lead.contractAmount=money(amount);lead.priceSnapshotHistory??=[];lead.priceSnapshotHistory.push({amount:money(amount),currency:'ILS',capturedAt:now(),capturedBy:auth.user.username,source:'settlement_agreement'});lead.agreedPriceSnapshot={amount:money(amount),currency:'ILS',capturedAt:now(),capturedBy:auth.user.username};}
      const previousCosts=Number(lead.projectCostTotal||0),costDelta=money(costs-previousCosts);lead.projectCostTotal=money(costs);
      if(Math.abs(costDelta)>=0.01){const costRecord={id:id('exp'),amount:costDelta,currency:'ILS',description:'Project cost total adjustment',date:now().slice(0,10),leadId:lead.id,employeeId:null,service:lead.service,createdBy:auth.user.username,createdAt:now(),adjustment:true};store.expenses.unshift(costRecord);appendFinanceEntry({idempotencyKey:`expense:${costRecord.id}`,type:'project_cost_adjustment',expenseId:costRecord.id,leadId:lead.id,employeeId:null,amountCents:-cents(costDelta),note:'Project cost total adjustment',actor:auth.user.username,postedAt:costRecord.date});}
      const collected=money(Number(lead.paidTotal||0)),balanceDue=money(Math.max(0,Number(lead.contractAmount)-collected));
      const marketer=store.users.find(user=>user.id===lead.referralUserId),rate=lead.commissionRate==null?(marketer?currentRankRate(marketer):0):Number(lead.commissionRate),referralEstimate=marketer&&!lead.isDuplicate&&lead.status!=='cancelled'?money(collected*rate/100):0;
      const developer=store.users.find(user=>user.id===lead.developerUserId),developerEstimate=developer&&!lead.isDuplicate?money(collected*developerCommissionRate/100):0;
      const companyShare=money(collected-referralEstimate-developerEstimate),profit=money(companyShare-costs),marginPercent=collected>0?money(profit/collected*100):0,lowMargin=collected>0&&marginPercent<Number(store.settings.marginWarningPercent??10);
      const snapshot={id:id('settle'),version:(lead.financeSettlements||[]).length+1,createdAt:now(),createdBy:auth.user.username,leadId:lead.id,service:lead.service,contractAmount:money(lead.contractAmount),collected,balanceDue,projectCosts:money(costs),marketer:marketer?{userId:marketer.id,name:marketer.name,rank:marketer.rank,rate}:null,referralCommissionEstimate:referralEstimate,developer:developer?{userId:developer.id,name:developer.name,rate:developerCommissionRate}:null,developerCommissionEstimate:developerEstimate,companyShare,estimatedProfit:profit,marginPercent,lowMargin,warningPercent:Number(store.settings.marginWarningPercent??10),paymentStatus:collected<=0?'unpaid':balanceDue>0?'partial':'collected',note:clean(b.note,500)};
      lead.financeSettlements??=[];lead.financeSettlements.push(snapshot);lead.financeSettlement=snapshot;syncLeadFinanceLedger(lead,auth.user);appendFinanceEntry({idempotencyKey:`settlement:${lead.id}:v${snapshot.version}`,type:'project_settlement_snapshot',leadId:lead.id,amountCents:0,statusSnapshot:snapshot.paymentStatus,actor:auth.user.username,note:`version ${snapshot.version}; projected profit ${profit} ILS`});
      audit(auth.user,'project_financial_settlement_saved',lead.id,`v${snapshot.version}; collected=${collected}; balance=${balanceDue}; profit=${profit}`);await persist();return json(res,201,{settlement:snapshot,lead:safeLead(lead,true)},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/admin/leads/')&&path.endsWith('/settlement/review')){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const leadId=path.split('/').at(-3),lead=store.leads.find(row=>row.id===leadId);if(!lead)return json(res,404,{error:'الطلب غير موجود / Request not found'},security);
      if(!lead.financeSettlement)return json(res,409,{error:'لا توجد تسوية محفوظة للمشروع / No saved project settlement'},security);
      if(lead.financeSettlementReview?.settlementId===lead.financeSettlement.id)return json(res,200,{ok:true,alreadyReviewed:true},security);
      lead.financeSettlementReview={settlementId:lead.financeSettlement.id,at:now(),by:auth.user.username};audit(auth.user,'project_financial_settlement_reviewed',lead.id,`settlement=${lead.financeSettlement.id}`);await persist();return json(res,200,{ok:true,review:lead.financeSettlementReview},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/developer/projects/')&&path.endsWith('/decision')){
      const auth=requireAuth(req,res,['developer']);if(!auth)return;const leadId=path.split('/').at(-2),lead=store.leads.find(l=>l.id===leadId&&l.developerUserId===auth.user.id);
      if(!lead||lead.developerTaskStatus!=='offered')return json(res,404,{error:'المهمة غير متاحة لاتخاذ القرار / Task is not available for a decision'},security);
      const b=await jsonBody(req);if(!['accept','decline'].includes(b.decision))return json(res,400,{error:'اختر قبول المهمة أو الاعتذار / Choose accept or decline'},security);
      lead.developerTaskStatus=b.decision==='accept'?'accepted':'declined';lead.developerRespondedAt=now();lead.developerTaskNote=clean(b.note,500);if(b.decision==='accept'){lead.developerAcceptedAt=lead.developerRespondedAt;setProjectStage(lead,'in_progress',auth.user,'Developer accepted the assignment.');}else{lead.developerUserId=null;setProjectStage(lead,'under_review',auth.user,clean(b.note,500)||'Developer declined the assignment.');}
      audit(auth.user,b.decision==='accept'?'developer_task_accepted':'developer_task_declined',lead.id);await persist();return json(res,200,{project:safeDeveloperProject({...lead,developerUserId:b.decision==='decline'?auth.user.id:lead.developerUserId})},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/developer/projects/')){
      const auth=requireAuth(req,res,['developer']);if(!auth)return;const lead=store.leads.find(l=>l.id===path.split('/').at(-1)&&l.developerUserId===auth.user.id);
      if(!lead||!['accepted','in_progress','revision_requested'].includes(lead.developerTaskStatus))return json(res,404,{error:'المشروع غير متاح للتحديث / Project is not available for updates'},security);
      const b=await jsonBody(req);if(b.status!==undefined&&!['in_progress','review_requested'].includes(b.status))return json(res,400,{error:'حالة التنفيذ غير صالحة / Invalid development status'},security);
      if(b.status==='review_requested'&&lead.status==='cancelled')return json(res,409,{error:'المشروع ملغى / Project is cancelled'},security);
      if(b.status){lead.developerTaskStatus=b.status;setProjectStage(lead,b.status==='review_requested'?'technical_review':'in_progress',auth.user,b.status==='review_requested'?'Developer submitted work for technical review.':'Developer updated project progress.');}if(b.note!==undefined)lead.developerTaskNote=clean(b.note,500);lead.developerUpdatedAt=now();audit(auth.user,'developer_project_updated',lead.id,lead.developerTaskStatus);await persist();return json(res,200,{project:safeDeveloperProject(lead)},security);
    }
    if(req.method==='POST'&&path.startsWith('/api/developer/projects/')&&path.endsWith('/files')){
      const auth=requireAuth(req,res,['developer']);if(!auth)return;const leadId=path.split('/').at(-2),lead=store.leads.find(l=>l.id===leadId&&l.developerUserId===auth.user.id);
      if(!lead||!['accepted','in_progress','revision_requested','review_requested'].includes(lead.developerTaskStatus))return json(res,404,{error:'المشروع غير متاح لرفع الملفات / Project is not available for uploads'},security);
      if(!(req.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data'))return json(res,400,{error:'أرسل الملف بصيغة multipart / Submit the file as multipart form data'},security);
      const parsed=parseMultipart(await bodyBuffer(req),req.headers['content-type']),attachment=await saveUpload(parsed.file);if(!attachment)return json(res,400,{error:'اختر ملفاً قبل الرفع / Choose a file to upload'},security);
      lead.developerAttachments??=[];lead.developerAttachments.push({...attachment,uploadedBy:auth.user.username,uploadedAt:now()});audit(auth.user,'developer_file_uploaded',lead.id,attachment.originalName);await persist();return json(res,201,{files:lead.developerAttachments.map(a=>({name:a.originalName,size:a.size}))},security);
    }
    if(req.method==='PATCH'&&path.startsWith('/api/admin/developer-projects/')&&path.endsWith('/review')){
      const auth=requireAuth(req,res,['admin']);if(!auth)return;const lead=store.leads.find(l=>l.id===path.split('/').at(-2));if(!lead||!lead.developerUserId)return json(res,404,{error:'مهمة المبرمج غير موجودة / Developer task not found'},security);
      const b=await jsonBody(req);if(!['approved','revision'].includes(b.decision))return json(res,400,{error:'اختر اعتماد التسليم أو طلب تعديل / Choose approve or request revision'},security);
      if(lead.developerTaskStatus!=='review_requested')return json(res,409,{error:'المبرمج لم يطلب مراجعة التسليم بعد / Developer has not requested a review'},security);
      if(b.decision==='approved'&&(lead.status!=='completed'||Number(lead.paidTotal||0)<=0||lead.isDuplicate||lead.status==='cancelled'))return json(res,409,{error:'اعتماد المستحقات يتطلب اكتمال المشروع ومراجعة التسليم والتحقق من دفعة محصّلة / Project must be completed, reviewed, and have verified collected funds'},security);
      lead.developerCommissionReview={decision:b.decision,note:clean(b.note,500),by:auth.user.username,at:now()};
      if(b.decision==='approved'){lead.developerReviewStatus='approved';lead.developerReviewApprovedAt=now();lead.developerCommissionHoldUntil=now();lead.developerTaskStatus='approved';setProjectStage(lead,lead.status==='completed'?'completed':'waiting_client_review',auth.user,'Legacy owner review approved.');}
      else {lead.developerReviewStatus='revision';lead.developerTaskStatus='revision_requested';lead.developerTaskNote=clean(b.note,500);setProjectStage(lead,'needs_revisions',auth.user,clean(b.note,500)||'Owner requested delivery revisions.');}
      updateDeveloperCommission(lead);audit(auth.user,b.decision==='approved'?'developer_commission_approved':'developer_revision_requested',lead.id,`${lead.paidTotal||0} ILS · 25%`);await persist();return json(res,200,{project:safeDeveloperProject(lead)},security);
    }
    if(req.method==='GET'&&path.startsWith('/api/developer/attachment/')){
      const auth=requireAuth(req,res,['admin','developer']);if(!auth)return;const [leadId,indexText]=path.split('/').slice(-2),lead=store.leads.find(l=>l.id===leadId);
      if(!lead||(auth.user.role==='developer'&&lead.developerUserId!==auth.user.id))return json(res,404,{error:'الملف غير موجود / File not found'},security);const file=lead.developerAttachments?.[Number(indexText)];if(!file)return json(res,404,{error:'الملف غير موجود / File not found'},security);
      res.writeHead(200,{...security,'Content-Type':file.type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,'Cache-Control':'private, no-store'});return createReadStream(join(UPLOAD_DIR,file.storedName)).pipe(res);
    }
    if (req.method === 'POST' && path === '/api/admin/payment') {
      const auth=requireAuth(req,res,['admin']); if(!auth)return; const b=await jsonBody(req); const lead=store.leads.find(l=>l.id===b.leadId);
      const amount=Number(b.amount); if(!lead||!Number.isFinite(amount)||amount<=0||amount>10000000||!['payment','refund'].includes(b.kind)||b.verified!==true) return json(res,400,{error:'سجّل مبلغاً صحيحاً وأكد التحقق اليدوي / Enter a valid amount and confirm manual verification'},security);
      const idempotencyKey=clean(b.idempotencyKey,80);
      if(idempotencyKey){if(!/^[a-zA-Z0-9_-]{12,80}$/.test(idempotencyKey))return json(res,400,{error:'مفتاح الحركة غير صالح / Invalid transaction key'},security);const existing=store.payments.find(row=>row.idempotencyKey===idempotencyKey);if(existing)return json(res,200,{payment:existing,lead:safeLead(lead,true),duplicate:true},security);}
      if(b.kind==='payment'&&(!lead.contractAmount||!['active','waiting_payment','completed'].includes(lead.status))) return json(res,409,{error:'حدّد قيمة العقد وفعّل المشروع قبل تسجيل دفعة / Set the contract amount and activate the project before recording a payment'},security);
      const payment={id:id('pay'),idempotencyKey:idempotencyKey||null,leadId:lead.id,at:now(),kind:b.kind,amount:money(amount),note:clean(b.note,300),verifiedBy:auth.user.username};
      if(b.kind==='refund'){
        if(amount>lead.paidTotal)return json(res,400,{error:'المبلغ المسترد أكبر من المدفوع المسجل / Refund exceeds recorded payments'},security);
        cancelWithdrawalForLead(lead,auth.user);lead.paidTotal=money(lead.paidTotal-amount);lead.refunded=true;lead.refundAt=now();lead.commissionHoldUntil=lead.refundAt;
      } else {
        if(lead.paidTotal+amount>lead.contractAmount)return json(res,400,{error:'الدفعة تتجاوز رصيد العقد / Payment exceeds the remaining contract balance'},security);
        const wasFullyPaid=lead.paidTotal>=lead.contractAmount;lead.paidTotal=money(lead.paidTotal+amount);
        if(!wasFullyPaid&&lead.paidTotal>=lead.contractAmount){lead.fullyPaidAt=now();lead.everFullyPaid=true;lead.commissionHoldUntil=lead.fullyPaidAt;}
        if(lead.paidTotal>=lead.contractAmount)lead.refunded=false;
      }
      store.payments.unshift(payment); if(lead.referralUserId)recordReferralEvent({userId:lead.referralUserId,code:lead.referralCode,linkId:lead.referralLinkId,type:b.kind==='refund'?'refund':'payment_received',leadId:lead.id,idempotencyKey:`${b.kind==='refund'?'refund':'payment_received'}:${payment.id}`});updateCommission(lead); updateDeveloperCommission(lead);syncLeadFinanceLedger(lead,auth.user);syncLeadReferralMilestones(lead,auth.user);syncCrmCaseForOrder(lead,auth.user); const rankRequestsCreated=syncAllRankRequests(); audit(auth.user,b.kind==='refund'?'refund_recorded':'manual_payment_verified',lead.id,`${amount} ILS`); await persist();
      for(const request of rankRequestsCreated) await queueRankRequestMail(request);
      return json(res,201,{payment,lead:safeLead(lead,true)},security);
    }
    if (req.method === 'POST' && path === '/api/admin/commission/paid') {
      const auth=requireAuth(req,res,['admin']); if(!auth)return;
      return json(res,409,{error:'سجّل التحويل الشهري من صفحة طلبات السحب بعد التحويل اليدوي / Record monthly transfers from the withdrawal queue after the manual payout'},security);
    }
    if (req.method === 'POST' && path === '/api/marketer/withdrawals') {
      const auth=requireAuth(req,res,['marketer','developer']); if(!auth)return;
      for(const lead of store.leads){updateCommission(lead);updateDeveloperCommission(lead);}
      const referralAvailable=availableCommissionLeads(auth.user.id),developerAvailable=availableDeveloperCommissionLeads(auth.user.id);
      const referralGross=money(referralAvailable.reduce((sum,lead)=>sum+outstandingCommission(lead),0)),developerGross=money(developerAvailable.reduce((sum,lead)=>sum+outstandingDeveloperCommission(lead),0));
      const grossAvailable=money(referralGross+developerGross),totalDebt=money(outstandingCommissionDebt(auth.user.id)+developerCommissionDebt(auth.user.id)),netAvailable=money(Math.max(0,grossAvailable-totalDebt));
      const b=await jsonBody(req),amount=money(Number(b.amount)),minimum=Number(store.settings.withdrawalMinimum||100);
      if(!Number.isFinite(amount)||amount<minimum)return json(res,400,{error:`الحد الأدنى لطلب السحب ${minimum} شيكل / Minimum withdrawal is ${minimum} ILS`},security);
      if(amount>netAvailable)return json(res,409,{error:'المبلغ المطلوب أكبر من رصيدك المتاح / Requested amount exceeds your available balance'},security);
      if(!auth.user.email||!/^\S+@\S+\.\S+$/.test(auth.user.email)) return json(res,400,{error:'أضف بريداً صالحاً من إعدادات حسابك أولاً / Add a valid email in your account settings first'},security);
      const destination=clean(auth.user.payoutHandle,120);
      if(destination.length<3) return json(res,400,{error:'أضف معرّف Binance Pay أو UID في إعدادات حسابك / Add your Binance Pay ID or UID in account settings'},security);
      const dateNow=new Date(),month=referralMonth(dateNow),day=dateNow.getUTCDate(),windowStart=Number(store.settings.withdrawalWindowStart||1),windowEnd=Number(store.settings.withdrawalWindowEnd||31);
      if(day<windowStart||day>windowEnd)return json(res,409,{error:`طلبات السحب متاحة من يوم ${windowStart} إلى ${windowEnd} من الشهر / Withdrawal requests are open from day ${windowStart} to ${windowEnd}`},security);
      if(store.withdrawals.some(item=>item.userId===auth.user.id&&item.month===month)) return json(res,409,{error:'تم استخدام طلب السحب الشهري لهذا الشهر / Your monthly withdrawal request has already been used'},security);
      const offsetAmount=money(Math.min(totalDebt,amount)),grossAmount=money(amount+offsetAmount);let remainingGross=grossAmount;
      const commissionItems=[];let referralAmount=0,developerAmount=0;
      for(const [kind,leads] of [['referral',referralAvailable],['developer',developerAvailable]])for(const lead of leads){if(remainingGross<=0.001)break;const available=kind==='referral'?outstandingCommission(lead):outstandingDeveloperCommission(lead),selected=money(Math.min(available,remainingGross));if(selected<=0)continue;commissionItems.push({leadId:lead.id,kind,amount:selected});if(kind==='referral')referralAmount=money(referralAmount+selected);else developerAmount=money(developerAmount+selected);remainingGross=money(remainingGross-selected);}
      if(remainingGross>0.01)return json(res,409,{error:'تغير الرصيد أثناء إعداد الطلب؛ حدّث الصفحة وأعد المحاولة / Balance changed; refresh and retry'},security);
      const withdrawal={id:id('wd'),userId:auth.user.id,name:auth.user.name,email:auth.user.email,role:auth.user.role,month,createdAt:now(),updatedAt:now(),amount,grossAmount,offsetAmount,balanceAtRequest:netAvailable,referralAmount,developerAmount,method:clean(b.method,20)||'binance',destination,status:'pending',commissionItems,commissionIds:commissionItems.map(item=>item.leadId),transferReference:'',transferDetails:null,note:'',statusHistory:[{status:'pending',at:now(),by:auth.user.username}]};
      for(const item of commissionItems){const lead=store.leads.find(row=>row.id===item.leadId);if(item.kind==='developer')lead.developerWithdrawalId=withdrawal.id;else lead.withdrawalId=withdrawal.id;}
      store.withdrawals.unshift(withdrawal);appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:requested`,type:'withdrawal_reserved',employeeId:auth.user.id,withdrawalId:withdrawal.id,amountCents:cents(amount),actor:auth.user.username});if(offsetAmount>0)appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:offset`,type:'commission_offset_reserved',employeeId:auth.user.id,withdrawalId:withdrawal.id,amountCents:cents(offsetAmount),actor:auth.user.username});audit(auth.user,'withdrawal_requested',withdrawal.id,`${amount} ILS; ${withdrawal.method}`); await persist();
      await queueMail({recipientType:'admin',kind:'withdrawal_requested',subject:`طلب سحب عمولة — ${withdrawal.name}`,text:`طلب سحب شهري جديد\nالموظف: ${withdrawal.name}\nالدور: ${withdrawal.role}\nالبريد: ${withdrawal.email}\nعمولات التسويق المحجوزة: ${referralAmount} ₪\nمستحقات التنفيذ المحجوزة: ${developerAmount} ₪\nمبلغ التحويل المطلوب: ${amount} ₪\nتسوية استردادات: ${offsetAmount} ₪\nوسيلة التحويل: ${withdrawal.method}\nBinance Pay ID / UID: ${destination}\nالشهر: ${month}\nيحتاج مراجعة ثم اعتماد المالك قبل التحويل اليدوي.`});
      await queueMail({to:withdrawal.email,kind:'withdrawal_received',subject:'تم استلام طلب السحب لدى ZEZO',text:`مرحباً ${withdrawal.name}، وصل طلب السحب الشهري بقيمة ${amount} ₪. سيتم مراجعته وتحويله يدوياً بعد الموافقة.`});
      return json(res,201,{withdrawal:withdrawalForMarketer(withdrawal)},security);
    }
    if (req.method === 'PATCH' && path.startsWith('/api/admin/withdrawals/')) {
      const auth=requireAuth(req,res,['admin']); if(!auth)return;
      const withdrawalId=path.split('/').at(-1); const withdrawal=store.withdrawals.find(item=>item.id===withdrawalId);
      if(!withdrawal) return json(res,404,{error:'طلب السحب غير موجود / Withdrawal request not found'},security);
      const b=await jsonBody(req); let next=clean(b.status,30);const priorStatus=withdrawal.status;
      if(priorStatus==='pending'||priorStatus==='under_review'){
        if(!['approved','rejected'].includes(next))return json(res,400,{error:'اختر الموافقة أو الرفض / Choose approve or reject'},security);
        if(next==='approved')next='awaiting_transfer';
      }else if(priorStatus==='awaiting_transfer'){
        if(next!=='paid')return json(res,409,{error:'الطلب بانتظار تسجيل التحويل أو أصبح غير قابل للتعديل / The request awaits transfer recording'},security);
      }else return json(res,409,{error:'تمت معالجة طلب السحب مسبقاً / Withdrawal request has already been handled'},security);
      const employee=store.users.find(user=>user.id===withdrawal.userId);
      let transferInput=null;
      let offsetAllocations=[];
      if(next==='paid'){
        const sentAmount=Number(b.sentAmount),exchangeRate=Number(b.exchangeRate),feeAmount=Number(b.feeAmount||0),sentCurrency=clean(b.sentCurrency,3).toUpperCase(),method=clean(b.method,20)||withdrawal.method,feeBearer=clean(b.feeBearer,20),transferReference=clean(b.transferReference,120),transferredAt=clean(b.transferredAt,30)||now(),proofReference=clean(b.proofReference,300);
        if(b.verified!==true||!Number.isFinite(sentAmount)||sentAmount<=0||!/^[A-Z]{3}$/.test(sentCurrency)||!Number.isFinite(exchangeRate)||exchangeRate<=0||!Number.isFinite(feeAmount)||feeAmount<0||!['employee','company','shared'].includes(feeBearer)||transferReference.length<3||!Number.isFinite(new Date(transferredAt).getTime()))return json(res,400,{error:'أكمل تفاصيل التحويل الفعلي وأكد التحقق منه قبل تسجيل الدفع / Enter complete transfer details and verify the actual transfer before recording payment'},security);
        transferInput={sentAmount,exchangeRate,feeAmount,sentCurrency,method,feeBearer,transferReference,transferredAt,proofReference};
        let remainingOffset=Number(withdrawal.offsetAmount||0);
        const debts=store.leads.flatMap(item=>[
          ...(item.referralUserId===withdrawal.userId&&Number(item.commissionDebtRemaining||0)>0?[{lead:item,kind:'referral',amount:Number(item.commissionDebtRemaining||0)}]:[]),
          ...(item.developerUserId===withdrawal.userId&&Number(item.developerCommissionDebtRemaining||0)>0?[{lead:item,kind:'developer',amount:Number(item.developerCommissionDebtRemaining||0)}]:[])
        ]).sort((a,b)=>String(a.lead.createdAt).localeCompare(String(b.lead.createdAt)));
        for(const debt of debts){if(remainingOffset<=0)break;const applied=Math.min(debt.amount,remainingOffset);offsetAllocations.push({...debt,applied});remainingOffset=money(remainingOffset-applied);}
        if(remainingOffset>0.01)return json(res,409,{error:'تغير رصيد تسوية الاسترداد؛ حدّث اللوحة وأعد المراجعة / Refund offset changed; refresh and review the balance again'},security);
      }
      withdrawal.status=next;withdrawal.updatedAt=now();withdrawal.note=clean(b.note,300);withdrawal.statusHistory??=[];
      if(priorStatus==='pending'||priorStatus==='under_review')withdrawal.statusHistory.push({status:'approved',at:withdrawal.updatedAt,by:auth.user.username},{status:'awaiting_transfer',at:withdrawal.updatedAt,by:auth.user.username});
      if(next==='rejected'){
        withdrawal.statusHistory.push({status:'rejected',from:priorStatus,at:withdrawal.updatedAt,by:auth.user.username});
        for(const item of withdrawal.commissionItems||[]){const lead=store.leads.find(row=>row.id===item.leadId);if(!lead)continue;if(item.kind==='developer'&&lead.developerWithdrawalId===withdrawal.id)delete lead.developerWithdrawalId;if(item.kind!=='developer'&&lead.withdrawalId===withdrawal.id)delete lead.withdrawalId;}
        appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:released`,type:'withdrawal_released',employeeId:withdrawal.userId,withdrawalId:withdrawal.id,amountCents:cents(withdrawal.amount),statusSnapshot:'rejected',actor:auth.user.username,note:withdrawal.note});
      }
      if(next==='paid'){
        const {sentAmount,exchangeRate,feeAmount,sentCurrency,method,feeBearer,transferReference,transferredAt,proofReference}=transferInput;
        withdrawal.transferReference=transferReference;withdrawal.paidAt=new Date(transferredAt).toISOString();withdrawal.method=method;withdrawal.transferDetails={ilsDue:withdrawal.amount,sentAmount:money(sentAmount),sentCurrency,exchangeRate:money(exchangeRate),feeAmount:money(feeAmount),feeBearer,reference:transferReference,transferredAt:withdrawal.paidAt,proofReference,verifiedBy:auth.user.username,verifiedAt:now()};withdrawal.statusHistory.push({status:'paid',from:priorStatus,at:withdrawal.paidAt,by:auth.user.username});
        for(const debt of offsetAllocations){if(debt.kind==='developer'){debt.lead.developerCommissionOffsetAmount=money(Number(debt.lead.developerCommissionOffsetAmount||0)+debt.applied);updateDeveloperCommission(debt.lead);}else{debt.lead.commissionOffsetAmount=money(Number(debt.lead.commissionOffsetAmount||0)+debt.applied);updateCommission(debt.lead);}}
        for(const item of withdrawal.commissionItems||[]){const lead=store.leads.find(row=>row.id===item.leadId);if(!lead)continue;
          if(item.kind==='developer'&&lead.developerWithdrawalId===withdrawal.id&&lead.developerCommissionStatus==='confirmed'){lead.developerCommissionPaidAmount=money(Number(lead.developerCommissionPaidAmount||0)+Number(item.amount||0));lead.developerCommissionPaidAt=withdrawal.paidAt;updateDeveloperCommission(lead);syncLeadFinanceLedger(lead,auth.user);}
          if(item.kind!=='developer'&&lead.withdrawalId===withdrawal.id&&lead.commissionStatus==='confirmed'){lead.commissionPaidAmount=money(Number(lead.commissionPaidAmount||0)+Number(item.amount||outstandingCommission(lead)));lead.commissionPaidAt=withdrawal.paidAt;updateCommission(lead);syncLeadFinanceLedger(lead,auth.user);}
        }
        appendFinanceEntry({idempotencyKey:`withdrawal:${withdrawal.id}:paid`,type:'withdrawal_paid',employeeId:withdrawal.userId,withdrawalId:withdrawal.id,amountCents:cents(withdrawal.amount),statusSnapshot:'paid',actor:auth.user.username,transferReference,postedAt:withdrawal.paidAt,note:`${sentAmount} ${sentCurrency}; rate ${exchangeRate}; fee ${feeAmount} ${feeBearer}`});
      }
      audit(auth.user,`withdrawal_${next}`,withdrawal.id,`${withdrawal.amount} ILS`);await persist();
      if(employee?.email) await queueMail({to:employee.email,kind:`withdrawal_${next}`,subject:next==='awaiting_transfer'?'تمت الموافقة على طلب السحب':'تحديث طلب السحب من ZEZO',text:`مرحباً ${employee.name}، حالة طلب السحب بقيمة ${withdrawal.amount} ₪: ${next==='awaiting_transfer'?'تمت الموافقة، وسيجري التحويل يدوياً.':next==='rejected'?`تم رفض الطلب.${withdrawal.note?` السبب: ${withdrawal.note}`:''}`:`تم تسجيل التحويل يدوياً بعد التحقق. مرجع التحويل: ${withdrawal.transferReference}`}`});
      return json(res,200,{withdrawal:{id:withdrawal.id,status:withdrawal.status,amount:withdrawal.amount,updatedAt:withdrawal.updatedAt}},security);
    }
    if (req.method === 'GET' && path.startsWith('/api/admin/attachment/')) {
      const auth=requireAuth(req,res,['admin','marketing_manager','hr_manager','developer']); if(!auth)return; const [leadId,indexText]=path.split('/').slice(-2); const lead=store.leads.find(l=>l.id===leadId); if(auth.user.role==='developer'&&(!lead||lead.developerUserId!==auth.user.id||!['accepted','in_progress','review_requested','approved','revision_requested'].includes(lead.developerTaskStatus)))return json(res,404,{error:'الملف غير موجود / File not found'},security); const a=lead?.attachments[Number(indexText)];
      if(!a) return json(res,404,{error:'الملف غير موجود'},security);
      res.writeHead(200,{...security,'Content-Type':a.type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(a.originalName)}`,'Cache-Control':'private, no-store'}); return createReadStream(join(UPLOAD_DIR,a.storedName)).pipe(res);
    }
    return json(res,404,{error:'Not found'},security);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405,security); return res.end('Method not allowed'); }
  let target=path==='/'?'/index.html':path;
  if(!/^\/(index\.html|styles\.css|templates\.css|live-demos\.css|demo-(web|apps|ai|ideas)\.(js|css)|app\.js|live-demos\.js|template-catalog\.js|whatsapp\.js|favicon\.svg|assets\/(zezo-nebula|zezo-planet-texture)\.jpg|assets\/lamsa-(abaya|dress|set|scarf)\.png|assets\/templates\/[a-z0-9-]+\.jpg)$/.test(target)) target='/index.html';
  let headers={...security,'Cache-Control':'no-cache'};
  if(target==='/index.html'){
    const cookies=[];
    if(cookieValue(req,'zezo_visitor'))cookies.push(`zezo_visitor=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${requestIsSecure(req)?'; Secure':''}`);
    const incomingRef=clean(url.searchParams.get('ref'),40),existingRef=referralLinkForCode(clean(cookieValue(req,'zezo_ref'),40));
    if(!existingRef&&incomingRef&&referralLinkForCode(incomingRef))cookies.push(cookie('zezo_ref',incomingRef,REFERRAL_TTL_SECONDS,req));
    if(cookies.length)headers['Set-Cookie']=cookies;
  }
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png'};
  const file=join(PUBLIC_DIR,target.slice(1));
  try {
    const data=await readFile(file);
    const body=target==='/index.html'&&STAGING_MODE
      ? data.toString('utf8')
        .replace('<html lang="ar" dir="rtl">','<html lang="ar" dir="rtl" data-zezo-staging="true">')
        .replace('<body>','<body><div class="zezo-staging-banner" role="status"><b>ZEZO / STAGING</b><span data-ar="بيئة اختبار مستقلة — كل البيانات والأسعار تجريبية. البريد وواتساب والدفع والتحويلات الحقيقية متوقفة." data-en="Isolated test environment — all data and prices are simulated. Email, WhatsApp, real payments and transfers are disabled.">بيئة اختبار مستقلة — كل البيانات والأسعار تجريبية. البريد وواتساب والدفع والتحويلات الحقيقية متوقفة.</span></div>')
        .replace('</head>','<style>.zezo-staging-banner{display:flex;align-items:center;justify-content:center;gap:12px;min-height:38px;padding:7px 18px;background:#101a28;border-bottom:1px solid rgba(0,102,255,.55);color:#dce8f8;font:12px/1.45 "Segoe UI",Arial,sans-serif;text-align:center}.zezo-staging-banner b{color:#a3ff12;font-size:10px;letter-spacing:.12em;white-space:nowrap}@media(max-width:600px){.zezo-staging-banner{font-size:10px;gap:7px;padding:7px 10px}.zezo-staging-banner b{font-size:9px}}</style></head>')
      : data;
    res.writeHead(200,{...headers,'Content-Type':types[extname(file)]||'application/octet-stream'}); return req.method==='HEAD'?res.end():res.end(body);
  }
  catch { res.writeHead(404,headers); res.end('Not found'); }
}

export { init, handle };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const setupAvailable = await init();
  void processMailQueue();
  const mailRetryTimer=setInterval(()=>void processMailQueue(),60_000);
  mailRetryTimer.unref();
  const referralRolloverTimer=setInterval(()=>{const eventCount=store.referralEvents.length,attributionCount=store.referralAttributions.length,linksChanged=ensureMonthlyReferralLinks();cleanReferralEvents();cleanReferralAttributions();if(linksChanged||eventCount!==store.referralEvents.length||attributionCount!==store.referralAttributions.length)void persist().catch(error=>console.error('Referral maintenance failed:',error));},6*60*60_000);
  referralRolloverTimer.unref();
  if (setupAvailable) console.log('\nLocal ZEZO setup is available: open Team access to create the first administrator. A temporary password is required to be changed immediately.\n');
  createServer((req,res)=>{
    handle(req,res).catch(async error=>{
      if(!res.headersSent){const status=error.status||500; json(res,status,{error:status===500?'حدث خطأ داخلي / Internal server error':error.message},{'X-Content-Type-Options':'nosniff'});}
      if(error.status===undefined) console.error('Request error:',error);
    });
  }).listen(PORT,'127.0.0.1',()=>console.log(`ZEZO local preview: http://localhost:${PORT}`));
}
