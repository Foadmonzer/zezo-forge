import { PlatformShell } from '../platform/shell';
import { PublicBlock, PublicHero, PublicButton, ProcessSteps, PublicSectionTitle, ServiceGrid, PublicCallout } from '../platform/public-blocks';
import { publicContentMetadata, publicLanguage, publicReferral, startRequest, type PublicQuery } from '../platform/public-content';

const title = { ar: 'خدمات ZEZO', en: 'ZEZO services' };
const summary = { ar: 'تطوير مواقع وتطبيقات وحلول ذكاء اصطناعي، مع دعم عملي للمشاريع والأفكار.', en: 'Web and app development, AI solutions, and practical support for new projects and ideas.' };

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  return publicContentMetadata('/services', language, title[language], summary[language]);
}

export default async function ServicesPage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  const isAr = language === 'ar';
  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><PublicBlock language={language}>
    <PublicHero title={title[language]} detail={summary[language]}
      actions={<PublicButton href={startRequest(language)} primary>{isAr ? 'ابدأ بطلب مشروع' : 'Start a project'}</PublicButton>} />
    <section className="zpub-section" aria-label={title[language]}><ServiceGrid language={language} includeRequest /></section>
    <section className="zpub-section">
      <PublicSectionTitle title={isAr ? 'من الطلب إلى التسليم' : 'From enquiry to handover'} />
      <ProcessSteps language={language} />
    </section>
    <PublicCallout language={language} />
  </PublicBlock></PlatformShell>;
}
