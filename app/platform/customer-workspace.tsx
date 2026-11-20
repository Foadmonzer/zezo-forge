
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  accountHref, conversationHref, customerApi, CustomerApiError, dateLabel, errorLabel, localized, orderHref,
  pageHref, postJson, safeId, statusTitle, type Conversation, type Customer, type Dashboard, type Language, type Notice, type Order,
} from './customer-data';
import { conversationTitle, CustomerMessages } from './customer-messages';
import { CustomerOrder, latestOrderUpdate, orderTitle } from './customer-order';
import { CustomerSettings } from './customer-settings';

type View = 'overview' | 'orders' | 'order' | 'settings';
type Props = { language: Language; view: View; orderId?: string; tab?: string; conversationId?: string };
type Access = 'checking' | 'guest' | 'team' | 'client' | 'error';
type Notices = { notifications: Notice[]; unreadCount: number };

function isMessageNotice(notice: Notice) {
  return notice.target?.kind === 'conversation' && safeId(notice.target.id || '');
}

export function CustomerWorkspace({ language, view, orderId = '', tab = '', conversationId = '' }: Props) {
  const [access, setAccess] = useState<Access>('checking');
  const [viewer, setViewer] = useState<Customer | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [inbox, setInbox] = useState<Conversation[] | null>(null);
  const [inboxError, setInboxError] = useState('');
  const [notices, setNotices] = useState<Notices | null>(null);
  const [noticeError, setNoticeError] = useState('');
  const [error, setError] = useState('');
  const hostRequest = useRef<AbortController | null>(null);
  const t = (ar: string, en: string) => localized(language, ar, en);
  const currentPath = view === 'settings' ? pageHref('/account/settings', language, { tab, conversation: conversationId })
    : view === 'order' ? orderHref(orderId, language) : pageHref('/account/' + view, language);
  const signIn = accountHref(language, currentPath);
  const isInbox = view === 'settings' && tab !== 'profile' && tab !== 'notifications';

  const expire = useCallback(() => {
    hostRequest.current?.abort();
    setDashboard(null);
    setViewer(null);
    setInbox(null);
    setNotices(null);
    setAccess('guest');
  }, []);

  const load = useCallback(async (hide = false) => {
    hostRequest.current?.abort();
    const controller = new AbortController();
    hostRequest.current = controller;
    const options = { signal: controller.signal };
    if (hide) {
      setAccess('checking');
      setDashboard(null);
      setViewer(null);
      setInbox(null);
      setNotices(null);
    }
    setError('');
    setNoticeError('');
    setInboxError('');
    try {
      const session = await customerApi<{ user?: Customer }>('/api/auth/session', options);
      if (controller.signal.aborted) return;
      if (!session.user) return expire();
      if (session.user.role !== 'client') {
        setDashboard(null);
        setViewer(null);
        setInbox(null);
        setNotices(null);
        setAccess('team');
        return;
      }
      if (isInbox) {
        // The protected detail can load while the small conversation list loads.
        setViewer(session.user);
        setAccess('client');
        try {
          const { conversations } = await customerApi<{ conversations: Conversation[] }>('/api/conversations?summary=1', options);
          if (controller.signal.aborted) return;
          setInbox(conversations);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof CustomerApiError && [401, 428].includes(error.status)) return expire();
          setInboxError(errorLabel(error, language));
        }
      } else {
        const data = await customerApi<Dashboard | { role: string }>('/api/dashboard', options);
        if (controller.signal.aborted) return;
        if (data.role !== 'client' || !('orders' in data) || data.user.id !== session.user.id) {
          setDashboard(null);
          setViewer(null);
          setNotices(null);
          setAccess('team');
          return;
        }
        setViewer(data.user);
        setDashboard(data);
        setAccess('client');
      }
      if (view === 'orders' || view === 'order' || (view === 'settings' && tab === 'profile')) return;
      try {
        const result = await customerApi<Notices>('/api/notifications?limit=40', options);
        if (!controller.signal.aborted) setNotices(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof CustomerApiError && error.status === 401) return expire();
        setNoticeError(errorLabel(error, language));
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof CustomerApiError && error.status === 401) return expire();
      setError(errorLabel(error, language));
      setAccess('error');
    }
  }, [expire, isInbox, language, view, tab]);

  useEffect(() => {
    void load(true);
    const sync = (event: StorageEvent) => {
      if (event.key === 'zezo-session-context-changed' || event.key === null) void load(true);
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void load(true); };
    window.addEventListener('storage', sync);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      hostRequest.current?.abort();
      window.removeEventListener('storage', sync);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [load]);

  const heading = {
    overview: t('مساحة العميل', 'Customer dashboard'), orders: t('طلباتي', 'My orders'),
    order: t('تفاصيل الطلب', 'Order details'), settings: t('الرسائل وإعدادات الحساب', 'Messages and account settings'),
  };
  const tabs = [
    { view: 'overview', label: t('نظرة عامة', 'Overview'), href: pageHref('/account/overview', language) },
    { view: 'orders', label: t('طلباتي', 'My orders'), href: pageHref('/account/orders', language) },
    { view: 'settings', label: t('الرسائل والإعدادات', 'Messages and settings'), href: pageHref('/account/settings', language, { tab: 'messages' }) },
  ];

  const order = dashboard?.orders.find(item => item.id === orderId);
  const selectedConversation = safeId(conversationId) ? conversationId : '';
  const currentTab = tab === 'notifications' || tab === 'profile' ? tab : 'messages';
  const showNoticeIssue = noticeError && <p role="status" className="zc-error">{noticeError} <button type="button" className="zc-inline" onClick={() => void load()}>{t('إعادة المحاولة', 'Try again')}</button></p>;

  return <section className="zc zc-workspace">
    <header className="zc-heading zc-title-row">
      <div><h1>{heading[view]}</h1>{access === 'client' && view === 'overview' && <p><span>{t('مرحباً،', 'Welcome,')}</span> <bdi>{dashboard?.profile.name}</bdi></p>}</div>
      {access === 'client' && <a className="zc-button" href={pageHref('/request', language)}>{t('طلب مشروع جديد', 'New project request')}</a>}
    </header>
    {access === 'checking' && <section className="zc-panel" role="status">{t('جارٍ فتح حسابك…', 'Opening your account…')}</section>}
    {access === 'guest' && <section className="zc-panel"><h2>{t('سجّل الدخول للمتابعة', 'Sign in to continue')}</h2><a className="zc-button" href={signIn}>{t('تسجيل دخول العميل', 'Customer sign-in')}</a></section>}
    {access === 'team' && <section className="zc-panel"><p>{t('تستخدم حساب فريق. مساحة العميل تتطلب حساب عميل.', 'You are using a team account. The customer workspace requires a customer account.')}</p><div className="zc-actions"><a href={pageHref('/team', language)} className="zc-button">{t('مساحة الفريق', 'Team workspace')}</a><a href={signIn} className="zc-button zc-secondary">{t('تبديل الحساب', 'Switch account')}</a></div></section>}
    {access === 'error' && <section className="zc-panel"><p role="alert" className="zc-error">{error}</p><button type="button" className="zc-button zc-secondary" onClick={() => void load(true)}>{t('إعادة المحاولة', 'Try again')}</button></section>}
    {access === 'client' && viewer && <div className="zc-stack" key={viewer.id}>
      <nav className="zc-tabs" aria-label={t('مساحة العميل', 'Customer workspace')}>
        {tabs.map(item => <a key={item.view} href={item.href} aria-current={item.view === view || (item.view === 'orders' && view === 'order') ? 'page' : undefined}>{item.label}</a>)}
      </nav>
      {view === 'overview' && dashboard && <>
        <Overview dashboard={dashboard} notices={notices} language={language} />
        {showNoticeIssue}
      </>}
      {view === 'orders' && dashboard && <Orders orders={dashboard.orders} language={language} />}
      {view === 'order' && dashboard && (order
        ? <CustomerOrder key={order.id} order={order} conversation={dashboard.conversations.find(item => item.leadId === order.id)} viewerId={viewer.id} language={language} onChange={load} onUnauthorized={expire} />
        : <section className="zc-panel"><p role="alert">{t('الطلب غير موجود في حسابك.', 'This request is not in your account.')}</p><a className="zc-button zc-secondary" href={pageHref('/account/orders', language)}>{t('عرض طلباتي', 'View my orders')}</a></section>)}
      {view === 'settings' && <>
        <nav className="zc-tabs zc-subtabs" aria-label={t('أقسام إعدادات الحساب', 'Account settings sections')}>
          {[
            ['messages', t('المحادثات', 'Conversations')],
            ['notifications', t('الإشعارات', 'Notifications')],
            ['profile', t('الحساب والأمان', 'Account and security')],
          ].map(([name, label]) => <a key={name} aria-current={currentTab === name ? 'page' : undefined} href={pageHref('/account/settings', language, { tab: name })}>{label}</a>)}
        </nav>
        {currentTab === 'messages' && <div className="zc-inbox">
          <section className="zc-panel"><h2>{t('المحادثات', 'Conversations')}</h2>
            <ConversationList items={inbox || []} notices={notices?.notifications || []} language={language} current={conversationId} />
            {!inbox && !inboxError && <p role="status">{t('جارٍ تحميل قائمة المحادثات…', 'Loading conversations…')}</p>}
            {inboxError && <p role="status" className="zc-error">{inboxError} <button type="button" className="zc-inline" onClick={() => void load()}>{t('إعادة المحاولة', 'Try again')}</button></p>}
            {inbox?.length === 0 && <p>{t('ستظهر المحادثات المرتبطة بحسابك هنا.', 'Conversations linked to your account will appear here.')}</p>}
            {showNoticeIssue}
          </section>
          {selectedConversation
            ? <CustomerMessages key={selectedConversation} language={language} conversationId={selectedConversation} viewerId={viewer.id} onUnauthorized={expire} />
            : <section className="zc-panel"><p role={conversationId ? 'alert' : undefined}>{conversationId ? t('هذه المحادثة غير موجودة في حسابك.', 'This conversation is not in your account.') : t('اختر محادثة لقراءة الرسائل والردّ.', 'Choose a conversation to read and reply.')}</p><a href={pageHref('/contact', language)} className="zc-button zc-secondary">{t('تواصل مع الفريق', 'Contact the team')}</a></section>}
        </div>}
        {currentTab === 'notifications' && <NotificationList language={language} notices={notices} update={setNotices} error={showNoticeIssue} onUnauthorized={expire} />}
        {currentTab === 'profile' && dashboard && <CustomerSettings profile={dashboard.profile} userId={dashboard.user.id} language={language} reload={() => load()} />}
      </>}
    </div>}
  </section>;
}

