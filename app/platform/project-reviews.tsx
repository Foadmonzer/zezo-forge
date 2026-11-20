'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { feedbackApi, feedbackErrorText, FeedbackError, reviewStatus, type FeedbackLanguage, type ProjectReview, type ReviewList, type ReviewStatus } from './feedback-data';
import { ProjectReviewCard } from './project-review-card';

const pageSize = 12;

function ReviewPagination({ page, total, change, language }: { page: number; total: number; change: (page: number) => void; language: FeedbackLanguage }) {
  if (total <= pageSize && page === 0) return null;
  const en = language === 'en';
  return <nav className="zf-review-pagination" aria-label={en ? 'Review pages' : 'صفحات التقييمات'}>
    <button type="button" className="zf-button" onClick={() => change(page - 1)} disabled={!page}>{en ? 'Previous' : 'السابق'}</button>
    <span>{en ? `Page ${page + 1}` : `صفحة ${page + 1}`}</span>
    <button type="button" className="zf-button" onClick={() => change(page + 1)} disabled={(page + 1) * pageSize >= total}>{en ? 'Next' : 'التالي'}</button>
  </nav>;
}

export function PublicProjectReviews({ language }: { language: FeedbackLanguage }) {
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ReviewList | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const en = language === 'en';
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    const query = new URLSearchParams({ sort, limit: String(pageSize), offset: String(page * pageSize) });
    feedbackApi<ReviewList>(`/api/reviews?${query}`, language, { signal: controller.signal }).then(setData).catch(error => {
      if (!controller.signal.aborted) setError(feedbackErrorText(error, language));
    });
    return () => controller.abort();
  }, [language, sort, page, retry]);

  return <section className="zf-feedback-box" aria-label={en ? 'Published reviews' : 'التقييمات المنشورة'}>
    <div className="zf-feedback-filter">
      <label>{en ? 'Sort reviews' : 'ترتيب التقييمات'}
        <select value={sort} onChange={event => { setSort(event.target.value); setPage(0); }}>
          <option value="newest">{en ? 'Newest first' : 'الأحدث أولاً'}</option>
          <option value="highest">{en ? 'Highest rating' : 'أعلى تقييم'}</option>
          <option value="lowest">{en ? 'Lowest rating' : 'أقل تقييم'}</option>
        </select>
      </label>
    </div>
    {error && <div><p role="alert" className="zf-feedback-error">{error}</p><button className="zf-button" onClick={() => setRetry(value => value + 1)}>{en ? 'Try again' : 'حاول مجدداً'}</button></div>}
    {!data && !error && <p role="status">{en ? 'Loading reviews…' : 'جارٍ تحميل التقييمات…'}</p>}
    {data && <>
      {data.reviews.length ? <div className="zf-review-grid">{data.reviews.map(review => <ProjectReviewCard key={review.id} review={review} language={language} />)}</div>
        : <p role="status">{en ? 'There are no published customer reviews yet.' : 'لا توجد تقييمات منشورة من العملاء حتى الآن.'}</p>}
      <ReviewPagination page={page} total={data.total} change={setPage} language={language} />
    </>}
  </section>;
}

function ModerationCard({ review, language, apply, busy }: { review: ProjectReview; language: FeedbackLanguage; apply: (body: { status: ReviewStatus } | { reply: string }) => Promise<boolean>; busy: boolean }) {
  const [reply, setReply] = useState(review.reply?.body || '');
  const en = language === 'en';
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await apply({ reply });
  }
  return <div className="zf-review-moderation-card">
    <p className="zf-review-service">{reviewStatus(review.status, language)}</p>
    <ProjectReviewCard review={review} language={language} />
    <div className="zf-feedback-buttons">
      {review.status !== 'published' && <button type="button" className="zf-button zf-button--primary" disabled={busy} onClick={() => void apply({ status: 'published' })}>{en ? 'Publish review' : 'نشر التقييم'}</button>}
      {review.status !== 'hidden' && <button type="button" className="zf-button" disabled={busy} onClick={() => void apply({ status: 'hidden' })}>{en ? 'Hide review' : 'إخفاء التقييم'}</button>}
    </div>
    {review.status === 'published' && <form className="zf-feedback-form" onSubmit={save}>
      <label>{en ? 'Official reply' : 'الرد الرسمي'}<textarea maxLength={1200} rows={3} dir="auto" value={reply} onChange={event => setReply(event.target.value)} disabled={busy} /></label>
      <div className="zf-feedback-buttons">
        <button className="zf-button zf-button--primary" disabled={busy || !reply.trim() || reply.trim() === review.reply?.body}>{en ? 'Save reply' : 'حفظ الرد'}</button>
        {review.reply && <button type="button" className="zf-button" disabled={busy} onClick={async () => { if (await apply({ reply: '' })) setReply(''); }}>{en ? 'Remove reply' : 'حذف الرد'}</button>}
      </div>
    </form>}
  </div>;
}

