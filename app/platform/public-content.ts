import type { Metadata } from 'next';
import { templateCatalog } from '../../public/template-catalog.js';

export type PublicLanguage = 'ar' | 'en';
export type Localized = { ar: string; en: string };
export type PublicQuery = Promise<Record<string, string | string[] | undefined>>;
export type ServiceId = 'web' | 'apps' | 'ai' | 'ideas';

const copy = (ar: string, en: string): Localized => ({ ar, en });

export function publicLanguage(params: Record<string, string | string[] | undefined>): PublicLanguage {
  return params.lang === 'en' ? 'en' : 'ar';
}

export function publicReferral(params: Awaited<PublicQuery>) {
  return typeof params.ref === 'string' ? params.ref.trim().slice(0, 100) : undefined;
}

export function publicHref(path: string, language: PublicLanguage) {
  if (language === 'ar') return path;
  const [base, fragment] = path.split('#', 2);
  return `${base}${base.includes('?') ? '&' : '?'}lang=en${fragment ? `#${fragment}` : ''}`;
}

export function startRequest(language: PublicLanguage, values: { service?: ServiceId; category?: string; template?: string; action?: 'order' | 'customize' } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return publicHref(params.size ? `/request?${params}` : '/request', language);
}

export function publicContentMetadata(path: string, language: PublicLanguage, title: string, description: string, image = '/assets/zezo-planet-texture.jpg'): Metadata {
  const canonical = publicHref(path, language);
  return {
    title: `${title} | ZEZO Forge`,
    description,
    alternates: { canonical, languages: { ar: path, en: publicHref(path, 'en'), 'x-default': path } },
    openGraph: { type: 'website', url: canonical, siteName: 'ZEZO Forge', title, description, locale: language === 'ar' ? 'ar_AE' : 'en_US', images: [{ url: image }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] }
  };
}

type Service = {
  id: ServiceId;
  label: Localized;
  title: Localized;
  summary: Localized;
  outcome: Localized;
  categories: { id: string; label: Localized }[];
  features: Localized[];
  faq: { question: Localized; answer: Localized }[];
  example: string;
};

