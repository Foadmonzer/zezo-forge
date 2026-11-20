import Link from 'next/link';
import { PlatformShell } from '../platform/shell';
import { PublicBlock, PublicHero, PublicButton, PublicSectionTitle, ExampleTiles, PublicCallout } from '../platform/public-blocks';
import { findPublicService, publicContentMetadata, publicHref, publicLanguage, publicReferral, publicServices, publicTemplates, startRequest, type PublicQuery } from '../platform/public-content';

const title = { ar: 'أعمالنا ونماذجنا', en: 'Work and demos' };
const summary = {
  ar: 'تعرّف على منصة ZEZO Forge وجرّب نماذج توضيحية لاستخدامات مختلفة.',
  en: 'Explore ZEZO Forge and try illustrative demos for different project needs.'
};

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  return publicContentMetadata('/work', language, title[language], summary[language]);
}

export default async function WorkPage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  const isAr = language === 'ar';
  const service = typeof query.service === 'string' ? findPublicService(query.service) : undefined;
  const examples = service
    ? publicTemplates.filter(template => template.service === service.id).slice(0, 3)
    : publicServices.flatMap(item => publicTemplates.filter(template => template.id === item.example));

  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><PublicBlock language={language}>
    <PublicHero title={title[language]} detail={summary[language]}
      actions={<PublicButton href={startRequest(language)} primary>{isAr ? 'ابدأ مشروعاً مشابهاً' : 'Start a similar project'}</PublicButton>} />
    <section className="zpub-section">
      <article className="zpub-live-work">
        <div className="zpub-live-wordmark" aria-hidden="true">ZEZO<span>.</span></div>
        <div>
          <p className="zpub-kicker">{isAr ? 'مشروع ZEZO المنشور' : 'Live ZEZO project'}</p>
          <h2>ZEZO Forge</h2>
          <p>{isAr ? 'منصة تجمع مكان عرض الخدمات والقوالب مع مسار لطلب المشروع ومتابعته والتواصل مع الفريق.' : 'A platform that brings together our services and templates with a place to submit a project, follow progress, and talk with the team.'}</p>
          <PublicButton href={publicHref('/account', language)}>{isAr ? 'استكشف بوابة العميل' : 'Explore the client portal'}</PublicButton>
        </div>
      </article>
    </section>
    <section className="zpub-section">
      <PublicSectionTitle title={isAr ? 'نماذج استعراضية' : 'Interactive demos'}
        detail={isAr ? 'هذه أمثلة استعراضية للتجربة، وليست مشاريع عملاء.' : 'These are illustrative demos for trying ideas, separate from client projects.'} />
      <nav className="zpub-filter-links" aria-label={isAr ? 'تصفية الأعمال حسب الخدمة' : 'Filter work by service'}>
        <Link href={publicHref('/work', language)} className="zpub-button" aria-current={!service ? 'page' : undefined} prefetch={false}>{isAr ? 'كل النماذج' : 'All demos'}</Link>
        {publicServices.map(item => <Link key={item.id} href={publicHref(`/work?service=${item.id}`, language)} className="zpub-button" aria-current={item.id === service?.id ? 'page' : undefined} prefetch={false}>{item.label[language]}</Link>)}
      </nav>
      <ExampleTiles templates={examples} language={language} />
    </section>
    <PublicCallout language={language} service={service?.id} />
  </PublicBlock></PlatformShell>;
}
