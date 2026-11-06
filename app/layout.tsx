import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

const staging = process.env.ZEZO_STAGING === 'true';

export const metadata: Metadata = {
  title: 'ZEZO — من الفكرة إلى الواقع الرقمي',
  description: 'من الفكرة إلى الواقع الرقمي. مواقع وتطبيقات وحلول ذكاء اصطناعي من ZEZO Digital Solutions & AI.',
  robots: staging ? { index: false, follow: false, noarchive: true, nosnippet: true } : undefined,
  icons: { icon: '/favicon.svg' }
};

export const viewport: Viewport = { themeColor: '#05070A', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl" data-zezo-staging={staging ? 'true' : undefined}>
      <head>
        <link rel="stylesheet" href="/styles.css" />
        <link rel="stylesheet" href="/templates.css" />
        <link rel="stylesheet" href="/live-demos.css" />
        <link rel="stylesheet" href="/demo-web.css" />
        <link rel="stylesheet" href="/demo-apps.css" />
        <link rel="stylesheet" href="/demo-ai.css" />
        <link rel="stylesheet" href="/demo-ideas.css" />
        <link rel="preload" as="image" href="/assets/zezo-planet-texture.jpg" fetchPriority="high" />
      </head>
      <body>{children}</body>
    </html>
  );
}
