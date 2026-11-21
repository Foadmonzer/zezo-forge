import { PlatformShell } from '../platform/shell';
import { PublicArt, PublicBlock, PublicHero, PublicButton, PublicSectionTitle, ProcessSteps, PublicCallout } from '../platform/public-blocks';
import { publicContentMetadata, publicHref, publicLanguage, publicReferral, startRequest, type PublicQuery } from '../platform/public-content';

const title = { ar: 'عن ZEZO', en: 'About ZEZO' };
const detail = { ar: 'نطوّر المواقع والتطبيقات وحلول الذكاء الاصطناعي، ونرافق مشروعك من الفكرة إلى التسليم.', en: 'We build websites, apps, and AI solutions, and support your project from the first idea to handover.' };

const principles = [
  { ar: ['الوضوح قبل التنفيذ', 'نفهم هدفك ونوضّح نطاق المشروع قبل بدء العمل.'], en: ['A clear scope', 'We learn what you want to achieve and explain the scope before work begins.'] },
  { ar: ['الاختبار قبل التسليم', 'نختبر الخطوات الأساسية التي يتّبعها المستخدم في الموقع أو التطبيق قبل تسليمه.'], en: ['Testing before handover', 'We test the main steps users take through the website or app before handover.'] },
  { ar: ['تواصل ومراجعة مستمران', 'تجد الطلب والتحديثات والملاحظات في حسابك لتعود إليها وقت الحاجة.'], en: ['Updates you can revisit', 'You can find requests, updates, and notes in your account whenever you need them.'] }
];

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  return publicContentMetadata('/about', language, title[language], detail[language]);
}

export default async function AboutPage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  const isAr = language === 'ar';
  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><PublicBlock language={language}>
    <PublicHero label="ZEZO Digital Solutions & AI" title={title[language]} detail={detail[language]}
      actions={<><PublicButton href={startRequest(language)} primary>{isAr ? 'اطلب مشروعك' : 'Start a project'}</PublicButton>
        <PublicButton href={publicHref('/contact', language)}>{isAr ? 'تواصل معنا' : 'Contact us'}</PublicButton></>}>
      <PublicArt scene="about" />
    </PublicHero>
    <section className="zpub-section zpub-columns zpub-about-notes">
      <div className="zpub-copy-panel"><h2>{isAr ? 'رسالتنا' : 'Our mission'}</h2>
        <p>{isAr ? 'نساعدك على تحويل حاجة عملية إلى خدمة رقمية يسهل على عملائك استخدامها وعلى فريقك إدارتها.' : 'We help you turn a practical need into a digital service your customers can use and your team can manage.'}</p>
      </div>
      <div className="zpub-copy-panel"><h2>{isAr ? 'رؤيتنا' : 'Our vision'}</h2>
        <p>{isAr ? 'أن يسهل عليك بدء مشروعك الرقمي ومراجعته وتطويره، عبر مراحل واضحة وتواصل مستمر.' : 'Make digital projects easier to start, review, and develop through clear milestones and ongoing communication.'}</p>
      </div>
    </section>
    <section className="zpub-section">
      <PublicSectionTitle title={isAr ? 'كيف نعمل معك' : 'How we work with you'} />
      <div className="zpub-principles zpub-about-principles">{principles.map(item => <article className="zpub-copy-panel" key={item.en[0]}><h3>{item[language][0]}</h3><p>{item[language][1]}</p></article>)}</div>
    </section>
    <section className="zpub-section"><PublicSectionTitle title={isAr ? 'مراحل المشروع' : 'Project stages'} /><ProcessSteps language={language} /></section>
    <PublicCallout language={language} />
  </PublicBlock></PlatformShell>;
}
