import { test, expect } from '@playwright/test';

const imagePath = '/assets/zezo-forge-share-v1.jpg';
const shareTitle = 'ZEZO Forge | Digital Solutions &amp; AI';
const arabicDescription = 'من الفكرة إلى الواقع الرقمي — تطوير مواقع وتطبيقات وحلول ذكاء اصطناعي.';

function htmlHead(html) {
  return html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] || '';
}

test('social crawlers receive one absolute branded card without running JavaScript', async ({ request, baseURL, browserName }) => {
  test.skip(browserName !== 'chromium' || process.env.ZEZO_STAGING_E2E === 'true', 'Server-rendered metadata is tested once outside the gate.');
  for (const userAgent of ['TelegramBot (like TwitterBot)', 'WhatsApp/2.25.0']) {
    for (const path of ['/', '/?utm_source=chatgpt.com']) {
      const response = await request.get(path, { headers: { 'user-agent': userAgent } });
      expect(response.status()).toBe(200);
      const head = htmlHead(await response.text());
      const image = new URL(imagePath, baseURL).href;
      expect(head).toContain(`<meta property="og:image" content="${image}"`);
      expect(head).toContain(`<meta name="twitter:image" content="${image}"`);
      expect(head.match(/property="og:image"/g)).toHaveLength(1);
      expect(head).toContain(`<meta property="og:title" content="${shareTitle}"`);
      expect(head).toContain(`<meta property="og:description" content="${arabicDescription}"`);
      expect(head).toContain(`<meta property="og:url" content="${baseURL}`);
      expect(head).toContain('<meta property="og:image:width" content="1200"');
      expect(head).toContain('<meta property="og:image:height" content="630"');
      expect(head).toContain('<meta property="og:type" content="website"');
      expect(head).not.toContain('utm_source');
      expect(head).not.toContain('zezo-planet-texture');
    }
  }

  const imageResponse = await request.get(imagePath);
  expect(imageResponse.status()).toBe(200);
  expect(imageResponse.headers()['content-type']).toContain('image/jpeg');
  expect((await imageResponse.body()).subarray(0, 2).toString('hex')).toBe('ffd8');

  const template = await request.get('/templates/web-copper-table', { headers: { 'user-agent': 'TelegramBot' } });
  expect(htmlHead(await template.text())).toContain('/assets/templates/web-copper-table.jpg');
});

test('account and team pages do not inherit the public sharing card', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium' || process.env.ZEZO_STAGING_E2E === 'true', 'Server-rendered metadata is tested once outside the gate.');
  for (const path of ['/account', '/account/overview', '/team', '/activate', '/reviews/moderation', '/request?conversation=demo-not-an-account']) {
    const response = await request.get(path, { headers: { 'user-agent': 'TelegramBot' } });
    expect(response.status()).toBe(200);
    const head = htmlHead(await response.text());
    expect(head).toMatch(/<meta name="robots" content="noindex[^"<>]*nosnippet/);
    expect(head).not.toMatch(/(?:property="og:|name="twitter:|rel="canonical"|demo-not-an-account)/);
  }
});
