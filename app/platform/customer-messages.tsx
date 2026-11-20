
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  customerApi, CustomerApiError, dateLabel, errorLabel, fileAccept, fileValid, localized, moneyLabel, newKey, orderHref,
  postJson, safeId, statusTitle, type Conversation, type Language,
} from './customer-data';

export function conversationTitle(conversation: Conversation, language: Language) {
  return conversation.templateName || localized(language, 'محادثة مع ZEZO', 'Conversation with ZEZO');
}

export function CustomerMessages({ language, conversationId, leadId, onUnauthorized }: {
  language: Language; conversationId: string; leadId?: string | null; onUnauthorized: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [refresh, setRefresh] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const messageKey = useRef('');
  const t = (ar: string, en: string) => localized(language, ar, en);

  useEffect(() => {
    const controller = new AbortController();
    function read() {
      void customerApi<{ conversation: Conversation }>('/api/conversations/' + conversationId, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted && !busy.current) { setConversation(result.conversation); setError(''); } })
        .catch(error => {
          if (controller.signal.aborted) return;
          if (error instanceof CustomerApiError && error.status === 401) onUnauthorized();
          if (error instanceof CustomerApiError && (error.status === 403 || error.status === 404)) setConversation(null);
          setError(errorLabel(error, language));
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    read();
    const timer = setInterval(() => { if (!document.hidden && !busy.current) read(); }, 25000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [conversationId, language, onUnauthorized, refresh]);

  async function mutate(action: 'messages' | 'accept-quote', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy.current) return;
    if (action === 'messages' && !text.trim() && !attachment) {
      return setError(t('اكتب رسالة أو أرفق ملفاً.', 'Enter a message or attach a file.'));
    }
    if (attachment && !fileValid(attachment)) {
      return setError(t('اختر PDF أو صورة بحجم لا يتجاوز 4 ميغابايت.', 'Choose a PDF or image up to 4 MB.'));
    }
    busy.current = true;
    setPending(action);
    setError('');
    try {
      const path = '/api/conversations/' + conversationId + '/' + action;
      if (action === 'messages') {
        const form = new FormData();
        form.set('message', text.trim());
        if (attachment) form.set('attachment', attachment);
        messageKey.current ||= newKey();
        const result = await customerApi<{ conversation: Conversation }>(path, {
          method: 'POST', headers: { 'Idempotency-Key': messageKey.current }, body: form,
        });
        if (!result.conversation?.id) throw new Error('Message not confirmed');
        setConversation(result.conversation);
        setText('');
        setAttachment(null);
        if (fileInput.current) fileInput.current.value = '';
        messageKey.current = '';
      } else {
        const result = await postJson<{ conversation?: Conversation }>(path, {});
        if (result.conversation) setConversation(result.conversation);
        else setRefresh(current => current + 1);
      }
    } catch (error) {
      if (error instanceof CustomerApiError && error.status === 401) onUnauthorized();
      setError(errorLabel(error, language));
    } finally { busy.current = false; setPending(''); }
  }

  if (loading) return <section className="zc-panel" role="status">{t('جارٍ تحميل المحادثة…', 'Loading the conversation…')}</section>;
  if (!conversation) return <section className="zc-panel">
    <p role="alert" className="zc-error">{error || t('المحادثة غير متوفرة.', 'Conversation unavailable.')}</p>
    <button className="zc-button zc-secondary" onClick={() => { setLoading(true); setRefresh(current => current + 1); }}>{t('إعادة المحاولة', 'Try again')}</button>
  </section>;

  const orderId = leadId || conversation.leadId;
  return <section className="zc-panel zc-thread" aria-labelledby="zc-thread-title">
    <div className="zc-title-row">
      <div><h2 id="zc-thread-title">{conversationTitle(conversation, language)}</h2><p>{statusTitle(conversation.status, language)}</p></div>
      {!leadId && orderId && safeId(orderId) && <a href={orderHref(orderId, language)} className="zc-button zc-secondary">{t('تفاصيل الطلب', 'Order details')}</a>}
    </div>
    <div className="zc-thread-messages" aria-label={t('سجل المحادثة', 'Conversation history')} role="log" tabIndex={0}>
      {(conversation.messages || []).map(message => (
        <article key={message.id} className="zc-message" data-sender={message.senderType === 'staff' ? 'staff' : 'customer'}>
          <div><strong dir="auto">{message.senderName || (message.senderType === 'staff' ? t('فريق ZEZO', 'ZEZO team') : t('أنت', 'You'))}</strong> <time dateTime={message.createdAt}>{dateLabel(message.createdAt, language)}</time></div>
          {message.text && <p dir="auto" className="zc-pre">{message.text}</p>}
          {(message.attachments || []).map(file => Number.isInteger(file.index) && <a className="zc-attachment" key={String(file.index)} href={'/api/conversations/' + conversation.id + '/files/' + file.index} dir="auto">{file.name}</a>)}
        </article>
      ))}
      {!conversation.messages?.length && <p>{t('لا توجد رسائل في هذه المحادثة بعد.', 'There are no messages in this conversation yet.')}</p>}
    </div>
    {conversation.quote && <section className="zc-quote">
      <h3>{t('عرض سعر المحادثة', 'Conversation quote')} <bdi>{moneyLabel(conversation.quote.amount, language)}</bdi></h3>
      {conversation.quote.scope && <p className="zc-pre" dir="auto">{conversation.quote.scope}</p>}
      {conversation.quote.included && <p dir="auto">{conversation.quote.included}</p>}
      {conversation.quote.exclusions && <p dir="auto">{t('غير مشمول', 'Excluded')}{' · '}{conversation.quote.exclusions}</p>}
      {conversation.quote.status === 'sent' ? <button type="button" className="zc-button" disabled={!!pending} onClick={() => void mutate('accept-quote')}>{pending === 'accept-quote' ? t('جارٍ قبول العرض…', 'Accepting quote…') : t('قبول العرض', 'Accept quote')}</button>
        : <p>{statusTitle(conversation.quote.status, language)}</p>}
    </section>}
    {conversation.status === 'closed' ? <p>{t('هذه المحادثة مغلقة.', 'This conversation is closed.')}</p> : (
      <form className="zc-form" onSubmit={event => void mutate('messages', event)} aria-busy={pending === 'messages'}>
        <label>{t('رسالتك', 'Your message')}<textarea rows={3} maxLength={2000} dir="auto" value={text} disabled={!!pending} onChange={event => { setText(event.target.value); messageKey.current = ''; }} /></label>
        <label>{t('إرفاق ملف (اختياري، حتى 4 ميغابايت)', 'Attach a file (optional, up to 4 MB)')}<input ref={fileInput} type="file" accept={fileAccept} disabled={!!pending} onChange={event => { setAttachment(event.target.files?.[0] || null); messageKey.current = ''; }} /></label>
        <button className="zc-button" disabled={!!pending}>{pending === 'messages' ? t('جارٍ الإرسال…', 'Sending…') : t('إرسال رسالة', 'Send message')}</button>
      </form>
    )}
    {error && <p className="zc-error" role="alert">{error}</p>}
  </section>;
}
