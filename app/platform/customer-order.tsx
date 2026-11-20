
'use client';

import { useRef, useState, type FormEvent } from 'react';
import {
  CustomerApiError, dateLabel, errorLabel, localized, moneyLabel, pageHref, postJson, serviceTitle, statusTitle,
  type Conversation, type Language, type Order,
} from './customer-data';
import { CustomerMessages } from './customer-messages';
import { ProjectReviewPanel } from './project-review-panel';

export function orderTitle(order: Order, language: Language) {
  return order.templateName || serviceTitle(order.service, language);
}

export function latestOrderUpdate(order: Order) {
  return [...(order.projectHistory || []), ...(order.history || [])].reduce((latest, event) => (
    Date.parse(event.at) > Date.parse(latest) ? event.at : latest
  ), order.createdAt);
}

export function CustomerOrder({ order, conversation, viewerId, language, onChange, onUnauthorized }: {
  order: Order; conversation?: Conversation; viewerId: string; language: Language; onChange: () => Promise<void>; onUnauthorized: () => void;
}) {
  const [pending, setPending] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const busy = useRef(false);
  const t = (ar: string, en: string) => localized(language, ar, en);
  const timeline = order.projectHistory?.length ? order.projectHistory : order.history || [];
  let customerFileIndex = 0;

  async function complete(action: 'quote-accept' | 'delivery', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy.current) return;
    const form = event && new FormData(event.currentTarget);
    const decision = form?.get('decision') === 'revision' ? 'revision' : 'received';
    busy.current = true;
    setPending(action);
    setFeedback(null);
    try {
      const result = await postJson<{ ok: boolean }>('/api/client/orders/' + order.id + '/' + action, action === 'delivery' ? { decision, note: String(form?.get('note') || '').trim() } : {});
      if (!result.ok) throw new Error('Change not confirmed');
      setFeedback({ ok: true, text: t('تم تسجيل الإجراء.', 'The change was saved.') });
      await onChange();
    } catch (error) {
      if (error instanceof CustomerApiError && error.status === 401) onUnauthorized();
      setFeedback({ ok: false, text: errorLabel(error, language) });
    } finally { setPending(''); busy.current = false; }
  }

  return <div className="zc-stack">
    <section className="zc-panel" aria-labelledby="zc-order-heading">
      <div className="zc-title-row"><div><h2 id="zc-order-heading" dir="auto">{orderTitle(order, language)}</h2><p dir="ltr">{order.id}</p></div><span className="zc-status">{statusTitle(order.projectStage || order.status, language)}</span></div>
      <p className="zc-pre" dir="auto">{order.details}</p>
      {!!order.publicStatusNote && <p dir="auto" className="zc-callout">{order.publicStatusNote}</p>}
      <dl className="zc-summary">
        <div><dt>{t('تاريخ الطلب', 'Requested')}</dt><dd>{dateLabel(order.createdAt, language)}</dd></div>
        <div><dt>{t('آخر تحديث', 'Last update')}</dt><dd>{dateLabel(latestOrderUpdate(order), language)}</dd></div>
        {order.dueDate && <div><dt>{t('موعد التسليم', 'Due date')}</dt><dd>{dateLabel(order.dueDate, language)}</dd></div>}
        {order.budget && <div><dt>{t('الميزانية المقدّرة', 'Estimated budget')}</dt><dd dir="auto">{order.budget}</dd></div>}
      </dl>
    </section>

    <div className="zc-data-grid">
      <section className="zc-panel" aria-labelledby="zc-timeline-heading">
        <h2 id="zc-timeline-heading">{t('مراحل الطلب', 'Project timeline')}</h2>
        {timeline.length ? <ol className="zc-timeline">
          {[...timeline].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((row, index) => <li key={row.at + '-' + index}>
            <strong>{statusTitle(row.stage || row.status || '', language)}</strong> <time dateTime={row.at}>{dateLabel(row.at, language)}</time>
            {row.note && <p dir="auto">{row.note}</p>}
          </li>)}
        </ol> : <p>{t('لا توجد تحديثات بعد.', 'No updates yet.')}</p>}
      </section>
      <section className="zc-panel" aria-labelledby="zc-order-files">
        <h2 id="zc-order-files">{t('الملفات والمرفقات', 'Files and attachments')}</h2>
        {order.files?.length ? <ul className="zc-list">
          {order.files.map(file => {
            const kind = file.kind === 'deliverable' ? 'deliverable' : 'customer_upload';
            const index = kind === 'deliverable' ? file.index : customerFileIndex++;
            return Number.isInteger(index) && <li key={kind + '-' + index}>
              <a className="zc-attachment" dir="auto" href={'/api/client/orders/' + order.id + '/files/' + kind + '/' + index}>{file.name}</a>
              <span>{kind === 'deliverable' ? t('ملف تسليم', 'Deliverable') : t('مرفق الطلب', 'Request attachment')}</span>
            </li>;
          })}
        </ul> : <p>{t('لا توجد ملفات مرتبطة بالطلب.', 'There are no files attached to this request.')}</p>}
      </section>
    </div>

    {(order.canAcceptQuote || order.contractAmount != null || order.paidTotal > 0) && <section className="zc-panel">
      <h2>{t('عرض السعر والمدفوعات', 'Quote and payments')}</h2>
      <dl className="zc-summary">
        <div><dt>{t('قيمة العرض', 'Quote total')}</dt><dd>{moneyLabel(order.contractAmount, language)}</dd></div>
        <div><dt>{t('المبلغ المحصّل', 'Collected')}</dt><dd>{moneyLabel(order.paidTotal, language)}</dd></div>
        <div><dt>{t('الرصيد المتبقي', 'Balance due')}</dt><dd>{moneyLabel(order.balanceDue, language)}</dd></div>
      </dl>
      {order.canAcceptQuote && <button className="zc-button" disabled={!!pending} onClick={() => void complete('quote-accept')}>{pending === 'quote-accept' ? t('جارٍ قبول العرض…', 'Accepting quote…') : t('الموافقة على العرض', 'Accept quote')}</button>}
    </section>}

    {order.canConfirmDelivery && <section className="zc-panel"><h2>{t('مراجعة التسليم', 'Review your delivery')}</h2>
      <form className="zc-form" onSubmit={event => void complete('delivery', event)} aria-busy={pending === 'delivery'}>
        <label>{t('القرار', 'Decision')}<select name="decision" required>
          <option value="">{t('اختر إجراءً', 'Choose an action')}</option>
          <option value="received">{t('تأكيد الاستلام', 'Confirm receipt')}</option>
          <option value="revision">{t('طلب تعديل', 'Request a revision')}</option>
        </select></label>
        <label>{t('ملاحظات (اختياري)', 'Notes (optional)')}<textarea rows={3} name="note" maxLength={1000} dir="auto" /></label>
        <button className="zc-button" disabled={!!pending}>{pending === 'delivery' ? t('جارٍ تسجيل القرار…', 'Saving your decision…') : t('حفظ القرار', 'Save decision')}</button>
      </form>
    </section>}
    {feedback && <p className={feedback.ok ? 'zc-success' : 'zc-error'} role={feedback.ok ? 'status' : 'alert'}>{feedback.text}</p>}

    {conversation ? <CustomerMessages key={conversation.id} language={language} conversationId={conversation.id} viewerId={viewerId} leadId={order.id} onUnauthorized={onUnauthorized} />
      : <section className="zc-panel"><h2>{t('التواصل مع الفريق', 'Contact the team')}</h2><p>{t('لا توجد محادثة مرتبطة بهذا الطلب. يمكنك مراسلة الفريق وذكر رقم الطلب.', 'No conversation is linked to this request. You can contact the team and include the request number.')}</p><a href={pageHref('/contact', language)} className="zc-button zc-secondary">{t('تواصل معنا', 'Contact us')}</a></section>}

    {['delivered', 'completed'].includes(order.projectStage || order.status) && <ProjectReviewPanel projectId={order.id} language={language} />}
  </div>;
}
