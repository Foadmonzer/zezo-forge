'use client';

import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    zezoAnalyticsCapture?: (eventName: string, properties?: Record<string, unknown>) => void;
  }
}

export default function LegacyApplication({ markup }: { markup: string }) {
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let active = true;
    let analyticsClient: typeof import('posthog-js').default | null = null;
    let analyticsLoading: Promise<void> | null = null;
    let analyticsConsented = false;
    const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || '';
    const analyticsHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || '';
    const params = new URLSearchParams(location.search);
    const sensitiveRoute = location.pathname !== '/' || ['track', 'token', 'verifyEmail', 'resetPassword'].some(key => params.has(key));

    const allowedEvents = new Set(['site_view', 'service_view', 'template_view', 'begin_enquiry', 'enquiry_submitted']);
    const safeCapture = (eventName: string, input: Record<string, unknown> = {}) => {
      if (!analyticsConsented || !analyticsClient || sensitiveRoute || !allowedEvents.has(eventName)) return;
      const allowedKeys = new Set(['path', 'language', 'service_id', 'template_id', 'template_action', 'source', 'kind']);
      const properties: Record<string, string> = {};
      for (const [key, value] of Object.entries(input)) {
        if (!allowedKeys.has(key) || typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) continue;
        properties[key] = value;
      }
      analyticsClient.capture(eventName, properties);
    };

    const enableAnalytics = async (allowed: boolean) => {
      if (!allowed) {
        analyticsConsented = false;
        analyticsClient?.opt_out_capturing();
        return;
      }
      if (sensitiveRoute || !projectToken || !analyticsHost) return;
      if (analyticsClient) {
        analyticsClient.opt_in_capturing({ captureEventName: false });
        analyticsConsented = true;
        return;
      }
      if (!analyticsLoading) {
        analyticsLoading = import('posthog-js').then(({ default: posthog }) => {
          if (!active) return;
          analyticsClient = posthog;
          posthog.init(projectToken, {
            api_host: analyticsHost,
            defaults: '2026-08-30',
            autocapture: false,
            capture_pageview: false,
            capture_pageleave: false,
            disable_session_recording: true,
            disable_surveys: true,
            respect_dnt: true,
            before_send: event => {
              if (!event?.properties) return event;
              delete event.properties.$current_url;
              delete event.properties.$pathname;
              delete event.properties.$referrer;
              delete event.properties.$initial_referrer;
              delete event.properties.$initial_current_url;
              return event;
            }
          });
          posthog.opt_in_capturing({ captureEventName: false });
          analyticsConsented = true;
          safeCapture('site_view', { path: location.pathname, language: document.documentElement.lang || 'ar' });
        }).catch(() => { analyticsLoading = null; });
      }
      await analyticsLoading;
    };

    window.zezoAnalyticsCapture = safeCapture;
    const consentChanged = (event: Event) => {
      const allowed = (event as CustomEvent<{ allowed?: boolean }>).detail?.allowed === true;
      void enableAnalytics(allowed);
    };
    window.addEventListener('zezo-analytics-consent', consentChanged);
    if (localStorage.getItem('zezo-referral-analytics') === 'yes') void enableAnalytics(true);

    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/app.js';
    script.dataset.zezoLegacyApp = 'true';
    script.addEventListener('load', () => {
      document.documentElement.dataset.zezoAppReady = 'true';
    }, { once: true });
    document.body.append(script);
    return () => {
      active = false;
      window.removeEventListener('zezo-analytics-consent', consentChanged);
      delete window.zezoAnalyticsCapture;
      script.remove();
    };
  }, []);

  return <div id="zezo-legacy-root" dangerouslySetInnerHTML={{ __html: markup }} />;
}
