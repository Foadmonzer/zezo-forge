import type { Metadata } from 'next';

export const zezoShareTitle = 'ZEZO Forge | Digital Solutions & AI';
export const zezoShareDescription = 'من الفكرة إلى الواقع الرقمي — تطوير مواقع وتطبيقات وحلول ذكاء اصطناعي.';
export const zezoShareImage = {
  url: '/assets/zezo-forge-share-v1.jpg',
  width: 1200,
  height: 630,
  type: 'image/jpeg',
  alt: 'ZEZO Forge — من الفكرة إلى الواقع الرقمي',
};

export const privatePageMetadata: Metadata = {
  alternates: null,
  openGraph: null,
  twitter: null,
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: 'no-referrer',
};
