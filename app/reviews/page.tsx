import { PublicProjectReviews } from '../platform/project-reviews';
import { publicContentMetadata, publicLanguage, type PublicQuery } from '../platform/public-content';
import { PlatformShell, platformLink } from '../platform/shell';

const title = { ar: 'آراء العملاء', en: 'Customer reviews' };
const details = { ar: 'تقييمات يكتبها عملاء ZEZO بعد تسليم مشاريعهم وإكمالها.', en: 'Reviews from ZEZO customers after their projects are delivered and complete.' };

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  return publicContentMetadata('/reviews', language, title[language], details[language]);
}

export default async function ReviewsPage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  return <PlatformShell language={language} incomingReferral={typeof query.ref === 'string' ? query.ref : undefined}>
    <div className="zf-wrap zf-feedback-page">
      <header className="zf-feedback-hero"><h1>{title[language]}</h1><p>{details[language]}</p>
        <a className="zf-button" href={platformLink('/account/orders', language)}>{language === 'en' ? 'See my projects' : 'عرض مشاريعي'}</a>
      </header>
      <PublicProjectReviews language={language} />
    </div>
  </PlatformShell>;
}
