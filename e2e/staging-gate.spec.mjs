import { test, expect } from '@playwright/test';

const stagingPassword = 'Synthetic-Staging-Gate-Password-Only';

test('staging gate protects pages, API, and static assets until a secure session is issued', async ({ page, request }) => {
  test.skip(process.env.ZEZO_STAGING_E2E !== 'true', 'Run only in the dedicated staging-gate CI step.');

  const homeResponse = await page.goto('/');
  expect(homeResponse?.status()).toBe(200);
  await expect(page).toHaveTitle('دخول بيئة اختبار ZEZO');
  await expect(page.getByRole('heading', { name: 'دخول بيئة الاختبار' })).toBeVisible();
  expect(homeResponse?.headers()['x-robots-tag']).toContain('noindex');

  const publicApi = await request.get('/api/public');
  expect(publicApi.status()).toBe(401);
  expect((await publicApi.json()).stagingAccessRequired).toBe(true);

  const staticAsset = await request.get('/_next/static/not-a-public-asset.js');
  expect(staticAsset.status()).toBe(200);
  expect(staticAsset.headers()['content-type']).toContain('text/html');
  expect(await staticAsset.text()).toContain('دخول بيئة الاختبار');

  const wrongInternalSecret = await request.post('/api/staging/rate-limit', {
    data: { address: 'synthetic-test' }
  });
  expect(wrongInternalSecret.status()).toBe(404);

  const badLogin = await request.post('/api/staging/login', { form: { password: 'not-the-staging-password' }, maxRedirects: 0 });
  expect(badLogin.status()).toBe(303);
  expect(badLogin.headers().location).toContain('stagingError=invalid_password');

  await page.getByLabel('كلمة مرور المعاينة').fill(stagingPassword);
  await page.getByRole('button', { name: 'دخول آمن' }).click();
  await expect(page.locator('body')).not.toContainText('دخول بيئة الاختبار');

  const cookies = await page.context().cookies();
  const gateCookie = cookies.find(cookie => cookie.name === 'zezo_staging_access');
  expect(gateCookie).toBeTruthy();
  expect(gateCookie.httpOnly).toBe(true);
  expect(gateCookie.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('zezo_staging_access');
  expect(await page.evaluate(async () => (await fetch('/api/public')).status)).toBe(200);

  await page.goto('/__staging/logout');
  await expect(page.getByRole('heading', { name: 'دخول بيئة الاختبار' })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/public')).status)).toBe(401);

  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Disallow: /');
  expect(robots.headers()['x-robots-tag']).toContain('noindex');
});

