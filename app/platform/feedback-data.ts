export type FeedbackLanguage = 'ar' | 'en';
export type ReviewStatus = 'pending' | 'published' | 'hidden';
export type PublishedReview = {
  id: string;
  rating: number;
  body: string;
  service: string;
  submittedAt: string;
  reply?: { body: string; createdAt: string };
};
export type ProjectReview = PublishedReview & { projectId: string; status: ReviewStatus };
export type ReviewList<Review = PublishedReview> = { reviews: Review[]; total: number };

export class FeedbackError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function feedbackApi<Result>(path: string, language: FeedbackLanguage, options: RequestInit = {}) {
  const fallback = language === 'en' ? 'Something went wrong. Please try again.' : 'تعذر إكمال العملية. حاول مجدداً.';
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const messages = typeof data?.error === 'string' ? data.error.split(' / ', 2) : [];
    throw new FeedbackError(response.status, messages[language === 'en' ? 1 : 0] || fallback);
  }
  return data as Result;
}

export function feedbackErrorText(error: unknown, language: FeedbackLanguage) {
  return error instanceof FeedbackError ? error.message : language === 'en' ? 'Connection interrupted. Please try again.' : 'انقطع الاتصال. حاول مجدداً.';
}

export function reviewStatus(status: ReviewStatus, language: FeedbackLanguage) {
  return ({ pending: ['بانتظار المراجعة', 'Awaiting moderation'], published: ['منشور', 'Published'], hidden: ['مخفي', 'Hidden'] })[status][language === 'en' ? 1 : 0];
}
