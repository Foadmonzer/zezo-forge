import type { ReactNode } from 'react';
import PlatformNavigation, { PlatformPrivacy } from './shell-client';

export type PlatformLanguage = 'ar' | 'en';

export function platformLink(path: string, language: PlatformLanguage) {
  if (language === 'ar') return path;
  const url = new URL(path, 'https://zezoforge.com');
  url.searchParams.set('lang', 'en');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function PlatformShell({ children, language = 'ar', incomingReferral }: { children: ReactNode; language?: PlatformLanguage; incomingReferral?: string }) {
  const en = language === 'en';
  return (
    <div className="zezo-platform" lang={language} dir={en ? 'ltr' : 'rtl'}>
      <a className="zf-skip" href="#zf-content">{en ? 'Skip to content' : 'انتقل إلى المحتوى'}</a>
      <PlatformNavigation language={language} incomingReferral={incomingReferral} />
      <main id="zf-content" className="zf-main" tabIndex={-1}>{children}</main>
      <footer className="zf-footer">
        <div className="zf-wrap zf-footer-inner">
          <a href={platformLink('/', language)} className="zf-brand" aria-label="ZEZO Forge">
            <img src="/favicon.svg" width="34" height="34" alt="" />
            <span>ZEZO<span className="zf-brand-dot">.</span><small>Digital Solutions &amp; AI</small></span>
          </a>
          <p>{en ? 'From idea to digital reality.' : 'من الفكرة إلى الواقع الرقمي.'}</p>
          <nav aria-label={en ? 'Footer' : 'روابط أسفل الصفحة'}>
            <a href={platformLink('/contact', language)}>{en ? 'Contact' : 'تواصل معنا'}</a>
            <a href="/team">{en ? 'Team' : 'مساحة الفريق'}</a>
            <a href="https://www.instagram.com/zezo_prime_ai/" rel="noopener noreferrer">Instagram</a>
          </nav>
        </div>
      </footer>
      <PlatformPrivacy language={language} />
    </div>
  );
}
