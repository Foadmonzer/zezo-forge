
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ensurePlatformReferral } from './browser-referral';
import {
  accountHref, customerApi, CustomerApiError, errorLabel, fileAccept, fileValid, localized, orderHref, pageHref,
  phoneNumber, phoneValid, safeId, serviceTitle, services,
  type Conversation, type Customer, type Language, type TemplateOption,
} from './customer-data';
import { clearDraft, draftAttachment, newDraft, readDraft, saveDraft, type RequestDraft } from './customer-drafts';

type Options = Pick<RequestDraft, 'service' | 'category' | 'template' | 'action' | 'conversation'>;
type State = { user: Customer | null; draft: RequestDraft };
type Session = { authenticated: boolean; user?: Customer };

export function CustomerRequest({ language, templates, options }: { language: Language; templates: TemplateOption[]; options: Options }) {
  const [state, setState] = useState<State | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [issue, setIssue] = useState('');
  const [fatal, setFatal] = useState(false);
  const [pending, setPending] = useState(false);
  const [filePending, setFilePending] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const busy = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const t = (ar: string, en: string) => localized(language, ar, en);
  const fileMessage = t('اختر ملف PDF أو صورة بحجم لا يتجاوز 4 ميغابايت.', 'Choose a PDF or image up to 4 MB.');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { user } = await customerApi<Session>('/api/auth/session', { signal: controller.signal });
        const owner = user?.role === 'client' ? user.id : '';
        const selected = templates.find(item => item.id === options.template);
        const service = services.find(item => item.id === options.service);
        const category = service?.categories.find(([id]) => id === options.category)?.[0] || '';
        const stored = readDraft(owner);
        const current = stored && (!options.template || stored.template === options.template)
          && (!service || stored.service === service.id)
          && (!category || stored.category === (selected?.category || category))
          && (!options.conversation || stored.conversation === options.conversation)
          && (!options.action || stored.action === options.action) ? stored : null;
        const draft = current || newDraft({
          service: selected?.service || service?.id || '',
          category: selected?.category || category, template: selected?.id || '',
          action: options.action === 'customize' ? 'customize' : 'order', owner,
        });
        if (owner) {
          draft.owner = owner;
          draft.phone ||= user?.phone || '';
          if (safeId(options.conversation)) {
            const response = await customerApi<{ conversation: Conversation }>('/api/conversations/' + options.conversation, { signal: controller.signal });
            const conversation = response.conversation;
            const linked = templates.find(item => item.id === conversation.templateId);
            if (linked) {
              Object.assign(draft, { service: linked.service, category: linked.category, template: linked.id, conversation: conversation.id });
            }
          }
        }
        if (owner && current) saveDraft(draft);
        let file: File | null = null;
        if (draft.attachmentName) file = await draftAttachment('get', draft.key).catch(() => null);
        if (controller.signal.aborted) return;
        setAttachment(file);
        setState({ user: user || null, draft });
      } catch (error) {
        if (!controller.signal.aborted) { setFatal(true); setIssue(errorLabel(error, language)); }
      }
    })();
    return () => controller.abort();
  }, [language, options, sessionVersion, templates]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== 'zezo-session-context-changed' && event.key !== null) return;
      setState(null);
      setAttachment(null);
      setIssue('');
      setFatal(false);
      setSessionVersion(current => current + 1);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  function update(change: Partial<RequestDraft>) {
    if (!state) return;
    const draft = { ...state.draft, ...change };
    saveDraft(draft);
    setState({ ...state, draft });
  }

  function go(step: number) {
    setIssue('');
    update({ step });
    requestAnimationFrame(() => stepHeading.current?.focus());
  }

  async function chooseFile(file?: File) {
    if (!state || !file) return;
    if (!fileValid(file)) return setIssue(fileMessage);
    setIssue('');
    setFilePending(true);
    setAttachment(file);
    update({ attachmentName: file.name });
    try { await draftAttachment('put', state.draft.key, file); }
    catch {
      setIssue(t('سيُرفق الملف إذا أرسلت الآن. أعد اختياره بعد مغادرة الصفحة.', 'The file will be attached if you submit now. Select it again if you leave this page.'));
    } finally { setFilePending(false); }
  }

  function removeFile() {
    if (!state) return;
    void draftAttachment('delete', state.draft.key).catch(() => undefined);
    setAttachment(null);
    update({ attachmentName: '' });
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || busy.current) return;
    const { draft, user } = state;
    setIssue('');
    if (draft.step === 1 && (!phoneValid(draft.phone) || draft.details.trim().length < 12)) {
      return setIssue(t('أضف تفاصيل المشروع ورقم واتساب دولياً صالحاً.', 'Add your project details and a valid international WhatsApp number.'));
    }
    if (draft.step < 3) return go(draft.step + 1);
    if (!user || user.role !== 'client') {
      if (!saveDraft(draft)) return setIssue(t('فعّل التخزين في المتصفح لحفظ المسودة، أو سجّل الدخول ثم ابدأ الطلب.', 'Enable browser storage to keep this draft, or sign in before starting a request.'));
      location.assign(accountHref(language, pageHref('/request', language)));
      return;
    }
    if (!draft.consent || !phoneValid(draft.phone) || draft.details.trim().length < 12 || !draft.category || !draft.service) {
      return setIssue(t('تحقق من تفاصيل المشروع ورقم الهاتف والموافقة قبل الإرسال.', 'Check the project details, phone number and consent before sending.'));
    }
    if (draft.attachmentName && !attachment) return setIssue(t('أعد اختيار المرفق أو أزله قبل الإرسال.', 'Select the file again or remove it before sending.'));
    busy.current = true;
    setPending(true);
    try {
      const active = await customerApi<Session>('/api/auth/session');
      if (active.user?.id !== user.id || active.user.role !== 'client') {
        setState(current => current && { ...current, user: null });
        setIssue(t('تغيّرت جلستك. سجّل الدخول إلى الحساب نفسه لإرسال هذه المسودة.', 'Your session changed. Sign back in to the same account to submit this draft.'));
        return;
      }
      await ensurePlatformReferral();
      const form = new FormData();
      for (const [key, value] of Object.entries({
        service: draft.service, category: draft.category, details: draft.details.trim(), phone: phoneNumber(draft.phone),
        budget: draft.budget, templateId: draft.template, templateAction: draft.template ? draft.action : '',
        conversationId: draft.conversation, createConversation: 'true', consent: 'true', lang: language,
      })) if (value) form.set(key, value);
      if (attachment) form.set('attachment', attachment);
      const response = await customerApi<{ ok: boolean; id: string }>('/api/leads', {
        method: 'POST', headers: { 'Idempotency-Key': draft.key }, body: form,
      });
      if (!response.ok || !safeId(response.id)) throw new Error('Request not confirmed');
      clearDraft(draft.key);
      location.assign(orderHref(response.id, language));
    } catch (error) {
      if (error instanceof CustomerApiError && error.status === 401) {
        setState(current => current && { ...current, user: null });
        setIssue(t('انتهت جلستك. سجّل الدخول لإرسال المسودة المحفوظة.', 'Your session expired. Sign in to submit the saved draft.'));
      } else setIssue(errorLabel(error, language));
    } finally { busy.current = false; setPending(false); }
  }

  if (!state) return <div className="zc"><div className="zc-simple" role={fatal ? 'alert' : 'status'}>{issue || t('جارٍ فتح نموذج الطلب…', 'Opening the project form…')}{fatal && <button className="zc-button" onClick={() => location.reload()}>{t('إعادة المحاولة', 'Try again')}</button>}</div></div>;

  const { draft, user } = state;
  const step = Math.max(0, Math.min(3, draft.step));
  const sections = [t('الخدمة', 'Service'), t('تفاصيل المشروع', 'Project details'), t('المرفقات', 'Attachments'), t('المراجعة', 'Review')];
  const selected = templates.find(item => item.id === draft.template);
  const category = services.find(item => item.id === draft.service)?.categories;
  return (
    <section className="zc zc-request">
      <header className="zc-heading">
        <h1>{t('اطلب مشروعك', 'Request a project')}</h1>
        <p>{t('صف ما تريد تنفيذه. تابع طلبك وعروض الأسعار من حسابك.', 'Tell us what you want to build. Track the request and quotes from your account.')}</p>
      </header>
      <div className="zc-steps-layout">
        <aside aria-label={t('مراحل الطلب', 'Request steps')}>
          <ol className="zc-steps">
            {sections.map((section, index) => <li key={section} aria-current={index === step ? 'step' : undefined}><span>{index + 1}</span>{index < step ? <button type="button" disabled={pending || filePending} onClick={() => go(index)}>{section}</button> : section}</li>)}
          </ol>
          {selected && <p className="zc-selection">{t('القالب المختار', 'Selected template')}<strong>{selected.title[language]}</strong></p>}
        </aside>
        <form className="zc-panel zc-form" onSubmit={send} aria-busy={pending || filePending}>
          <h2 ref={stepHeading} tabIndex={-1}>{sections[step]}</h2>
          {step === 0 && <>
            <label>{t('الخدمة', 'Service')}<select required value={draft.service} disabled={!!draft.conversation} onChange={event => update({ service: event.target.value, category: '', template: '' })}>
              <option value="">{t('اختر الخدمة', 'Choose a service')}</option>
              {services.map(item => <option key={item.id} value={item.id}>{item[language]}</option>)}
            </select></label>
            <label>{t('نوع المشروع', 'Project type')}<select required value={draft.category} disabled={!!draft.conversation} onChange={event => update({ category: event.target.value, template: '' })}>
              <option value="">{t('اختر نوع المشروع', 'Choose a project type')}</option>
              {category?.map(([id, ar, en]) => <option key={id} value={id}>{t(ar, en)}</option>)}
            </select></label>
            <label>{t('قالب (اختياري)', 'Template (optional)')}<select value={draft.template} disabled={!!draft.conversation} onChange={event => update({ template: event.target.value })}>
              <option value="">{t('مشروع بدون قالب', 'Project without a template')}</option>
              {templates.filter(item => item.service === draft.service && item.category === draft.category).map(item => <option key={item.id} value={item.id}>{item.title[language]}</option>)}
            </select></label>
            {selected && <label>{t('كيف تريد استخدام القالب؟', 'How would you like to use the template?')}<select value={draft.action} onChange={event => update({ action: event.target.value })}>
              <option value="order">{t('طلب القالب', 'Order the template')}</option>
              <option value="customize">{t('تخصيص القالب', 'Customize the template')}</option>
            </select></label>}
          </>}
          {step === 1 && <>
            <label>{t('ما الذي تريد تنفيذه؟', 'What would you like to build?')}<textarea rows={6} required minLength={12} maxLength={3000} dir="auto" value={draft.details} onChange={event => update({ details: event.target.value })} /></label>
            <label>{t('رقم واتساب الدولي', 'International WhatsApp number')}<input required type="tel" autoComplete="tel" dir="ltr" placeholder="+971500000000" maxLength={25} value={draft.phone} onChange={event => update({ phone: event.target.value })} /></label>
            <label>{t('الميزانية المتوقعة (اختياري)', 'Estimated budget (optional)')}<input maxLength={80} value={draft.budget} onChange={event => update({ budget: event.target.value })} /></label>
          </>}
          {step === 2 && <>
            <label>{t('مرفق (اختياري)', 'Attachment (optional)')}<input type="file" accept={fileAccept} aria-describedby="zc-file-rules" onChange={event => void chooseFile(event.target.files?.[0])} /></label>
            <p id="zc-file-rules">{fileMessage}</p>
            {draft.attachmentName && <div className="zc-actions"><span dir="auto">{draft.attachmentName}</span><button className="zc-button zc-secondary" type="button" onClick={removeFile} disabled={filePending}>{t('إزالة', 'Remove')}</button></div>}
            {draft.attachmentName && !attachment && <p>{t('أعد اختيار الملف قبل الإرسال.', 'Select the file again before submitting.')}</p>}
          </>}
          {step === 3 && <>
            <dl className="zc-summary"><div><dt>{t('الخدمة', 'Service')}</dt><dd>{serviceTitle(draft.service, language)}</dd></div>
              {selected && <div><dt>{t('القالب', 'Template')}</dt><dd>{selected.title[language]}</dd></div>}
              <div><dt>{t('التفاصيل', 'Details')}</dt><dd dir="auto" className="zc-pre">{draft.details}</dd></div>
              <div><dt>{t('الهاتف', 'Phone')}</dt><dd dir="ltr">{draft.phone}</dd></div>
              {draft.budget && <div><dt>{t('الميزانية', 'Budget')}</dt><dd dir="auto">{draft.budget}</dd></div>}
              {draft.attachmentName && <div><dt>{t('المرفق', 'Attachment')}</dt><dd dir="auto">{draft.attachmentName}</dd></div>}
            </dl>
            <label className="zc-check"><input type="checkbox" required checked={draft.consent} onChange={event => update({ consent: event.target.checked })} /><span>{t('أوافق على استخدام تفاصيل الطلب للتواصل معي بخصوص هذا المشروع.', 'I agree that my request details may be used to contact me about this project.')}</span></label>
            {!user && <p>{t('سجّل الدخول أو أنشئ حساباً لمتابعة الطلب. ستبقى مسودتك على هذا الجهاز.', 'Sign in or create an account to continue. Your draft stays on this device.')}</p>}
            {user && user.role !== 'client' && <p>{t('أنت مسجّل بحساب فريق. استخدم حساب عميل لإرسال الطلب.', 'You are signed in as a team member. Use a client account to submit your request.')}</p>}
          </>}
          {issue && <p className="zc-error" role="alert">{issue}</p>}
          <div className="zc-actions">
            {step > 0 && <button type="button" className="zc-button zc-secondary" disabled={pending || filePending} onClick={() => go(step - 1)}>{t('رجوع', 'Back')}</button>}
            <button type="submit" className="zc-button" disabled={pending || filePending}>{pending ? t('جارٍ إرسال الطلب…', 'Submitting request…') : step < 3 ? t('متابعة', 'Continue') : !user || user.role !== 'client' ? t('الدخول لمتابعة الطلب', 'Sign in to continue') : t('إرسال الطلب', 'Submit request')}</button>
          </div>
        </form>
      </div>
    </section>
  );
}
