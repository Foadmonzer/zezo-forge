import type { MetadataRoute } from 'next';
import { getPublicSiteOrigin } from '../src/public-site-origin.js';

export default function sitemap(): MetadataRoute.Sitemap {
  if (process.env.ZEZO_STAGING === 'true') return [];
  return [{
    url: getPublicSiteOrigin(),
    changeFrequency: 'weekly',
    priority: 1
  }];
}
