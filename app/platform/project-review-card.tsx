import type { FeedbackLanguage, PublishedReview } from './feedback-data';
import './feedback.css';

const serviceNames: Record<string, [string, string]> = {
  web: ['مواقع ومتاجر', 'Websites & stores'], apps: ['تطبيقات', 'Apps'], ai: ['ذكاء اصطناعي', 'AI'],
  ideas: ['تطوير فكرة', 'Idea development']
};

export function ProjectReviewCard({ review, language }: { review: PublishedReview; language: FeedbackLanguage }) {
  const english = language === 'en';
  const date = (value: string) => new Intl.DateTimeFormat(english ? 'en-US' : 'ar-AE', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
  const label = english ? `${review.rating} out of 5 stars` : `${review.rating} من 5 نجوم`;
  return <article className="zf-review-card">
    <header>
      <span className="zf-review-stars" aria-label={label} role="img" dir="ltr">{'★'.repeat(review.rating)}<span aria-hidden="true">{'☆'.repeat(5 - review.rating)}</span></span>
      <time dateTime={review.submittedAt}>{date(review.submittedAt)}</time>
    </header>
    <p className="zf-review-body" dir="auto">{review.body}</p>
    {serviceNames[review.service] && <p className="zf-review-service">{serviceNames[review.service][english ? 1 : 0]}</p>}
    {review.reply && <aside className="zf-review-reply" aria-label={english ? 'Official ZEZO reply' : 'رد ZEZO الرسمي'}>
      <div><strong>{english ? 'Official ZEZO reply' : 'رد ZEZO الرسمي'}</strong><time dateTime={review.reply.createdAt}>{date(review.reply.createdAt)}</time></div>
      <p dir="auto">{review.reply.body}</p>
    </aside>}
  </article>;
}