export function ProjectReviewModeration({ language }: { language: FeedbackLanguage }) {
  const [filter, setFilter] = useState('pending');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ReviewList<ProjectReview> | null>(null);
  const [error, setError] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const working = useRef(false);
  const en = language === 'en';

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    const query = new URLSearchParams({ status: filter, limit: String(pageSize), offset: String(page * pageSize) });
    feedbackApi<ReviewList<ProjectReview>>(`/api/admin/project-reviews?${query}`, language, { signal: controller.signal })
      .then(result => { setData(result); setAccessDenied(false); }).catch(error => {
        if (controller.signal.aborted) return;
        setAccessDenied(error instanceof FeedbackError && [401, 403, 428].includes(error.status));
        setError(feedbackErrorText(error, language));
      });
    return () => controller.abort();
  }, [filter, language, page, attempt]);

  async function moderate(projectId: string, body: { status: ReviewStatus } | { reply: string }) {
    if (working.current) return false;
    setBusy(true);
    working.current = true;
    setError('');
    setNotice('');
    try {
      const result = await feedbackApi<{ review: ProjectReview }>(`/api/admin/project-reviews/${encodeURIComponent(projectId)}`, language, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      setNotice(en ? 'Review updated.' : 'تم تحديث التقييم.');
      setData(current => current && (filter && result.review.status !== filter
        ? { total: current.total - 1, reviews: current.reviews.filter(item => item.projectId !== projectId) }
        : { ...current, reviews: current.reviews.map(item => item.projectId === projectId ? result.review : item) }));
      return true;
    } catch (error) {
      if (error instanceof FeedbackError && [401, 403, 428].includes(error.status)) { setAccessDenied(true); setData(null); }
      setError(feedbackErrorText(error, language));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  return <section className="zf-feedback-box" aria-busy={busy}>
    {error && <p className="zf-feedback-error" role="alert">{error}</p>}
    {accessDenied && <a href="/team" className="zf-button zf-button--primary">{en ? 'Open team sign-in' : 'دخول مساحة الفريق'}</a>}
    {!data && !error && <p role="status">{en ? 'Loading reviews…' : 'جارٍ تحميل التقييمات…'}</p>}
    {!data && error && !accessDenied && <button className="zf-button" onClick={() => setAttempt(value => value + 1)}>{en ? 'Try again' : 'حاول مجدداً'}</button>}
    {data && <>
      <div className="zf-feedback-filter"><label>{en ? 'Review status' : 'حالة التقييم'}<select value={filter} disabled={busy} onChange={event => { setFilter(event.target.value); setPage(0); setNotice(''); }}>
        <option value="pending">{reviewStatus('pending', language)}</option>
        <option value="published">{reviewStatus('published', language)}</option>
        <option value="hidden">{reviewStatus('hidden', language)}</option>
        <option value="">{en ? 'All' : 'الكل'}</option>
      </select></label></div>
      <p role="status">{busy ? (en ? 'Saving…' : 'جارٍ الحفظ…') : notice}</p>
      {!data.reviews.length && <p>{en ? 'No reviews with this status.' : 'لا توجد تقييمات بهذه الحالة.'}</p>}
      <div className="zf-review-grid">{data.reviews.map(review => <ModerationCard key={review.id} review={review} language={language} apply={body => moderate(review.projectId, body)} busy={busy} />)}</div>
      <ReviewPagination page={page} total={data.total} change={setPage} language={language} />
    </>}
  </section>;
}
