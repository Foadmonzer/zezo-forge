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
    summary: copy('مواقع ومتاجر تعرض منتجاتك أو خدماتك بوضوح، وتسهّل على الزائر الاستفسار أو الشراء.', 'Websites and stores that explain what you offer and make it easy to enquire or buy.'),
    outcome: copy('نحدد هدف الموقع وما يحتاج إليه الزائر، ثم نبني الصفحات والوظائف المناسبة للهاتف والكمبيوتر.', 'We define the site’s goals and what visitors need, then build pages and features that work on phones and computers.'),
    categories: [
      { id: 'site', label: copy('موقع تعريفي أو صفحة هبوط', 'Business website or landing page') },
      { id: 'store', label: copy('متجر إلكتروني', 'E-commerce store') },
      { id: 'care', label: copy('تحسين صفحة وصيانتها', 'Page improvements and maintenance') },
      { id: 'audit', label: copy('مراجعة مصغّرة للموقع', 'Quick website review') },
      { id: 'maintenance', label: copy('صيانة شهرية', 'Monthly maintenance') }
    ],
    features: [copy('محتوى منظّم وسهل القراءة', 'Clear, readable content'), copy('تصميم يتكيّف مع حجم الشاشة', 'Responsive layouts'), copy('نماذج وكتالوجات وفق نطاق المشروع', 'Forms and catalogs based on your project scope')],
    faq: [
      { question: copy('هل يمكن تطوير موقع قائم؟', 'Can you improve an existing site?'), answer: copy('نعم، شارك رابط الموقع والمشكلات التي تريد حلها لنراجع ما يمكن تحسينه ضمن بنيته الحالية.', 'Yes. Share the site URL and the problems you want to solve so we can review what can be improved within the existing setup.') },
      { question: copy('كيف يُحدَّد السعر؟', 'How do you determine the price?'), answer: copy('إذا كان للقالب سعر ابتدائي، ستجده في صفحته. نراجع الوظائف والمحتوى المطلوبين قبل تقديم عرض السعر.', 'When a template has a starting price, you’ll find it on its page. We review the required features and content before preparing your quote.') }
    ],
    example: 'web-copper-table'
  },
  {
    id: 'apps', label: copy('تطبيقات الويب والهاتف', 'Web and mobile apps'), title: copy('تطوير التطبيقات', 'App development'),
    summary: copy('نبني تطبيقات ويب وهاتف تلبي احتياجات المستخدمين ويمكن تطويرها مع توسّع المشروع.', 'We build web and mobile apps around user needs, with room to grow as your project evolves.'),
    outcome: copy('نحدّد مهام المستخدمين والشاشات والبيانات اللازمة، ثم نختبر خطوات الاستخدام الأساسية قبل إضافة ميزات أخرى.', 'We map users’ tasks, screens, and data, then test the essential workflows before adding more features.'),
    categories: [
      { id: 'mobile', label: copy('تطبيق للهاتف', 'Mobile app') },
      { id: 'webapp', label: copy('تطبيق ويب ولوحة تحكم', 'Web app and dashboard') },
      { id: 'prototype', label: copy('نموذج أولي للمنتج', 'Product prototype') }
    ],
    features: [copy('خطوات استخدام بسيطة', 'Straightforward workflows'), copy('ربط البيانات وتحديد صلاحيات المستخدمين حسب الحاجة', 'Data integration and user permissions as needed'), copy('اختبار خطوات الاستخدام الأساسية', 'Tests for essential user workflows')],
    faq: [
      { question: copy('متى أختار تطبيق ويب؟', 'When should I choose a web app?'), answer: copy('تطبيق الويب يناسب الوصول من المتصفح دون تثبيت، ويمكن أن يكون البداية المناسبة إذا كانت الوظائف المطلوبة لا تعتمد على إمكانات الجهاز.', 'A web app is a good starting point when people need browser access and the features do not depend on device-specific capabilities.') },
      { question: copy('هل أحتاج إلى كل الميزات من البداية؟', 'Do I need every feature in the first release?'), answer: copy('يمكنك البدء بالوظائف الأساسية والتخطيط للميزات اللاحقة أثناء مراجعة نطاق المشروع.', 'You can start with the essential features and plan later additions when we review the scope.') }
    ],
    example: 'app-serveflow'
  },
  {
    id: 'ai', label: copy('مساعدات وأتمتة', 'Assistants & automation'), title: copy('حلول الذكاء الاصطناعي', 'AI solutions'),
    summary: copy('مساعدات ذكية وأتمتة وربط للأنظمة لتسهيل المهام المتكررة على فريقك.', 'AI assistants, automation, and integrations that make repetitive tasks easier for your team.'),
    outcome: copy('نحدّد المهمة ومصادر المعلومات والحالات التي تتطلب مراجعة بشرية، ثم نختبر النتائج على أمثلة مناسبة قبل الاستخدام.', 'We identify the task, its information sources, and where human review is needed. Then we test the results before rollout.'),
    categories: [
      { id: 'assistant', label: copy('مساعد ذكي', 'AI assistant') },
      { id: 'automation', label: copy('أتمتة سير العمل', 'Workflow automation') },
      { id: 'integration', label: copy('ربط النماذج والبيانات', 'Model and data integration') }
    ],
    features: [copy('مصادر معلومات معتمدة', 'Approved knowledge sources'), copy('خطوات مراجعة بشرية حسب الحاجة', 'Human review where needed'), copy('اختبار المخرجات قبل الدمج', 'Output evaluation before integration')],
    faq: [
      { question: copy('هل يمكن ربط المساعد بموقع قائم؟', 'Can an assistant connect to an existing website?'), answer: copy('نراجع الموقع ومصادر المعلومات والصلاحيات أولًا، ثم نحدّد طريقة الربط المتاحة.', 'We review the website, information sources, and permissions before proposing an integration.') },
      { question: copy('ما المعلومات اللازمة للبدء؟', 'What do you need to get started?'), answer: copy('وصف المهمة المتكررة والمصادر المتاحة والنتيجة المطلوبة، مع أمثلة خالية من البيانات الخاصة.', 'Describe the recurring task, available sources, and desired outcome, with examples that do not contain private data.') }
    ],
    example: 'ai-helio-desk'
  },
  {
    id: 'ideas', label: copy('تخطيط ونماذج أولية', 'Planning and prototypes'), title: copy('دعم المشاريع والأفكار', 'Project and idea support'),
    summary: copy('نحوّل فكرتك إلى نطاق واضح وخطوات تنفيذ يمكن اختبارها.', 'We turn your idea into a clear project scope and practical steps you can test.'),
    outcome: copy('نحدّد المشكلة والجمهور وما نحتاج إلى اختباره أولًا، ثم نخطّط معك للمرحلة الأولى أو نبني نموذجًا أوليًّا حسب احتياجات المشروع.', 'We identify the problem, the audience, and what to test first. Then we plan the next stage with you or build a prototype that fits your needs.'),
    categories: [
      { id: 'discovery', label: copy('جلسة لفهم الفكرة وترتيب الأولويات', 'Discovery and planning session') },
      { id: 'consulting', label: copy('استشارة تقنية', 'Technology consultation') },
      { id: 'prototype-plan', label: copy('خطة لنموذج أولي', 'Prototype plan') },
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
  { title: copy('نفهم فكرتك', 'Understand your idea'), detail: copy('أخبرنا بهدفك وما يحتاج إليه مستخدموك.', 'Tell us what you want to achieve and what your users need.') },
  { title: copy('نحدد النطاق', 'Define the scope'), detail: copy('نراجع الأولويات ونوضح ما يشمله العرض.', 'We review priorities and clarify the scope of your quote.') },
  { title: copy('نبني ونراجع', 'Build and review'), detail: copy('تابع تقدّم المشروع وراجع التحديثات من حسابك.', 'Follow the project and review updates in your account.') },
  { title: copy('نسلّم المشروع', 'Hand over the project'), detail: copy('نراجع التسليم معك ونوضح الخطوة التالية.', 'We review the handover with you and clarify the next step.') }
];
