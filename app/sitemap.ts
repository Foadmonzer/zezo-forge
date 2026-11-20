import type { MetadataRoute } from 'next';
import { getPublicSiteOrigin } from '../src/public-site-origin.js';
import { publicHref, publicServices, publicTemplates } from './platform/public-content';

export default function sitemap(): MetadataRoute.Sitemap {
  if (process.env.ZEZO_STAGING === 'true') return [];
  const origin = getPublicSiteOrigin();
  const paths = ['/', '/services', '/templates', '/work', '/reviews', '/about', '/contact', '/request',
    ...publicServices.map(service => `/services/${service.id}`),
    ...publicTemplates.map(template => `/templates/${template.id}`)];
  return paths.map(path => ({
    url: new URL(path, origin).href,
    changeFrequency: 'weekly',
    priority: path === '/' ? 1 : 0.7,
    alternates: { languages: { ar: new URL(path, origin).href, en: new URL(publicHref(path, 'en'), origin).href } }
  }));
}
