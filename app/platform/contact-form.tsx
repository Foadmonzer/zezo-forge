'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ensurePlatformReferral } from './browser-referral';
import { feedbackApi, FeedbackError, feedbackErrorText, type FeedbackLanguage } from './feedback-data';
import './feedback.css';

const draftKey = 'zezo-contact-draft';

export function ContactForm({ language }: { language: FeedbackLanguage }) {
  const en = language === 'en';
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signIn, setSignIn] = useState(false);
  const inProgress = useRef(false);
  const draft = useRef({ message: '', key: '' });

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (saved && typeof saved.message === 'string' && saved.message.length <= 2000 && /^[0-9a-z-]{32,64}$/.test(saved.key)) {
        draft.current = saved;
        setMessage(saved.message);
      }
    } catch { /* The form also works without storage. */ }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inProgress.current || requestId) return;
    const form = new FormData(event.currentTarget);
    const text = message.trim();
    if (text.length < 10) {
      setError(en ? 'Enter at least 10 characters.' : 'اكتب 10 أحرف على الأقل.');
      return;
    }
    inProgress.current = true;
    setBusy(true);
    setError('');
    setSignIn(false);
    if (!draft.current.key || draft.current.message.trim() !== text) draft.current = { message: text, key: crypto.randomUUID() };
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft.current)); } catch { /* Retry in this tab remains possible. */ }
    // The account's established attribution controls the enquiry. Capture incoming referrals separately for future registration.
    void ensurePlatformReferral().catch(() => {});
    try {
      const result = await feedbackApi<{ ok: boolean; id: string }>('/api/contact', language, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': draft.current.key },
        body: JSON.stringify({ message: text, website: form.get('website') || '' })
      });
      if (!result.ok || !/^chat_[a-f0-9]{40}$/.test(result.id)) throw new Error('Missing enquiry receipt');
      setRequestId(result.id);
      setMessage('');
      draft.current = { message: '', key: '' };
      try { sessionStorage.removeItem(draftKey); } catch { /* Already submitted. */ }
    } catch (error) {
      setSignIn(error instanceof FeedbackError && error.status === 401);
      setError(feedbackErrorText(error, language));
    } finally {
      inProgress.current = false;
      setBusy(false);
    }
  }

  const accountHref = `/account?${new URLSearchParams({ next: en ? '/contact?lang=en' : '/contact', ...(en ? { lang: 'en' } : {}) })}`;
  const threadHref = `/account/settings?${new URLSearchParams({ tab: 'messages', conversation: requestId, ...(en ? { lang: 'en' } : {}) })}`;
  return <section className="zf-feedback-box" aria-labelledby="contact-enquiry-heading">
    <h2 id="contact-enquiry-heading">{en ? 'Send an enquiry' : 'أرسل استفسارًا'}</h2>
    {requestId ? <div className="zf-feedback-success">
      <p role="status">{en ? 'We’ve received your enquiry. Check Messages in your account for replies.' : 'وصلنا استفسارك. تابع قسم الرسائل في حسابك للاطّلاع على الردود.'}</p>
      <a className="zf-button zf-button--primary" href={threadHref}>{en ? 'Open conversation' : 'افتح المحادثة'}</a>
      <button type="button" className="zf-button" onClick={() => setRequestId('')}>{en ? 'Send another enquiry' : 'أرسل استفسارًا آخر'}</button>
    </div> : <form className="zf-feedback-form" onSubmit={submit} aria-busy={busy}>
      <p>{en ? 'Sign in with your customer account to send an enquiry and read replies.' : 'سجّل الدخول إلى حساب العميل لإرسال استفسارك ومتابعة الردود.'}</p>
      <label>{en ? 'Your message' : 'رسالتك'}<textarea rows={6} dir="auto" required minLength={10} maxLength={2000} value={message}
        onChange={event => setMessage(event.target.value)} disabled={busy} /></label>
      <div className="zf-contact-trap" aria-hidden="true"><label>Website<input type="text" name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <p>{en ? 'Please leave out passwords and financial information.' : 'يرجى عدم إدراج كلمات المرور أو المعلومات المالية.'}</p>
      {error && <p role="alert" className="zf-feedback-error">{error}</p>}
      <div className="zf-feedback-buttons">
        {signIn ? <a className="zf-button zf-button--primary" href={accountHref}>{en ? 'Sign in or create an account' : 'سجّل الدخول أو أنشئ حسابًا'}</a>
          : <button type="submit" className="zf-button zf-button--primary" disabled={busy}>{busy ? (en ? 'Sending…' : 'جارٍ الإرسال…') : (en ? 'Send enquiry' : 'إرسال الاستفسار')}</button>}
      </div>
    </form>}
  </section>;
}

export function ContactChannels({ language }: { language: FeedbackLanguage }) {
  const [whatsapp, setWhatsapp] = useState('');
  const en = language === 'en';
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/public', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const config = await response.json();
      if (!config.stagingMode && /^https:\/\/wa\.me\/[1-9]\d{7,14}$/.test(config.customerSupportWhatsappUrl || '')) {
        setWhatsapp(config.customerSupportWhatsappUrl);
      }
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  return <section className="zf-feedback-box" aria-labelledby="contact-channels-heading">
    <h2 id="contact-channels-heading">{en ? 'Official channels' : 'قنوات ZEZO الرسمية'}</h2>
    <div className="zf-feedback-buttons">
      {whatsapp && <a className="zf-button" href={whatsapp} target="_blank" rel="noopener noreferrer">{en ? 'Customer support on WhatsApp' : 'خدمة العملاء عبر واتساب'}</a>}
      <a className="zf-button" href="https://www.instagram.com/zezo_prime_ai/" target="_blank" rel="noopener noreferrer">{en ? 'ZEZO on Instagram' : 'ZEZO على إنستغرام'}</a>
    </div>
  </section>;
}
