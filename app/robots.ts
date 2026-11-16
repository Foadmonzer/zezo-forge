import type { MetadataRoute } from 'next';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  if (process.env.ZEZO_STAGING === 'true') return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://zezo-forge-fouad.netlify.app/sitemap.xml'
  };
}
