'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import { ensurePlatformReferral } from './browser-referral';
import type { PlatformLanguage } from './shell';

const links = [
  ['/', 'الرئيسية', 'Home'], ['/services', 'خدماتنا', 'Services'], ['/templates', 'القوالب', 'Templates'],
  ['/work', 'أعمالنا', 'Work'], ['/reviews', 'الآراء', 'Reviews'], ['/about', 'من نحن', 'About'],
  ['/contact', 'تواصل معنا', 'Contact']
] as const;

function localized(path: string, language: PlatformLanguage, referral = '') {
  const params = new URLSearchParams();
  if (language === 'en') params.set('lang', 'en');
  if (referral) params.set('ref', referral);
  return params.size ? `${path}?${params}` : path;
}

function alternateLanguage(event: MouseEvent<HTMLAnchorElement>, language: PlatformLanguage) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const url = new URL(location.href);
  if (language === 'ar') url.searchParams.set('lang', 'en');
  else url.searchParams.delete('lang');
  location.assign(url);
}

export default function PlatformNavigation({ language, incomingReferral = '' }: { language: PlatformLanguage; incomingReferral?: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const [referral, setReferral] = useState(incomingReferral.slice(0, 100));
  const toggle = useRef<HTMLButtonElement>(null);
  const en = language === 'en';

  useEffect(() => {
    setOpen(false);
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    if (location.pathname === '/' && new URLSearchParams(location.hash.slice(1)).has('resetPassword')) {
      location.replace(`${localized('/account', language, referral)}${location.hash}`);
      return;
    }
    const historical = new Map([['#services', '/services'], ['#templates', '/templates'], ['#work', '/work'], ['#about', '/about'], ['#contact', '/request']]);
    const destination = location.pathname === '/' && historical.get(location.hash);
    if (destination) {
      const url = new URL(localized(destination, language), location.origin);
      const referral = new URLSearchParams(location.search).get('ref');
      if (referral) url.searchParams.set('ref', referral);
      location.replace(url);
      return;
    }
    let active = true;
    void ensurePlatformReferral().then(() => { if (active) setReferral(''); }).catch(() => {});
    return () => { active = false; };
  }, [path, language, incomingReferral]);

  return (
    <header className="zf-header" onKeyDown={event => {
      if (event.key === 'Escape' && open) { setOpen(false); toggle.current?.focus(); }
    }}>
      <div className="zf-wrap zf-header-inner">
        <a href={localized('/', language, referral)} className="zf-brand" aria-label="ZEZO Forge">
          <img src="/favicon.svg" width="38" height="38" alt="" />
          <span>ZEZO<span className="zf-brand-dot">.</span><small>Digital Solutions &amp; AI</small></span>
        </a>
        <nav id="zf-navigation" className="zf-nav" data-open={open} aria-label={en ? 'Main navigation' : 'التنقل الرئيسي'}>
          {links.map(([href, ar, english]) => (
            <a key={href} href={localized(href, language, referral)} aria-current={href === path || (href !== '/' && path?.startsWith(`${href}/`)) ? 'page' : undefined}>
              {en ? english : ar}
            </a>
          ))}
          <a className="zf-nav-account" href={localized('/account', language, referral)}>{en ? 'My account' : 'حسابي'}</a>
        </nav>
        <div className="zf-header-actions">
          <a className="zf-language" href={en ? '?' : '?lang=en'} hrefLang={en ? 'ar' : 'en'} onClick={event => alternateLanguage(event, language)} aria-label={en ? 'Switch to Arabic' : 'التبديل إلى الإنجليزية'}>{en ? 'عربي' : 'EN'}</a>
          <a className="zf-account" href={localized('/account', language, referral)}>{en ? 'My account' : 'حسابي'}</a>
          <a className="zf-button zf-button--primary" href={localized('/request', language, referral)}>{en ? 'Start a project' : 'اطلب مشروعك'}</a>
          <button className="zf-menu-toggle" ref={toggle} type="button" aria-controls="zf-navigation" aria-expanded={open} aria-label={open ? (en ? 'Close menu' : 'أغلق القائمة') : (en ? 'Open menu' : 'افتح القائمة')} onClick={() => setOpen(value => !value)}>
            <span aria-hidden="true" /><span aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

const consentKey = 'zezo-referral-analytics';
const visitorKey = 'zezo-referral-visitor';

export function PlatformPrivacy({ language }: { language: PlatformLanguage }) {
  const path = usePathname();
  const [choice, setChoice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const en = language === 'en';

  useEffect(() => {
    try { setChoice(localStorage.getItem(consentKey) || 'unset'); }
    catch { setChoice('no'); }
  }, []);

  useEffect(() => {
    if (choice !== 'yes' || /^\/(account|request|reviews\/moderation)(\/|$)/.test(location.pathname) || /resetPassword=/.test(location.hash)) return;
    let active = true;
    let observer: IntersectionObserver | undefined;
    const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    const analyticsHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    if (projectToken && analyticsHost) {
      void import('posthog-js').then(({ default: posthog }) => {
        if (!active) return;
        posthog.init(projectToken, {
          api_host: analyticsHost, defaults: '2026-08-30', autocapture: false, capture_pageview: false,
          capture_pageleave: false, disable_session_recording: true, disable_surveys: true, respect_dnt: true,
          before_send: event => {
            if (!event?.properties) return event;
            for (const key of ['$current_url', '$pathname', '$referrer', '$initial_referrer', '$initial_current_url']) delete event.properties[key];
            return event;
          }
        });
        posthog.opt_in_capturing({ captureEventName: false });
        posthog.capture('site_view', { path: location.pathname, language });
      }).catch(() => {});
    }
    void ensurePlatformReferral({ includeExisting: true }).then(attribution => {
      if (!active || !attribution?.attributed) return;
      let visitorId = localStorage.getItem(visitorKey);
      if (!visitorId) { visitorId = crypto.randomUUID(); localStorage.setItem(visitorKey, visitorId); }
      const send = (type: string, resourceId = '') => {
        if (!active) return;
        const body = JSON.stringify({ type, visitorId, resourceId, eventId: crypto.randomUUID() });
        void fetch('/api/referral-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
      };
      send('visit');
      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
          for (const { target, isIntersecting } of entries) {
            if (!isIntersecting) continue;
            if (target instanceof HTMLElement) {
              const service = target.dataset.serviceCard;
              send(service ? 'service_view' : 'template_view', service || target.dataset.templateId || '');
            }
            observer?.unobserve(target);
          }
        }, { threshold: 0.5 });
        document.querySelectorAll('[data-service-card],[data-template-id]').forEach(card => observer?.observe(card));
      }
    }).catch(() => {});
    return () => { active = false; observer?.disconnect(); };
  }, [choice, language, path]);

  function update(allowed: boolean) {
    try {
      const previous = localStorage.getItem(visitorKey);
      localStorage.setItem(consentKey, allowed ? 'yes' : 'no');
      if (!allowed) {
        localStorage.removeItem(visitorKey);
        if (previous) void fetch('/api/referral-consent/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: previous }), keepalive: true }).catch(() => {});
        if (choice === 'yes') void import('posthog-js').then(({ default: posthog }) => posthog.opt_out_capturing()).catch(() => {});
      }
    } catch { /* Browsers without storage still support the essential experience. */ }
    setChoice(allowed ? 'yes' : 'no');
    setEditing(false);
  }

  return (
    <div className="zf-privacy-wrap">
      <button type="button" className="zf-privacy-link" onClick={() => setEditing(value => !value)}>{en ? 'Privacy choices' : 'خيارات الخصوصية'}</button>
      {(choice === 'unset' || editing) && (
        <section className="zf-privacy" aria-label={en ? 'Privacy choices' : 'خيارات الخصوصية'}>
          <p>{en ? 'A first-party cookie preserves a valid referral. Optional audience measurement is your choice.' : 'نحفظ الإحالة الصالحة في ملف ارتباط من الموقع. يمكنك قبول قياس الزيارات الاختياري أو رفضه.'}</p>
          <div><button type="button" className="zf-button" onClick={() => update(false)}>{en ? 'Essentials only' : 'الأساسيات فقط'}</button><button type="button" className="zf-button zf-button--primary" onClick={() => update(true)}>{en ? 'Allow measurement' : 'السماح بالقياس'}</button></div>
        </section>
      )}
    </div>
  );
}
