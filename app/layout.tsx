import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getPublicSiteOrigin } from '../src/public-site-origin.js';
import { zezoShareDescription, zezoShareImage, zezoShareTitle } from './platform/share-metadata';
import './platform/platform.css';

const staging = process.env.ZEZO_STAGING === 'true';
const publicSiteUrl = getPublicSiteOrigin();
const title = 'ZEZO — من الفكرة إلى الواقع الرقمي';
const description = 'من الفكرة إلى الواقع الرقمي. مواقع وتطبيقات وحلول ذكاء اصطناعي من ZEZO Digital Solutions & AI.';

export const metadata: Metadata = {
  metadataBase: new URL(publicSiteUrl),
  title,
  description,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'ar_AE',
    alternateLocale: ['en_US'],
    siteName: 'ZEZO Digital Solutions & AI',
    title: zezoShareTitle,
    description: zezoShareDescription,
    url: '/',
    images: [zezoShareImage]
  },
  twitter: {
    card: 'summary_large_image',
    title: zezoShareTitle,
    description: zezoShareDescription,
    images: [zezoShareImage]
  },
  robots: staging ? { index: false, follow: false, noarchive: true, nosnippet: true } : undefined,
  icons: { icon: '/favicon.svg' }
};

export const viewport: Viewport = { themeColor: '#05070A', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl" data-zezo-staging={staging ? 'true' : undefined}>
      <head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'ZEZO Digital Solutions & AI',
          url: publicSiteUrl,
          logo: `${publicSiteUrl}/favicon.svg`,
          sameAs: ['https://www.instagram.com/zezo_prime_ai/']
        }).replace(/</g, '\\u003c') }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