export const publicServices: Service[] = [
  {
    id: 'web', label: copy('مواقع ومتاجر', 'Websites & stores'), title: copy('تطوير المواقع', 'Web development'),
    summary: copy('واجهات واضحة تشرح عرضك وتساعد الزائر على الطلب أو الشراء بسهولة.', 'Clear interfaces that explain your offer and make it easy to enquire or buy.'),
    outcome: copy('نبدأ بتحديد هدف الموقع ومسار الزائر، ثم نبني الصفحات والوظائف التي تخدم هذا الهدف على الهاتف والكمبيوتر.', 'We start with the site’s goal and the visitor’s journey, then build the pages and features that serve both on mobile and desktop.'),
    categories: [
      { id: 'site', label: copy('موقع تعريفي أو صفحة هبوط', 'Business website or landing page') },
      { id: 'store', label: copy('متجر إلكتروني', 'E-commerce store') },
      { id: 'care', label: copy('تحسين وصيانة صفحة', 'Page improvements') },
      { id: 'audit', label: copy('تحليل مصغّر', 'Mini review') },
      { id: 'maintenance', label: copy('صيانة شهرية', 'Monthly maintenance') }
    ],
    features: [copy('هيكلة محتوى سهلة القراءة', 'Readable content structure'), copy('تصميم يستجيب لحجم الشاشة', 'Responsive layouts'), copy('نماذج وكتالوجات حسب النطاق', 'Forms and catalogs as scoped')],
    faq: [
      { question: copy('هل يمكن تطوير موقع قائم؟', 'Can you improve an existing site?'), answer: copy('نعم، شارك رابط الموقع والمشكلات التي تريد حلها لنراجع ما يمكن تحسينه ضمن بنيته الحالية.', 'Yes. Share the site URL and the problems you want to solve so we can review what can be improved within the existing setup.') },
      { question: copy('كيف يُحدد السعر؟', 'How is the price set?'), answer: copy('تحدد الصفحة تفاصيل السعر الابتدائي إذا كان هناك قالب مختار. نراجع الوظائف والمحتوى المطلوبين قبل تقديم عرض مناسب.', 'A selected template has its own starting price. We review the required features and content before preparing a quote.') }
    ],
    example: 'web-copper-table'
  },
  {
    id: 'apps', label: copy('ويب وموبايل', 'Web & mobile'), title: copy('تطوير التطبيقات', 'App development'),
    summary: copy('تطبيقات ويب وموبايل تبدأ من احتياج المستخدم، مع مسار واضح للتوسع.', 'Web and mobile products that start from user needs and leave a clear path to grow.'),
    outcome: copy('نرتب المهام الرئيسية ونحدد الشاشات والبيانات اللازمة، ثم نختبر الرحلة قبل التوسع في بقية الوظائف.', 'We map the key tasks, screens, and data, then test the journey before expanding the feature set.'),
    categories: [
      { id: 'mobile', label: copy('تطبيق موبايل', 'Mobile app') },
      { id: 'webapp', label: copy('تطبيق ويب ولوحة تحكم', 'Web app and dashboard') },
      { id: 'prototype', label: copy('نموذج أولي للمنتج', 'Product prototype') }
    ],
    features: [copy('مسارات استخدام قصيرة', 'Short user journeys'), copy('تكامل مع البيانات والأدوار حسب الحاجة', 'Data and role integrations as needed'), copy('اختبارات للرحلات الأساسية', 'Tests for key user journeys')],
    faq: [
      { question: copy('متى أختار تطبيق ويب؟', 'When should I choose a web app?'), answer: copy('تطبيق الويب يناسب الوصول من المتصفح دون تثبيت، ويمكن أن يكون البداية المناسبة إذا كانت الوظائف المطلوبة لا تعتمد على إمكانات الجهاز.', 'A web app is a good starting point when people need browser access and the features do not depend on device-specific capabilities.') },
      { question: copy('هل أحتاج إلى كل الميزات من البداية؟', 'Do I need every feature in the first release?'), answer: copy('يمكن بدء المشروع بالرحلة الأساسية وتحديد الميزات اللاحقة أثناء مراجعة النطاق.', 'You can start with the key user journey and plan later features while reviewing the scope.') }
    ],
    example: 'app-serveflow'
  },
  {
    id: 'ai', label: copy('مساعدات وأتمتة', 'Assistants & automation'), title: copy('حلول الذكاء الاصطناعي', 'AI solutions'),
    summary: copy('مساعدات وأتمتة وتكاملات تساعد فريقك في المهام العملية المتكررة.', 'Assistants, automation, and integrations that help your team with repetitive work.'),
    outcome: copy('نحدد المهمة ومصادر المعلومات ومتى يحتاج القرار إلى تدخل شخص، ثم نختبر النتائج على أمثلة مناسبة قبل الاستخدام.', 'We identify the task, information sources, and when a person needs to step in, then evaluate the results on suitable examples.'),
    categories: [
      { id: 'assistant', label: copy('مساعد ذكي', 'AI assistant') },
      { id: 'automation', label: copy('أتمتة سير عمل', 'Workflow automation') },
      { id: 'integration', label: copy('تكامل نماذج وبيانات', 'Model and data integration') }
    ],
    features: [copy('مصادر معلومات معتمدة', 'Approved knowledge sources'), copy('خطوات مراجعة بشرية حسب الحاجة', 'Human review where needed'), copy('اختبار المخرجات قبل الدمج', 'Output evaluation before integration')],
    faq: [
      { question: copy('هل يمكن ربط المساعد بموقع قائم؟', 'Can an assistant connect to an existing website?'), answer: copy('نراجع الموقع ومصادر المعلومات والصلاحيات أولاً، ثم نحدد طريقة الربط المتاحة.', 'We review the website, information sources, and permissions before proposing an integration.') },
      { question: copy('ما المعلومات اللازمة للبدء؟', 'What do you need to get started?'), answer: copy('وصف المهمة المتكررة والمصادر المتاحة والنتيجة المطلوبة، مع أمثلة خالية من البيانات الخاصة.', 'Describe the recurring task, available sources, and desired outcome, with examples that do not contain private data.') }
    ],
    example: 'ai-helio-desk'
  },
  {
    id: 'ideas', label: copy('تخطيط ونماذج أولية', 'Planning & prototypes'), title: copy('دعم المشاريع والأفكار', 'Project & idea support'),
    summary: copy('نحوّل الفكرة إلى نطاق واضح وخطوات تنفيذ يمكن اختبارها.', 'Turn an early idea into a clear scope and actionable steps you can test.'),
    outcome: copy('نحدد المشكلة والجمهور وما يستحق الاختبار أولاً، ونبني معك مساراً للاكتشاف أو نسخة أولية حسب احتياج المشروع.', 'We identify the problem, audience, and first assumptions to test, then shape discovery or a prototype around your needs.'),
    categories: [
      { id: 'discovery', label: copy('جلسة اكتشاف وترتيب', 'Discovery and planning') },
      { id: 'consulting', label: copy('استشارة تقنية', 'Technology consultation') },
      { id: 'prototype-plan', label: copy('خارطة نموذج أولي', 'Prototype roadmap') },
      { id: 'startup', label: copy('برنامج الطلاب والمشاريع الناشئة', 'Student & startup program') }
    ],
    features: [copy('تحديد الأولويات', 'Priority setting'), copy('خريطة مراحل قابلة للمراجعة', 'A roadmap you can review'), copy('تصور أولي لاختبار الاتجاه', 'An early prototype to test direction')],
    faq: [
      { question: copy('هل أحتاج أن أكتب وثيقة متطلبات؟', 'Do I need a requirements document?'), answer: copy('يكفي أن تصف فكرتك والجمهور والنتيجة التي تتوقعها. نرتب التفاصيل معك أثناء المناقشة.', 'Start with the idea, audience, and outcome you expect. We can organize the details with you during discovery.') },
      { question: copy('هل يشمل ذلك التنفيذ؟', 'Does this include implementation?'), answer: copy('نحدد حدود التخطيط والتصميم والتنفيذ في عرض المشروع حسب احتياجك.', 'We define the planning, design, and implementation scope in the project quote based on what you need.') }
    ],
    example: 'idea-business-canvas'
  }
];

export function findPublicService(id: string) {
  return publicServices.find(service => service.id === id);
}

export type PublicTemplate = {
  id: string;
  code: string;
  service: ServiceId;
  category: string;
  kind: string;
  title: Localized;
  headline: Localized;
  image: string;
  imageAlt: Localized;
  description: Localized;
  features: { ar: string[]; en: string[] };
};

export const publicTemplates = templateCatalog as PublicTemplate[];

export const workSteps = [
  { title: copy('نسمع فكرتك', 'Understand the brief'), detail: copy('شارك الهدف وما يحتاجه مستخدموك.', 'Tell us what you want to achieve and what your users need.') },
  { title: copy('نحدد النطاق', 'Define the scope'), detail: copy('نراجع الأولويات ونوضح ما يشمله العرض.', 'We review priorities and clarify the scope of your quote.') },
  { title: copy('نبني ونراجع', 'Build and review'), detail: copy('تتابع المسار وتراجع التقدم من حسابك.', 'Follow progress and review updates in your account.') },
  { title: copy('نسلّم المشروع', 'Hand over the project'), detail: copy('نراجع التسليم معك ونوضح الخطوة التالية.', 'We review the handover with you and clarify the next step.') }
];
