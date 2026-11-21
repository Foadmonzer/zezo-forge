'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { feedbackApi, feedbackErrorText, reviewStatus, type FeedbackLanguage, type ProjectReview } from './feedback-data';
import { ProjectReviewCard } from './project-review-card';

type ReviewState = { eligible: boolean; review: ProjectReview | null };

export function ProjectReviewPanel({ projectId, language }: { projectId: string; language: FeedbackLanguage }) {
  const endpoint = `/api/client/project-reviews/${encodeURIComponent(projectId)}`;
  const en = language === 'en';
  const [state, setState] = useState<ReviewState | null>(null);
  const [rating, setRating] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError('');
    setRating('');
    setBody('');
    feedbackApi<ReviewState>(endpoint, language, { signal: controller.signal })
      .then(setState).catch(error => {
        if (!controller.signal.aborted) setError(feedbackErrorText(error, language));
      });
    return () => controller.abort();
  }, [endpoint, language]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await feedbackApi<{ review: ProjectReview }>(endpoint, language, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: Number(rating), body })
      });
      setState({ eligible: true, review: result.review });
      setBody('');
    } catch (error) {
      setError(feedbackErrorText(error, language));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <section className="zf-feedback-box" aria-label={en ? 'Project review' : 'تقييم المشروع'}>
    <h2>{en ? 'Project review' : 'تقييم المشروع'}</h2>
    {error && <p className="zf-feedback-error" role="alert">{error}</p>}
    {!state && !error && <p role="status">{en ? 'Checking eligibility…' : 'جارٍ التحقق من أهلية التقييم…'}</p>}
    {state?.review && <><p role="status">{reviewStatus(state.review.status, language)}</p><ProjectReviewCard review={state.review} language={language} /></>}
    {state && !state.eligible && !state.review && <p>{en ? 'You can review this project once it has been delivered and completed.' : 'يمكنك تقييم هذا المشروع بعد تسليمه وإكماله.'}</p>}
    {state?.eligible && !state.review && <form onSubmit={submit} className="zf-feedback-form" aria-busy={busy}>
      <fieldset disabled={busy} className="zf-review-rating">
        <legend>{en ? 'Rating' : 'التقييم'}</legend>
        {[1, 2, 3, 4, 5].map(value => <label key={value}>
          <input type="radio" name="project-rating" value={value} checked={rating === String(value)} onChange={event => setRating(event.target.value)} required />
          <span>{value} <span aria-hidden="true">★</span></span>
        </label>)}
      </fieldset>
      <label>{en ? 'Your review' : 'رأيك'}<textarea value={body} onChange={event => setBody(event.target.value)} minLength={8} maxLength={1200} rows={4} dir="auto" required disabled={busy} /></label>
      <p>{en ? 'Reviews may be published after moderation. Keep personal information and private project details out of your review.' : 'قد يُنشر تقييمك بعد مراجعته. تجنّب إدراج المعلومات الشخصية أو تفاصيل المشروع الخاصة.'}</p>
      <button className="zf-button zf-button--primary" disabled={busy}>{busy ? (en ? 'Submitting…' : 'جارٍ الإرسال…') : (en ? 'Submit review' : 'إرسال التقييم')}</button>
    </form>}
  </section>;
}