function OrderRows({ rows, language }: { rows: Order[]; language: Language }) {
  const t = (ar: string, en: string) => localized(language, ar, en);
  return <ul className="zc-list zc-orders-list">
    {rows.map(order => <li key={order.id}>
      <a className="zc-order-row" href={orderHref(order.id, language)}>
        <div><strong dir="auto">{orderTitle(order, language)}</strong><small><bdi>{order.id}</bdi></small></div>
        <div><small>{t('تاريخ الطلب', 'Requested')}</small><time dateTime={order.createdAt}>{dateLabel(order.createdAt, language)}</time></div>
        <div><small>{t('آخر تحديث', 'Last update')}</small><time dateTime={latestOrderUpdate(order)}>{dateLabel(latestOrderUpdate(order), language)}</time></div>
        <span className="zc-status">{statusTitle(order.projectStage || order.status, language)}</span>
      </a>
    </li>)}
  </ul>;
}

function Orders({ orders, language }: { orders: Order[]; language: Language }) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('');
  const t = (ar: string, en: string) => localized(language, ar, en);
  const stages = [...new Set(orders.map(order => order.projectStage || order.status))];
  const shown = orders.filter(order => (!stage || stage === (order.projectStage || order.status))
    && (order.id + ' ' + orderTitle(order, language) + ' ' + order.details).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="zc-panel">
    <div className="zc-filter">
      <label>{t('بحث في الطلبات', 'Search orders')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>{t('الحالة', 'Status')}<select value={stage} onChange={event => setStage(event.target.value)}>
        <option value="">{t('كل الحالات', 'All statuses')}</option>
        {stages.map(key => <option key={key} value={key}>{statusTitle(key, language)}</option>)}
      </select></label>
    </div>
    {shown.length ? <OrderRows rows={shown} language={language} /> : <p role="status">{orders.length ? t('لا توجد طلبات مطابقة للبحث.', 'No orders match your search.') : t('لا توجد طلبات مسجّلة بعد.', 'You have no requests yet.')}</p>}
  </section>;
}

function ConversationList({ items, notices, current, language }: { items: Conversation[]; notices: Notice[]; current?: string; language: Language }) {
  const t = (ar: string, en: string) => localized(language, ar, en);
  return <ul className="zc-list zc-conversation-links">
    {items.map(item => {
      const unread = notices.filter(notice => isMessageNotice(notice) && notice.target?.id === item.id && !notice.readAt).length;
      return <li key={item.id}><a href={conversationHref(item.id, language)} aria-current={current === item.id ? 'page' : undefined}>
        <strong dir="auto">{conversationTitle(item, language)}</strong>
        <time dateTime={item.updatedAt}>{dateLabel(item.updatedAt, language)}</time>
        {unread > 0 && <span className="zc-status">{unread} {t('غير مقروءة', 'unread')}</span>}
      </a></li>;
    })}
  </ul>;
}

function NoticeInfo({ notice, language }: { notice: Notice; language: Language }) {
  const t = (ar: string, en: string) => localized(language, ar, en);
  const title = language === 'en' ? notice.titleEn || notice.titleAr : notice.titleAr || notice.titleEn;
  const description = language === 'en' ? notice.descriptionEn || notice.descriptionAr : notice.descriptionAr || notice.descriptionEn;
  const id = notice.target?.id || '';
  const destination = isMessageNotice(notice) ? conversationHref(id, language) : (notice.target?.kind === 'lead' && safeId(id) ? orderHref(id, language) : '');
  return <div className="zc-notice">
    {destination ? <a href={destination}><strong dir="auto">{title}</strong></a> : <strong dir="auto">{title}</strong>}
    {!notice.readAt && <span className="zc-status">{t('جديد', 'New')}</span>}
    {description && <p dir="auto">{description}</p>}
    <time dateTime={notice.createdAt}>{dateLabel(notice.createdAt, language)}</time>
  </div>;
}

function Overview({ dashboard, notices, language }: { dashboard: Dashboard; notices: Notices | null; language: Language }) {
  const t = (ar: string, en: string) => localized(language, ar, en);
  const required = dashboard.orders.filter(order => order.canAcceptQuote || order.canConfirmDelivery);
  return <>
    <dl className="zc-metrics">
      <div><dt>{t('الطلبات', 'Orders')}</dt><dd>{dashboard.orders.length}</dd></div>
      <div><dt>{t('بانتظار إجراء منك', 'Awaiting your action')}</dt><dd>{required.length}</dd></div>
      <div><dt>{t('الإشعارات غير المقروءة', 'Unread notifications')}</dt><dd>{notices?.unreadCount ?? '—'}</dd></div>
    </dl>
    {required.length > 0 && <section className="zc-panel"><h2>{t('إجراءات مطلوبة', 'Action required')}</h2>
      <ul className="zc-list">{required.map(order => <li key={order.id}><a href={orderHref(order.id, language)}>{orderTitle(order, language)} · {order.canAcceptQuote ? t('راجع عرض السعر', 'Review quote') : t('راجع التسليم', 'Review delivery')}</a></li>)}</ul>
    </section>}
    <section className="zc-panel"><div className="zc-title-row"><h2>{t('آخر الطلبات', 'Recent orders')}</h2><a href={pageHref('/account/orders', language)}>{t('كل الطلبات', 'All orders')}</a></div>
      {dashboard.orders.length ? <OrderRows rows={dashboard.orders.slice(0, 4)} language={language} /> : <p>{t('تظهر هنا مشاريعك بعد إرسال أول طلب.', 'Projects appear here after you submit your first request.')}</p>}
    </section>
    <div className="zc-data-grid">
      <section className="zc-panel"><div className="zc-title-row"><h2>{t('آخر المحادثات', 'Recent conversations')}</h2><a href={pageHref('/account/settings', language, { tab: 'messages' })}>{t('الرسائل', 'Messages')}</a></div>
        {dashboard.conversations.length ? <ConversationList items={dashboard.conversations.slice(0, 4)} notices={notices?.notifications || []} language={language} /> : <p>{t('لا توجد محادثات بعد.', 'There are no conversations yet.')}</p>}
      </section>
      <section className="zc-panel"><div className="zc-title-row"><h2>{t('الإشعارات', 'Notifications')}</h2><a href={pageHref('/account/settings', language, { tab: 'notifications' })}>{t('كل الإشعارات', 'All notifications')}</a></div>
        {notices && (notices.notifications.length ? <ul className="zc-list">{notices.notifications.slice(0, 4).map(notice => <li key={notice.id}><NoticeInfo notice={notice} language={language} /></li>)}</ul> : <p>{t('لا توجد إشعارات بعد.', 'There are no notifications yet.')}</p>)}
      </section>
    </div>
  </>;
}

function NotificationList({ language, notices, update, error, onUnauthorized }: {
  language: Language; notices: Notices | null; update: (data: Notices) => void; error: React.ReactNode; onUnauthorized: () => void;
}) {
  const [filter, setFilter] = useState(false);
  const [pending, setPending] = useState('');
  const [issue, setIssue] = useState('');
  const busy = useRef(false);
  const t = (ar: string, en: string) => localized(language, ar, en);

  async function mark(id: string) {
    if (!notices || busy.current) return;
    busy.current = true;
    setPending(id);
    setIssue('');
    try {
      if (id === 'all') {
        await postJson('/api/notifications/read-all', {});
        const readAt = new Date().toISOString();
        update({ unreadCount: 0, notifications: notices.notifications.map(item => ({ ...item, readAt: item.readAt || readAt })) });
      } else if (safeId(id)) {
        const result = await postJson<{ notification: Notice; unreadCount: number }>('/api/notifications/' + id, { read: true }, 'PATCH');
        update({ unreadCount: result.unreadCount, notifications: notices.notifications.map(item => item.id === id ? result.notification : item) });
      }
    } catch (error) {
      if (error instanceof CustomerApiError && error.status === 401) onUnauthorized();
      setIssue(errorLabel(error, language));
    } finally { busy.current = false; setPending(''); }
  }

  const visible = notices?.notifications.filter(item => !filter || !item.readAt) || [];
  return <section className="zc-panel">
    <div className="zc-title-row"><h2>{t('إشعارات الحساب', 'Account notifications')}</h2>
      {Boolean(notices?.unreadCount) && <button type="button" className="zc-button zc-secondary" onClick={() => void mark('all')} disabled={!!pending}>{pending === 'all' ? t('جارٍ التحديث…', 'Updating…') : t('تحديد الكل كمقروء', 'Mark all as read')}</button>}
    </div>
    <label className="zc-check"><input type="checkbox" checked={filter} onChange={event => setFilter(event.target.checked)} />{t('غير المقروءة فقط', 'Unread only')}</label>
    {error}
    {issue && <p role="alert" className="zc-error">{issue}</p>}
    {!notices && !error && <p role="status">{t('جارٍ تحميل الإشعارات…', 'Loading notifications…')}</p>}
    {notices && (visible.length ? <ul className="zc-list">
      {visible.map(notice => <li key={notice.id}><NoticeInfo notice={notice} language={language} />
        {!notice.readAt && <button type="button" className="zc-inline" onClick={() => void mark(notice.id)} disabled={!!pending}>{pending === notice.id ? t('جارٍ التحديث…', 'Updating…') : t('تحديد كمقروء', 'Mark as read')}</button>}
      </li>)}
    </ul> : <p>{t('لا توجد إشعارات مطابقة.', 'No matching notifications.')}</p>)}
  </section>;
}
