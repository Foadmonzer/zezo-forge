'use client';

import { useEffect, useRef, useState } from 'react';
import { feedbackApi, type FeedbackLanguage, type PublishedReview, type ReviewList } from './feedback-data';
import { ProjectReviewCard } from './project-review-card';

export function PublicReviewPreview({ language }: { language: FeedbackLanguage }) {
  const [reviews, setReviews] = useState<PublishedReview[]>([]);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => feedbackApi<ReviewList>('/api/reviews?sort=newest&limit=3', language, { signal: controller.signal })
      .then(result => setReviews(result.reviews)).catch(() => {});
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { observer.disconnect(); void load(); }
    }, { rootMargin: '180px' });
    if (anchor.current) observer.observe(anchor.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [language]);

  const en = language === 'en';
  return <div ref={anchor} className="zf-review-preview">
    {reviews.length > 0 && <section className="zf-wrap zf-feedback-box" aria-labelledby="review-preview-heading">
      <h2 id="review-preview-heading">{en ? 'Customer reviews' : 'آراء العملاء'}</h2>
      <div className="zf-review-grid">{reviews.map(review => <ProjectReviewCard key={review.id} review={review} language={language} />)}</div>
      <a href={en ? '/reviews?lang=en' : '/reviews'}>{en ? 'Read all reviews' : 'عرض جميع التقييمات'}</a>
    </section>}
  </div>;
}
