export type Language = 'ar' | 'en';
export type Search = Record<string, string | string[] | undefined>;
export type Customer = { id: string; name: string; email: string; role: string; phone?: string };
export type Attachment = { index?: number; name: string; size: number; kind?: 'customer_upload' | 'deliverable' };
export type Timeline = { stage?: string; status?: string; at: string; note?: string };
export type Order = {
  id: string; createdAt: string; service: string; category: string; details: string; budget?: string;
  status: string; projectStage: string; name: string; publicStatusNote?: string; templateName?: string;
  dueDate?: string; history?: Timeline[]; projectHistory?: Timeline[]; files?: Attachment[];
  contractAmount: number | null; paidTotal: number; balanceDue: number; paymentStatus: string;
  quoteAcceptedAt?: string; canAcceptQuote?: boolean; canConfirmDelivery?: boolean;
};
export type Message = { id: string; senderType: string; senderName?: string; text: string; createdAt: string; attachments?: Attachment[] };
export type Conversation = {
  id: string; leadId?: string | null; templateId?: string; templateName?: string; templateService?: string;
  status: string; createdAt: string; updatedAt: string; conversionRequested?: boolean; messages?: Message[];
  quote?: { amount: number; status: string; scope?: string; included?: string; exclusions?: string } | null;
};
export type Notice = {
  id: string; type: string; titleAr?: string; titleEn?: string; descriptionAr?: string; descriptionEn?: string;
  createdAt: string; readAt?: string; target?: { kind?: string; id?: string; tab?: string };
};
export type Profile = { name: string; email: string; phone: string; student: boolean; university: string; emailVerified: boolean };
export type Dashboard = { role: 'client'; user: Customer; profile: Profile; orders: Order[]; conversations: Conversation[] };
export type TemplateOption = { id: string; service: string; category: string; title: Record<Language, string> };

export const services = [
  { id: 'web', ar: 'المواقع والمتاجر', en: 'Websites and stores', categories: [
    ['site', 'موقع إلكتروني', 'Website'], ['store', 'متجر إلكتروني', 'Online store'],
    ['care', 'رعاية تقنية', 'Web care'], ['audit', 'مراجعة موقع', 'Website audit'], ['maintenance', 'صيانة', 'Maintenance'],
  ] },
  { id: 'apps', ar: 'تطوير التطبيقات', en: 'App development', categories: [
    ['mobile', 'تطبيق هاتف', 'Mobile app'], ['webapp', 'تطبيق ويب', 'Web app'], ['prototype', 'نموذج أولي', 'Prototype'],
  ] },
  { id: 'ai', ar: 'الذكاء الاصطناعي', en: 'Applied AI', categories: [
    ['assistant', 'مساعد ذكي', 'AI assistant'], ['automation', 'أتمتة', 'Automation'], ['integration', 'ربط الأنظمة', 'Integration'],
  ] },
  { id: 'ideas', ar: 'الأفكار والمشاريع', en: 'Ideas and projects', categories: [
    ['discovery', 'اكتشاف الفكرة', 'Discovery'], ['consulting', 'استشارة', 'Consulting'],
    ['prototype-plan', 'خطة نموذج أولي', 'Prototype plan'], ['startup', 'مشروع ناشئ', 'Startup'],
  ] },
] as const;

const statuses: Record<string, [string, string]> = {
  new: ['طلب جديد', 'New request'], new_request: ['طلب جديد', 'New request'],
  review: ['قيد المراجعة', 'Under review'], under_review: ['قيد المراجعة', 'Under review'],
  proposal: ['عرض سعر', 'Quote'], quote_sent: ['أُرسل عرض السعر', 'Quote sent'],
  waiting_customer_approval: ['بانتظار موافقتك', 'Awaiting your approval'],
  waiting_payment: ['بانتظار الدفع', 'Awaiting payment'], waiting_payment_to_start: ['بانتظار دفعة البدء', 'Awaiting initial payment'],
  waiting_developer_acceptance: ['بانتظار قبول المبرمج', 'Awaiting assignment'],
  active: ['قيد التنفيذ', 'In progress'], in_progress: ['قيد التنفيذ', 'In progress'],
  technical_review: ['مراجعة فنية', 'Technical review'], needs_revisions: ['مطلوب تعديلات', 'Revisions requested'],
  ready_delivery: ['جاهز للتسليم', 'Ready for delivery'], waiting_client_review: ['بانتظار مراجعتك', 'Awaiting your review'],
  delivered: ['تم التسليم', 'Delivered'], completed: ['مكتمل', 'Completed'], cancelled: ['ملغى', 'Cancelled'],
  closed: ['مغلقة', 'Closed'], converted: ['مرتبطة بطلب', 'Linked to a request'], waiting_customer: ['بانتظار ردّك', 'Awaiting your reply'],
  accepted: ['مقبول', 'Accepted'], sent: ['أُرسل', 'Sent'], pending: ['قيد الانتظار', 'Pending'],
  unpaid: ['غير مدفوع', 'Unpaid'], partial: ['مدفوع جزئياً', 'Partially paid'], collected: ['تم التحصيل', 'Collected'],
};

