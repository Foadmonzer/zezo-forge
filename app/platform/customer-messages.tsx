
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  customerApi, CustomerApiError, errorLabel, fileAccept, fileValid, localized, moneyLabel, newKey, orderHref,
  safeId, statusTitle, type Conversation, type Language,
} from './customer-data';

const pageSize = 30;
const timeFormatters = {
  ar: new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }),
  en: new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }),
};

function nearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

type ChatDraft = { text: string; key: string; attachmentName?: string };

function rememberDraft(storageKey: string, draft: ChatDraft) {
  try {
    if (draft.text || draft.attachmentName) sessionStorage.setItem(storageKey, JSON.stringify(draft));
    else sessionStorage.removeItem(storageKey);
  } catch { /* The current draft remains usable without storage. */ }
}

export function conversationTitle(conversation: Conversation, language: Language) {
  return conversation.templateName || localized(language, 'محادثة مع ZEZO', 'Conversation with ZEZO');
}

export function CustomerMessages({ language, conversationId, viewerId, leadId, onUnauthorized }: {
  language: Language; conversationId: string; viewerId: string; leadId?: string | null; onUnauthorized: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [readError, setReadError] = useState('');
  const [sendError, setSendError] = useState('');
  const [pending, setPending] = useState('');
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ChatDraft>({ text: '', key: '' });
  const [attachment, setAttachment] = useState<File | null>(null);
  const [offline, setOffline] = useState(false);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [unseen, setUnseen] = useState(0);
  const [sent, setSent] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const readRequest = useRef<AbortController | null>(null);
  const sendRequest = useRef<AbortController | null>(null);
  const lastThread = useRef<Conversation | null>(null);
  const scroll = useRef<'latest' | { top: number; height: number } | null>(null);
  const t = (ar: string, en: string) => localized(language, ar, en);
  const storageKey = `zezo-chat-draft:${viewerId}:${conversationId}`;
  const endpoint = `/api/conversations/${encodeURIComponent(conversationId)}`;

  const updateConversation = useCallback((next: Conversation, ownMessage = false) => {
    const previous = lastThread.current;
    const current = list.current;
    const added = (next.messages?.length || 0) - (previous?.messages?.length || 0);
    if (ownMessage || !previous || (current && nearBottom(current))) {
      scroll.current = 'latest';
      setUnseen(0);
    } else if (added > 0) {
      setVisibleCount(count => Math.max(count, Math.min(count, previous.messages?.length || 0) + added));
      setUnseen(count => count + added);
    }
    lastThread.current = next;
    setConversation(next);
  }, []);

  const read = useCallback(async () => {
    if (readRequest.current || sendRequest.current || !navigator.onLine) return;
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const result = await customerApi<{ conversation: Conversation }>(endpoint, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      });
      if (controller.signal.aborted) return;
      if (result.conversation?.id !== conversationId) throw new Error('Conversation not confirmed');
      updateConversation(result.conversation);
      setReadError('');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof CustomerApiError) {
        if (error.status === 401 || error.status === 428) onUnauthorized();
        if ([401, 403, 404, 428].includes(error.status)) {
          lastThread.current = null;
          setConversation(null);
        }
      }
      setReadError(errorLabel(error, language));
    } finally {
      if (readRequest.current === controller) readRequest.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [conversationId, endpoint, language, onUnauthorized, updateConversation]);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as ChatDraft | null;
      if (typeof saved?.text === 'string') setDraft({
        text: saved.text.slice(0, 2000), key: typeof saved.key === 'string' && /^[a-f0-9]{64}$/.test(saved.key) ? saved.key : '',
        attachmentName: typeof saved.attachmentName === 'string' ? saved.attachmentName.slice(0, 200) : undefined,
      });
    } catch { /* An unavailable browser draft should not interrupt the conversation. */ }
  }, [storageKey]);

  useEffect(() => {
    function sync() {
      setOffline(!navigator.onLine);
      if (!navigator.onLine) setLoading(false);
      else if (!document.hidden) void read();
    }
    sync();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 12000);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      document.removeEventListener('visibilitychange', sync);
      readRequest.current?.abort();
      readRequest.current = null;
    };
  }, [read]);

  useEffect(() => () => { sendRequest.current?.abort(); }, []);

  useLayoutEffect(() => {
    if (!list.current || !scroll.current) return;
    const element = list.current;
    const target = scroll.current;
    element.scrollTop = target === 'latest' ? element.scrollHeight : target.top + element.scrollHeight - target.height;
    scroll.current = null;
  }, [conversation, visibleCount]);

  function saveDraft(change: ChatDraft) {
    rememberDraft(storageKey, change);
    setDraft(change);
  }

  function showOlder() {
    if (list.current) scroll.current = { top: list.current.scrollTop, height: list.current.scrollHeight };
    setVisibleCount(count => count + pageSize);
  }

  async function mutate(action: 'messages' | 'accept-quote', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (sendRequest.current || offline) return;
    if (action === 'messages' && draft.attachmentName && !attachment) {
      return setSendError(t('أعد تحديد المرفق أو أزله قبل الإرسال.', 'Select the attachment again or remove it before sending.'));
    }
    if (action === 'messages' && !draft.text.trim() && !attachment) {
      messageInput.current?.focus();
      return setSendError(t('اكتب رسالة أو أرفق ملفاً.', 'Enter a message or attach a file.'));
    }
    const controller = new AbortController();
    sendRequest.current = controller;
    readRequest.current?.abort();
    setPending(action);
    setSendError('');
    setSent(false);
    try {
      const path = `${endpoint}/${action}`;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      if (action === 'messages') {
        const key = draft.key || newKey();
        saveDraft({ ...draft, key });
        const body = new FormData();
        body.set('message', draft.text);
        if (attachment) body.set('attachment', attachment);
        const result = await customerApi<{ conversation: Conversation }>(path, {
          method: 'POST', headers: { 'Idempotency-Key': key }, body, signal,
        });
        if (controller.signal.aborted) return;
        if (result.conversation?.id !== conversationId) throw new Error('Message not confirmed');
        updateConversation(result.conversation, true);
        saveDraft({ text: '', key: '' });
        setAttachment(null);
        if (fileInput.current) fileInput.current.value = '';
        setSent(true);
        if (window.matchMedia('(pointer: fine)').matches) messageInput.current?.focus();
      } else {
        const result = await customerApi<{ conversation?: Conversation }>(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
        });
        if (controller.signal.aborted) return;
        if (result.conversation) updateConversation(result.conversation);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof CustomerApiError && [401, 428].includes(error.status)) onUnauthorized();
      setSendError(errorLabel(error, language));
    } finally {
      sendRequest.current = null;
      if (!controller.signal.aborted) {
        setPending('');
        if (action === 'accept-quote') void read();
      }
    }
  }

  if (loading) return <section className="zc-panel" role="status">{t('جارٍ تحميل المحادثة…', 'Loading the conversation…')}</section>;
  if (!conversation) return <section className="zc-panel">
    <p role="alert" className="zc-error">{offline ? t('تحقق من اتصال الإنترنت لفتح المحادثة.', 'Reconnect to open the conversation.') : readError || t('المحادثة غير متوفرة.', 'Conversation unavailable.')}</p>
    <button className="zc-button zc-secondary" type="button" disabled={offline} onClick={() => { setLoading(true); void read(); }}>{t('إعادة المحاولة', 'Try again')}</button>
  </section>;

  const orderId = leadId || conversation.leadId;
  const messages = conversation.messages || [];
  return <section className="zc-panel zc-thread" aria-labelledby="zc-thread-title">
    <div className="zc-title-row">
      <div><h2 id="zc-thread-title">{conversationTitle(conversation, language)}</h2><p>{statusTitle(conversation.status, language)}</p></div>
      {!leadId && orderId && safeId(orderId) && <a href={orderHref(orderId, language)} className="zc-button zc-secondary">{t('تفاصيل الطلب', 'Order details')}</a>}
    </div>
    {messages.length > visibleCount && <button type="button" className="zc-inline zc-thread-older" onClick={showOlder}>{t('عرض الرسائل السابقة', 'Show earlier messages')}</button>}
    <div ref={list} className="zc-thread-messages" aria-label={t('سجل المحادثة', 'Conversation history')} role="log" tabIndex={0} onScroll={event => { if (nearBottom(event.currentTarget)) setUnseen(0); }}>
      {messages.slice(-visibleCount).map(message => (
        <article key={message.id} className="zc-message" data-sender={message.senderType === 'staff' ? 'staff' : 'customer'}>
          <div><strong dir="auto">{message.senderType === 'staff' ? message.senderName || t('فريق ZEZO', 'ZEZO team') : t('أنت', 'You')}</strong> <time dateTime={message.createdAt}>{Number.isFinite(Date.parse(message.createdAt)) ? timeFormatters[language].format(new Date(message.createdAt)) : '—'}</time></div>
          {message.text && <p dir="auto" className="zc-pre">{message.text}</p>}
          {(message.attachments || []).map(file => Number.isInteger(file.index) && <a className="zc-attachment" key={String(file.index)} href={'/api/conversations/' + conversation.id + '/files/' + file.index} dir="auto">{file.name}</a>)}
        </article>
      ))}
      {!messages.length && <p>{t('لا توجد رسائل في هذه المحادثة بعد.', 'There are no messages in this conversation yet.')}</p>}
    </div>
    {unseen > 0 && <button type="button" className="zc-inline zc-thread-older" onClick={() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; setUnseen(0); }}>{t(`انتقل إلى الرسائل الجديدة (${unseen})`, `Go to new messages (${unseen})`)}</button>}
    {conversation.quote && <section className="zc-quote">
      <h3>{t('عرض سعر المحادثة', 'Conversation quote')} <bdi>{moneyLabel(conversation.quote.amount, language)}</bdi></h3>
      {conversation.quote.scope && <p className="zc-pre" dir="auto">{conversation.quote.scope}</p>}
      {conversation.quote.included && <p dir="auto">{conversation.quote.included}</p>}
      {conversation.quote.exclusions && <p dir="auto">{t('غير مشمول', 'Excluded')}{' · '}{conversation.quote.exclusions}</p>}
      {conversation.quote.status === 'sent' ? <button type="button" className="zc-button" disabled={!!pending || offline} onClick={() => void mutate('accept-quote')}>{pending === 'accept-quote' ? t('جارٍ قبول العرض…', 'Accepting quote…') : t('قبول العرض', 'Accept quote')}</button>
        : <p>{statusTitle(conversation.quote.status, language)}</p>}
    </section>}
    {conversation.status === 'closed' ? <p>{t('هذه المحادثة مغلقة.', 'This conversation is closed.')}</p> : (
      <form className="zc-form zc-chat-composer" onSubmit={event => void mutate('messages', event)} aria-busy={pending === 'messages'}>
        <label>{t('رسالتك', 'Your message')}<textarea ref={messageInput} name="message" rows={2} maxLength={2000} dir="auto" value={draft.text} readOnly={!!pending} onChange={event => { saveDraft({ ...draft, text: event.target.value, key: '' }); setSent(false); }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} /></label>
        <div className="zc-chat-actions">
          <label>{t('مرفق PDF أو صورة (حتى 4 ميغابايت)', 'PDF or image attachment (up to 4 MB)')}<input ref={fileInput} name="attachment" type="file" accept={fileAccept} disabled={!!pending} onChange={event => {
            const next = event.currentTarget.files?.[0];
            if (!next) return;
            if (!fileValid(next)) {
              event.currentTarget.value = '';
              setSendError(t('اختر PDF أو صورة بحجم لا يتجاوز 4 ميغابايت.', 'Choose a PDF or image up to 4 MB.'));
              return;
            }
            setAttachment(next);
            setSendError('');
            setSent(false);
            saveDraft({ ...draft, attachmentName: next.name, key: '' });
          }} /></label>
          <button className="zc-button" type="submit" disabled={!!pending || offline}>{pending === 'messages' ? t('جارٍ الإرسال…', 'Sending…') : sendError ? t('أعد الإرسال', 'Retry sending') : t('إرسال رسالة', 'Send message')}</button>
        </div>
        {draft.attachmentName && <div className="zc-chat-file"><span dir="auto">{draft.attachmentName}{!attachment && t(' — أعد تحديد الملف', ' — select the file again')}</span><button type="button" className="zc-inline" disabled={!!pending} onClick={() => { if (fileInput.current) fileInput.current.value = ''; setAttachment(null); saveDraft({ ...draft, attachmentName: undefined, key: '' }); }}>{t('إزالة المرفق', 'Remove attachment')}</button></div>}
        {sent && <span role="status" className="zc-chat-status">{t('أُرسلت الرسالة.', 'Message sent.')}</span>}
      </form>
    )}
    {sendError && <p className="zc-error" role="alert">{sendError}</p>}
    {offline ? <p className="zc-callout" role="status">{t('لا يوجد اتصال. يمكنك إكمال كتابة رسالتك هنا.', 'You are offline. You can keep drafting your message here.')}</p>
      : readError && <p className="zc-callout" role="status">{t('تعذّر تحديث الرسائل. سنعيد التحقق قريباً.', 'Could not update messages. We will check again shortly.')} <button type="button" className="zc-inline" onClick={() => void read()}>{t('حدّث الآن', 'Refresh now')}</button></p>}
  </section>;
}
