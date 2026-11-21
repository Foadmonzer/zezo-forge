import type { MetadataRoute } from 'next';
import { getPublicSiteOrigin } from '../src/public-site-origin.js';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  if (process.env.ZEZO_STAGING === 'true') return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${getPublicSiteOrigin()}/sitemap.xml`
  };
}
