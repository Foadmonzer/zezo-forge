
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ensurePlatformReferral } from './browser-referral';
import {
  accountHref, customerApi, errorLabel, localized, notifyAccountChanged, pageHref, postJson, safeReturnPath,
  type Customer, type Language,
} from './customer-data';
import { readDraft } from './customer-drafts';

type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'verify';
type AccessResult = { user?: Customer; verificationRequired?: boolean; message?: string };
const returnKey = 'zezo-account-return-v1';

function storedReturnPath() {
  try {
    const context = JSON.parse(localStorage.getItem(returnKey) || 'null') as { path: string; expires: number } | null;
    return context && context.expires > Date.now() ? safeReturnPath(context.path) : '';
  } catch { return ''; }
}

function rememberReturnPath(path: string) {
  try {
    if (path) localStorage.setItem(returnKey, JSON.stringify({ path, expires: Date.now() + 24 * 60 * 60 * 1000 }));
    else localStorage.removeItem(returnKey);
  } catch { /* A same-tab return is also available in the URL. */ }
}

export function CustomerAccess({ language, next, suggestedMode }: { language: Language; next: string; suggestedMode: string }) {
  const initialMode = suggestedMode === 'register' || suggestedMode === 'forgot' ? suggestedMode : 'login';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [user, setUser] = useState<Customer | null>(null);
  const [token, setToken] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const busy = useRef(false);
  const t = (ar: string, en: string) => localized(language, ar, en);

  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    const verify = url.searchParams.get('verifyEmail') || hash.get('verifyEmail');
    const reset = url.searchParams.get('resetPassword') || hash.get('resetPassword');
    if (verify || reset) {
      setMode(verify ? 'verify' : 'reset');
      const linkToken = verify || reset || '';
      if (/^[a-zA-Z0-9_-]{43}$/.test(linkToken)) setToken(linkToken);
      url.searchParams.delete('verifyEmail');
      url.searchParams.delete('resetPassword');
      hash.delete('verifyEmail');
      hash.delete('resetPassword');
      history.replaceState(history.state, '', url.pathname + url.search + (hash.size ? '#' + hash.toString() : ''));
    }
    if (next) rememberReturnPath(next);
    void customerApi<{ user?: Customer }>('/api/auth/session', { signal: controller.signal })
      .then(session => { if (!controller.signal.aborted) setUser(session.user || null); })
      .catch(() => undefined).finally(() => { if (!controller.signal.aborted) setInitializing(false); });
    return () => controller.abort();
  }, [next]);

  function continueAfterAuth(user?: Customer) {
    notifyAccountChanged();
    const target = next || storedReturnPath() || (readDraft(user?.id || '') ? pageHref('/request', language) : pageHref('/account/overview', language));
    rememberReturnPath('');
    location.assign(target);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');
    if ((mode === 'register' || mode === 'reset') && password !== confirmPassword) {
      return setFeedback({ kind: 'error', text: t('كلمتا المرور غير متطابقتين.', 'The two passwords do not match.') });
    }
    if ((mode === 'verify' || mode === 'reset') && !token) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    try {
      if (mode === 'login') {
        const result = await postJson<AccessResult>('/api/auth/login', { username: email, password, accountType: 'client' });
        if (result.user?.role !== 'client') throw new Error('Client session not confirmed');
        continueAfterAuth(result.user);
      } else if (mode === 'register') {
        await ensurePlatformReferral();
        const result = await postJson<AccessResult>('/api/client/register', { email, name: String(form.get('name') || '').trim(), password, confirmPassword, lang: language });
        if (result.verificationRequired) setFeedback({ kind: 'success', text: t('تحقق من صندوق بريدك وافتح رابط التأكيد لإكمال التسجيل.', 'Check your inbox and open the confirmation link to finish signing up.') });
        else if (result.user?.role === 'client') continueAfterAuth(result.user);
        else throw new Error('Client registration not confirmed');
      } else if (mode === 'forgot') {
        const result = await postJson<AccessResult>('/api/auth/forgot-password', { email, lang: language });
        const segments = result.message?.split(' / ');
        setFeedback({ kind: 'success', text: (language === 'en' ? segments?.at(-1) : segments?.[0]) || t('إذا ارتبط البريد بحساب نشط ونجح الإرسال، ستصلك تعليمات الاستعادة.', 'If the email belongs to an active account and delivery succeeds, you will receive recovery instructions.') });
      } else if (mode === 'reset') {
        const result = await postJson<AccessResult>('/api/auth/reset-password', { token, password });
        notifyAccountChanged();
        setToken('');
        setUser(null);
        setMode('login');
        if (result.user && result.user.role !== 'client') location.assign(pageHref('/team', language));
        else setFeedback({ kind: 'success', text: t('تم تعيين كلمة المرور. سجّل الدخول بكلمتك الجديدة.', 'Your password was reset. Sign in with the new password.') });
      } else {
        const result = await postJson<AccessResult>('/api/auth/verify-email', { token });
        if (result.user?.role !== 'client') throw new Error('Verified client session not confirmed');
        continueAfterAuth(result.user);
      }
    } catch (error) { setFeedback({ kind: 'error', text: errorLabel(error, language) }); }
    finally { busy.current = false; setPending(false); }
  }

  async function signOut() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    try {
      await postJson('/api/auth/logout', {});
      notifyAccountChanged();
      setUser(null);
    } catch (error) { setFeedback({ kind: 'error', text: errorLabel(error, language) }); }
    finally { busy.current = false; setPending(false); }
  }

  const titles = {
    login: t('تسجيل دخول العميل', 'Customer sign-in'), register: t('إنشاء حساب عميل', 'Create a customer account'),
    forgot: t('استعادة كلمة المرور', 'Recover your password'), reset: t('تعيين كلمة مرور جديدة', 'Set a new password'),
    verify: t('تأكيد البريد الإلكتروني', 'Verify your email'),
  };
  const alternate = (newMode: Mode) => () => { setMode(newMode); setFeedback(null); };
  const tokenMissing = (mode === 'reset' || mode === 'verify') && !token;
  return (
    <section className="zc zc-access">
      <header className="zc-heading"><h1>{t('حسابي', 'My account')}</h1><p>{t('تابع مشاريعك وافتح محادثاتك مع فريق ZEZO.', 'Track your projects and open your conversations with the ZEZO team.')}</p></header>
      {initializing ? <div className="zc-panel" role="status">{t('جارٍ التحقق من الجلسة…', 'Checking your session…')}</div>
        : user && (mode === 'login' || mode === 'register' || mode === 'forgot') ? <div className="zc-panel">
          <h2 dir="auto">{user.name}</h2>
          <p>{user.role === 'client' ? t('أنت مسجّل الدخول إلى حساب العميل.', 'You are signed in to your customer account.') : t('أنت مسجّل الدخول إلى مساحة الفريق.', 'You are signed in to the team workspace.')}</p>
          <div className="zc-actions">
            <a className="zc-button" href={user.role === 'client' ? next || pageHref('/account/overview', language) : pageHref('/team', language)}>{user.role === 'client' ? t('متابعة', 'Continue') : t('مساحة الفريق', 'Team workspace')}</a>
            <button type="button" className="zc-button zc-secondary" disabled={pending} onClick={() => void signOut()}>{pending ? t('جارٍ تسجيل الخروج…', 'Signing out…') : t('تسجيل الخروج', 'Sign out')}</button>
          </div>
          {feedback && <p role="alert" className="zc-error">{feedback.text}</p>}
        </div> : <div className="zc-panel">
          <h2>{titles[mode]}</h2>
          <form className="zc-form" key={mode} onSubmit={submit} aria-busy={pending}>
            {mode === 'register' && <label>{t('الاسم الكامل', 'Full name')}<input name="name" autoComplete="name" required minLength={2} maxLength={100} dir="auto" /></label>}
            {(mode === 'login' || mode === 'register' || mode === 'forgot') && <label>{t('البريد الإلكتروني', 'Email address')}<input name="email" type="email" autoComplete="email" required maxLength={254} dir="ltr" /></label>}
            {!tokenMissing && (mode === 'login' || mode === 'register' || mode === 'reset') && <label>{mode === 'reset' ? t('كلمة المرور الجديدة (12 خانة على الأقل)', 'New password (at least 12 characters)') : mode === 'register' ? t('كلمة المرور (12 خانة على الأقل)', 'Password (at least 12 characters)') : t('كلمة المرور', 'Password')}<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? undefined : 12} maxLength={200} required dir="ltr" /></label>}
            {!tokenMissing && (mode === 'register' || mode === 'reset') && <label>{t('تأكيد كلمة المرور', 'Confirm password')}<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={200} required dir="ltr" /></label>}
            {mode === 'verify' && token && <p>{t('أكّد بريدك لمتابعة استخدام حساب العميل.', 'Verify your email to continue to your customer account.')}</p>}
            {tokenMissing && <p role="alert" className="zc-error">{t('هذا الرابط غير صالح. اطلب رابطاً جديداً.', 'This link is invalid. Request a new link.')}</p>}
            {feedback && <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={feedback.kind === 'error' ? 'zc-error' : 'zc-success'}>{feedback.text}</p>}
            {!tokenMissing && <button className="zc-button" disabled={pending || (mode === 'register' && feedback?.kind === 'success')}>{pending ? t('جارٍ التنفيذ…', 'Working…') : mode === 'forgot' ? t('طلب رابط الاستعادة', 'Request a recovery link') : titles[mode]}</button>}
          </form>
          <nav className="zc-access-links" aria-label={t('خيارات الدخول', 'Account access options')}>
            {mode !== 'login' && <button type="button" disabled={pending} onClick={alternate('login')}>{t('تسجيل الدخول', 'Sign in')}</button>}
            {mode !== 'register' && <button type="button" disabled={pending} onClick={alternate('register')}>{t('إنشاء حساب', 'Create an account')}</button>}
            {mode !== 'forgot' && mode !== 'verify' && <button type="button" disabled={pending} onClick={alternate('forgot')}>{t('نسيت كلمة المرور', 'Forgot password')}</button>}
            <a href={pageHref('/team', language)}>{t('دخول الفريق', 'Team sign-in')}</a>
          </nav>
        </div>}
      <noscript><p><a href={accountHref(language, next)}>{t('فعّل JavaScript للدخول إلى حسابك.', 'Enable JavaScript to sign in.')}</a></p></noscript>
    </section>
  );
}
