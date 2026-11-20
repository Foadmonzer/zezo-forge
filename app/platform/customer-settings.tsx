
'use client';

import { useRef, useState, type FormEvent } from 'react';
import {
  errorLabel, localized, notifyAccountChanged, pageHref, phoneNumber, phoneValid, postJson,
  type Language, type Profile,
} from './customer-data';
import { clearDraft, readDraft } from './customer-drafts';

export function CustomerSettings({ profile, userId, language, reload }: { profile: Profile; userId: string; language: Language; reload: () => Promise<void> }) {
  const [student, setStudent] = useState(profile.student);
  const [pending, setPending] = useState('');
  const [feedback, setFeedback] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const busy = useRef(false);
  const t = (ar: string, en: string) => localized(language, ar, en);

  async function save(action: 'profile' | 'password' | 'logout', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy.current) return;
    const element = event?.currentTarget;
    const form = element ? new FormData(element) : null;
    const value = (key: string) => String(form?.get(key) || '');
    const invalid = (text: string) => setFeedback({ key: action, ok: false, text });
    if (action === 'profile' && value('phone').trim() && !phoneValid(value('phone'))) {
      return invalid(t('أدخل رقم واتساب دولياً صالحاً.', 'Enter a valid international WhatsApp number.'));
    }
    if (action === 'password' && value('newPassword') !== value('confirmation')) {
      return invalid(t('كلمتا المرور غير متطابقتين.', 'The two passwords do not match.'));
    }
    busy.current = true;
    setPending(action);
    setFeedback(null);
    try {
      if (action === 'profile') {
        await postJson('/api/profile', { email: profile.email, name: value('name'), phone: phoneNumber(value('phone')), student, university: value('university') }, 'PATCH');
        await reload();
      } else if (action === 'password') {
        await postJson('/api/auth/password', { currentPassword: value('currentPassword'), newPassword: value('newPassword') });
        element?.reset();
      } else {
        await postJson('/api/auth/logout', {});
        const draft = readDraft(userId);
        if (draft?.owner === userId) clearDraft(draft.key);
        notifyAccountChanged();
        location.replace(pageHref('/account', language));
      }
      setFeedback({ key: action, ok: true, text: t('تم حفظ التغييرات.', 'Changes saved.') });
    } catch (error) { invalid(errorLabel(error, language)); }
    finally { busy.current = false; setPending(''); }
  }
  const status = (part: string) => feedback?.key === part && <p role={feedback.ok ? 'status' : 'alert'} className={feedback.ok ? 'zc-success' : 'zc-error'}>{feedback.text}</p>;
  return <div className="zc-stack">
    <form className="zc-panel zc-form" onSubmit={event => void save('profile', event)} aria-busy={pending === 'profile'}>
      <h2>{t('الملف الشخصي', 'Profile')}</h2>
      <label>{t('الاسم الكامل', 'Full name')}<input name="name" autoComplete="name" defaultValue={profile.name} minLength={2} maxLength={100} dir="auto" required /></label>
      <label>{t('بريد تسجيل الدخول', 'Sign-in email')}<input type="email" value={profile.email} readOnly dir="ltr" /></label>
      <p>{profile.emailVerified ? t('تم تأكيد البريد.', 'Email verified.') : t('لم يتم تأكيد البريد.', 'Email has not been verified.')}</p>
      <label>{t('رقم واتساب الدولي', 'International WhatsApp number')}<input type="tel" name="phone" autoComplete="tel" maxLength={25} defaultValue={profile.phone} dir="ltr" /></label>
      <label className="zc-check"><input type="checkbox" checked={student} onChange={event => setStudent(event.target.checked)} />{t('أنا طالب', 'I am a student')}</label>
      {student && <label>{t('الجامعة', 'University')}<input name="university" maxLength={120} dir="auto" defaultValue={profile.university} /></label>}
      <button className="zc-button" disabled={!!pending}>{pending === 'profile' ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ الملف الشخصي', 'Save profile')}</button>
      {status('profile')}
    </form>
    <form className="zc-panel zc-form" onSubmit={event => void save('password', event)} aria-busy={pending === 'password'}>
      <h2>{t('تغيير كلمة المرور', 'Change password')}</h2>
      <label>{t('كلمة المرور الحالية', 'Current password')}<input type="password" name="currentPassword" autoComplete="current-password" dir="ltr" required /></label>
      <label>{t('كلمة المرور الجديدة (12 خانة على الأقل)', 'New password (at least 12 characters)')}<input type="password" name="newPassword" autoComplete="new-password" dir="ltr" minLength={12} maxLength={200} required /></label>
      <label>{t('إعادة كتابة كلمة المرور الجديدة', 'Re-enter new password')}<input type="password" name="confirmation" autoComplete="new-password" dir="ltr" minLength={12} maxLength={200} required /></label>
      <button className="zc-button" disabled={!!pending}>{pending === 'password' ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ كلمة المرور', 'Save password')}</button>
      {status('password')}
    </form>
    <section className="zc-panel">
      <h2>{t('الجلسة', 'Session')}</h2>
      <button className="zc-button zc-secondary" type="button" disabled={!!pending} onClick={() => void save('logout')}>{pending === 'logout' ? t('جارٍ تسجيل الخروج…', 'Signing out…') : t('تسجيل الخروج من هذا الجهاز', 'Sign out on this device')}</button>
      {status('logout')}
    </section>
  </div>;
}
