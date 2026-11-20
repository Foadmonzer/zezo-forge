import type { Metadata } from 'next';
import { ProjectReviewModeration } from '../../platform/project-reviews';
import { publicLanguage, type PublicQuery } from '../../platform/public-content';
import { PlatformShell } from '../../platform/shell';

export const metadata: Metadata = { title: 'مراجعة التقييمات | ZEZO Forge', robots: { index: false, follow: false, noarchive: true }, referrer: 'no-referrer' };

export default async function ReviewModerationPage({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  const en = language === 'en';
  return <PlatformShell language={language}>
    <div className="zf-wrap zf-feedback-page">
      <header className="zf-feedback-hero"><h1>{en ? 'Review moderation' : 'مراجعة تقييمات العملاء'}</h1>
        <p>{en ? 'The Owner can publish eligible reviews, hide abusive content, and post official replies.' : 'يمكن للمالك نشر التقييمات المؤهلة وإخفاء المحتوى المسيء وإضافة الردود الرسمية.'}</p></header>
      <ProjectReviewModeration language={language} />
    </div>
  </PlatformShell>;
}