export const value = (entry: Search[string]) => Array.isArray(entry) ? entry[0] || '' : entry || '';
export const languageFrom = (query: Search): Language => value(query.lang) === 'en' ? 'en' : 'ar';
export const localized = (language: Language, ar: string, en: string) => language === 'en' ? en : ar;
export const serviceTitle = (service: string, language: Language) => services.find(item => item.id === service)?.[language] || localized(language, 'مشروع رقمي', 'Digital project');
export const statusTitle = (status: string, language: Language) => statuses[status]?.[language === 'en' ? 1 : 0] || localized(language, 'حالة المشروع', 'Project status');
export const safeId = (id: string) => /^[a-zA-Z0-9_-]{8,120}$/.test(id);
export const fileLimit = 4 * 1024 * 1024;
export const fileAccept = '.pdf,.png,.jpg,.jpeg,.webp';
export const fileValid = (file: File) => file.size > 0 && file.size <= fileLimit && /\.(pdf|png|jpe?g|webp)$/i.test(file.name);
export const phoneNumber = (input: string) => input.trim().replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) % 16)).replace(/[\s().-]/g, '');
export const phoneValid = (input: string) => /^\+[1-9][0-9]{7,14}$/.test(phoneNumber(input));
export const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), part => part.toString(16).padStart(2, '0')).join('');
const dateFormatters = { ar: new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }), en: new Intl.DateTimeFormat('en', { dateStyle: 'medium' }) };
const currencyFormatters = { ar: new Intl.NumberFormat('ar', { style: 'currency', currency: 'ILS' }), en: new Intl.NumberFormat('en', { style: 'currency', currency: 'ILS' }) };
export const dateLabel = (time: string | undefined, language: Language) => time && Number.isFinite(Date.parse(time)) ? dateFormatters[language].format(new Date(time)) : '—';
export const moneyLabel = (amount: number | null | undefined, language: Language) => typeof amount === 'number' && Number.isFinite(amount) ? currencyFormatters[language].format(amount) : '—';

export function pageHref(path: string, language: Language, options: Record<string, string | undefined> = {}) {
  const url = new URL(path, 'https://zezoforge.com');
  if (language === 'en') url.searchParams.set('lang', 'en');
  else url.searchParams.delete('lang');
  for (const [key, content] of Object.entries(options)) if (content) url.searchParams.set(key, content);
  return url.pathname + url.search + url.hash;
}

export function safeReturnPath(input: string) {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return '';
  try {
    const url = new URL(input, 'https://zezoforge.com');
    if (url.origin !== 'https://zezoforge.com' || !/^\/(?:request|contact|account\/(?:overview|orders(?:\/[a-zA-Z0-9_-]{8,120})?|settings))$/.test(url.pathname)) return '';
    const allowed = new URLSearchParams();
    for (const key of ['service', 'template', 'action', 'conversation', 'tab', 'lang']) {
      const entry = url.searchParams.get(key);
      if (entry && /^[a-zA-Z0-9_-]{1,120}$/.test(entry)) allowed.set(key, entry);
    }
    return url.pathname + (allowed.size ? '?' + allowed.toString() : '');
  } catch { return ''; }
}

export const accountHref = (language: Language, next?: string) => pageHref('/account', language, { next: next && safeReturnPath(next) });
export const orderHref = (id: string, language: Language) => pageHref('/account/orders/' + encodeURIComponent(id), language);
export const conversationHref = (id: string, language: Language) => pageHref('/account/settings', language, { tab: 'messages', conversation: id });

export class CustomerApiError extends Error {
  constructor(readonly status: number, message = '') { super(message); }
}

export async function customerApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  const data: { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) throw new CustomerApiError(response.status, data.error);
  return data as T;
}

export const postJson = <T,>(path: string, body: Record<string, unknown>, method = 'POST') => (
  customerApi<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
);

export function errorLabel(error: unknown, language: Language) {
  if (error instanceof CustomerApiError && error.message) {
    const segments = error.message.split(' / ');
    return language === 'en' ? segments.at(-1) || error.message : segments[0];
  }
  return localized(language, 'تعذّر الاتصال. حاول مجدداً. بقيت بياناتك محفوظة في هذه الصفحة.', 'The connection was interrupted. Try again. Your inputs are still on this page.');
}

export function notifyAccountChanged() {
  try { localStorage.setItem('zezo-session-context-changed', newKey()); } catch { /* storage may be disabled */ }
}

export async function captureCustomerReferral(referral: string) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(referral)) return;
  await customerApi('/api/referral-attribution?ref=' + encodeURIComponent(referral));
}
