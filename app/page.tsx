import { redirect } from 'next/navigation';
import LegacyPage from './legacy-page';
import { PublicHome } from './platform/public-home';
import { publicContentMetadata, publicHref, publicLanguage, type PublicQuery } from './platform/public-content';
import { PlatformShell } from './platform/shell';
import { privatePageMetadata, zezoShareDescription } from './platform/share-metadata';

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  if (query.preview || query.track || query.token || query.verifyEmail || query.resetPassword) return privatePageMetadata;
  const language = publicLanguage(query);
  return publicContentMetadata('/', language,
    language === 'ar' ? 'من الفكرة إلى الواقع الرقمي' : 'From idea to digital reality',
    language === 'ar' ? zezoShareDescription : 'From idea to digital reality — websites, apps, and AI solutions.');
}

export default async function HomePage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  if (query.preview || query.track || query.token) return <LegacyPage />;
  if (typeof query.templateRequest === 'string') {
    const next = new URLSearchParams({ template: query.templateRequest, action: query.templateAction === 'customize' ? 'customize' : 'order' });
    if (typeof query.ref === 'string') next.set('ref', query.ref);
    redirect(publicHref(`/request?${next}`, language));
  }
  if (typeof query.verifyEmail === 'string' || typeof query.resetPassword === 'string') {
    const params = new URLSearchParams();
    if (typeof query.verifyEmail === 'string') params.set('verifyEmail', query.verifyEmail);
    if (typeof query.resetPassword === 'string') params.set('resetPassword', query.resetPassword);
    if (typeof query.ref === 'string') params.set('ref', query.ref);
    redirect(publicHref(`/account?${params}`, language));
  }
  return <PlatformShell language={language} incomingReferral={typeof query.ref === 'string' ? query.ref : undefined}><PublicHome language={language} /></PlatformShell>;
}
