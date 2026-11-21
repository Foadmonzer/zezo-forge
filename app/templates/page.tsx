import { PlatformShell } from '../platform/shell';
import { PublicBlock, PublicButton, PublicHero, PublicCallout } from '../platform/public-blocks';
import { findPublicService, publicContentMetadata, publicLanguage, publicReferral, publicTemplates, startRequest, type PublicQuery } from '../platform/public-content';
import { TemplateLibrary } from '../platform/template-views';

const title = { ar: 'مكتبة القوالب', en: 'Template library' };
const summary = {
  ar: 'جرّب قوالب المواقع والمتاجر والتطبيقات وحلول الذكاء الاصطناعي، واختر نقطة بداية تناسب مشروعك.',
  en: 'Try website, store, app, and AI templates and find a practical starting point for your project.'
};

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  return publicContentMetadata('/templates', language, title[language], summary[language]);
}

export default async function TemplatesPage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  const initialService = typeof query.service === 'string' ? findPublicService(query.service)?.id : undefined;
  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><PublicBlock language={language}>
    <PublicHero title={title[language]} detail={summary[language]}
      actions={<PublicButton href={startRequest(language)} primary>{language === 'ar' ? 'اطلب تصميماً خاصاً' : 'Request a custom design'}</PublicButton>} />
    <TemplateLibrary templates={publicTemplates} language={language} initialService={initialService || 'all'} />
    <PublicCallout language={language} />
  </PublicBlock></PlatformShell>;
}
