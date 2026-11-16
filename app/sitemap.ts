import type { MetadataRoute } from 'next';

const siteUrl = 'https://zezo-forge-fouad.netlify.app';

export default function sitemap(): MetadataRoute.Sitemap {
  if (process.env.ZEZO_STAGING === 'true') return [];
  return [{
    url: siteUrl,
    changeFrequency: 'weekly',
    priority: 1
  }];
}
