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
  expect(badLogin.headers().location).toBe('/?stagingError=invalid_password');

  // WebKit does not expose Set-Cookie on every navigation response. Verify
  // the server's actual attribute with the independent HTTP test client.
  const cookieResponse = await request.post('/api/staging/login', { form: { password: stagingPassword }, maxRedirects: 0 });
  expect(cookieResponse.status()).toBe(303);
  expect(/(?:^|;\s*)SameSite=Strict(?:;|$)/i.test(cookieResponse.headers()['set-cookie'] || '')).toBe(true);

  const loginResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/staging/login');
  await page.getByLabel('كلمة مرور المعاينة').fill(stagingPassword);
  const [loginResponse] = await Promise.all([
    loginResponsePromise,
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'دخول آمن' }).click()
  ]);
  const loginHeaders = await loginResponse.allHeaders();
  expect(loginResponse.status(), `staging login status=${loginResponse.status()} location=${loginHeaders.location || 'missing'}`).toBe(303);
  expect(loginHeaders.location, 'successful login should stay on the same staging host').toBe('/');
  const cookies = await page.context().cookies();
  const gateCookie = cookies.find(cookie => cookie.name === 'zezo_staging_access');
  expect(gateCookie).toBeTruthy();
  expect(gateCookie.httpOnly).toBe(true);
  expect(gateCookie.path, 'session cookie should be scoped to the site root').toBe('/');
  const pageUrl = new URL(page.url());
  expect(gateCookie.domain.replace(/^\\./, ''), `session cookie domain ${gateCookie.domain} should match page host ${pageUrl.hostname}`).toBe(pageUrl.hostname);
  expect(gateCookie.secure, 'local HTTP browser tests must not receive a Secure-only cookie').toBe(false);
  const browserApiResponse = await page.request.get('/api/public');
  expect(browserApiResponse.status(), 'the browser context should send the issued staging cookie on same-origin requests').toBe(200);
  const authorizedApi = await request.get('/api/public', { headers: { cookie: `zezo_staging_access=${gateCookie.value}` } });
  expect(authorizedApi.status(), 'the server should accept the session cookie minted by the staging login').toBe(200);
  // The form already redirected to '/'. Wait for the protected content in
  // that document instead of racing the dev server with another navigation.
  await expect(page.locator('#zf-content h1')).toBeVisible();
  const protectedHero = page.locator('.zpub-planet img');
  await expect.poll(() => protectedHero.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText('دخول بيئة الاختبار');

  await page.goto('/__staging/logout');
  expect(new URL(page.url()).origin).toBe(pageUrl.origin);
  await expect(page.getByRole('heading', { name: 'دخول بيئة الاختبار' })).toBeVisible();
  const anonymousApiResponse = await page.request.get('/api/public');
  expect(anonymousApiResponse.status(), 'logging out should remove the staging cookie from subsequent browser requests').toBe(401);

  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Disallow: /');
  expect(robots.headers()['x-robots-tag']).toContain('noindex');
});
