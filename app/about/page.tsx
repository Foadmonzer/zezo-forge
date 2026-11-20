import { PlatformShell } from '../platform/shell';
import { PublicBlock, PublicHero, PublicButton, PublicSectionTitle, ProcessSteps, PublicCallout } from '../platform/public-blocks';
import { publicContentMetadata, publicHref, publicLanguage, publicReferral, startRequest, type PublicQuery } from '../platform/public-content';

const title = { ar: 'عن ZEZO', en: 'About ZEZO' };
const detail = { ar: 'ZEZO Digital Solutions & AI شركة تطوّر المواقع والتطبيقات والحلول الرقمية من الفكرة حتى التسليم.', en: 'ZEZO Digital Solutions & AI builds websites, apps, and digital solutions from idea through handover.' };

const principles = [
  { ar: ['الوضوح قبل التنفيذ', 'نعرف ما تريد تحقيقه ونوضح ما يشمله المشروع قبل العمل.'], en: ['Clarity before building', 'We understand what you want to achieve and explain the scope before work begins.'] },
  { ar: ['الاختبار جزء من العمل', 'نراجع الرحلات الأساسية للعميل والمستخدم قبل تسليمها.'], en: ['Testing is part of the work', 'We review the main client and user journeys before handover.'] },
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
    <PublicHero label="ZEZO DIGITAL SOLUTIONS & AI" title={title[language]} detail={detail[language]}
      actions={<><PublicButton href={startRequest(language)} primary>{isAr ? 'اطلب مشروعك' : 'Start a project'}</PublicButton>
        <PublicButton href={publicHref('/contact', language)}>{isAr ? 'تواصل معنا' : 'Contact us'}</PublicButton></>}>
      <div className="zpub-live-wordmark" aria-hidden="true">ZEZO<span>.</span></div>
    </PublicHero>
    <section className="zpub-section zpub-columns">
      <div className="zpub-copy-panel"><h2>{isAr ? 'رسالتنا' : 'Our mission'}</h2>
        <p>{isAr ? 'نساعد أصحاب المشاريع على تحويل احتياج عملي إلى تجربة رقمية واضحة، يستطيع عملاؤهم استخدامها ويستطيع فريقهم متابعتها.' : 'We help project owners turn a practical need into a clear digital experience their customers can use and their team can manage.'}</p>
      </div>
      <div className="zpub-copy-panel"><h2>{isAr ? 'رؤيتنا' : 'Our vision'}</h2>
        <p>{isAr ? 'أن يصبح بدء مشروع رقمي ومراجعته وتطويره أسهل عبر مراحل مفهومة ومتابعة مستمرة.' : 'Make it easier to start, review, and grow a digital project through clear stages and ongoing collaboration.'}</p>
      </div>
    </section>
    <section className="zpub-section">
      <PublicSectionTitle title={isAr ? 'كيف نعمل معك' : 'How we work with you'} />
      <div className="zpub-principles">{principles.map(item => <article className="zpub-copy-panel" key={item.en[0]}><h3>{item[language][0]}</h3><p>{item[language][1]}</p></article>)}</div>
    </section>
    <section className="zpub-section"><PublicSectionTitle title={isAr ? 'مراحل المشروع' : 'Project stages'} /><ProcessSteps language={language} /></section>
    <PublicCallout language={language} />
  </PublicBlock></PlatformShell>;
}
