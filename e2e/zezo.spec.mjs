import { test, expect } from '@playwright/test';
import { request as playwrightRequest } from 'playwright';
import pg from 'pg';
import { provisionFirstOwner } from '../src/server/owner-bootstrap.js';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';

const widths = [375, 390, 768, 1366, 1440];
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

async function templateIds() {
  const source = await readFile(new URL('../public/template-catalog.js', import.meta.url), 'utf8');
  return [...source.matchAll(/^\['([^']+)','(?:web|apps|ai|ideas)'/gm)].map(match => match[1]);
}

async function waitForZezoApp(page) {
  await expect(page.locator('html')).toHaveAttribute('data-zezo-app-ready', 'true', { timeout: 30_000 });
}

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bits = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function loginThroughUI(page, { username, password, accountType = 'employee', mfaCode }) {
  await page.goto('/team');
  await waitForZezoApp(page);
  const form = accountType === 'management' ? '#managerLoginForm' : '#employeeLoginForm';
  await page.locator(`${form} input[name="username"]`).fill(username);
  await page.locator(`${form} input[name="password"]`).fill(password);
  await page.locator(`${form} button[type="submit"]`).click();
  if (mfaCode) {
    await expect(page.locator('#managerMfaField')).toBeVisible();
    await page.locator(`${form} input[name="mfaCode"]`).fill(mfaCode);
    await page.locator(`${form} button[type="submit"]`).click();
  }
  await expect(page.locator('#dashboardBackdrop.open')).toBeVisible();
}

async function measureDashboardAction(page, path, method, action, verifyUi, { waitDashboard = false, controlledNetworkDelayMs = 0 } = {}) {
  const clickAt = Date.now();
  let requestAt = 0;
  const onRequest = request => {
    if (new URL(request.url()).pathname === path && request.method() === method) requestAt = Date.now();
  };
  page.on('request', onRequest);
  if (waitDashboard) await page.evaluate(() => {
    window.__zezoDashboardMutationCount = 0;
    window.__zezoDashboardMutationObserver?.disconnect();
    window.__zezoDashboardMutationObserver = new MutationObserver(() => window.__zezoDashboardMutationCount++);
    window.__zezoDashboardMutationObserver.observe(document.querySelector('#dashboardContent'), { childList: true, subtree: true, characterData: true });
  });
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === path && response.request().method() === method
  );
  const dashboardPromise = waitDashboard ? page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/dashboard' && response.request().method() === 'GET' && response.ok()
  ) : null;
  try {
    await action();
    const response = await responsePromise;
    const responseAt = Date.now();
    if (!response.ok()) throw new Error(`Dashboard action failed: ${response.status()} ${method} ${path}`);
    if (dashboardPromise) {
      await dashboardPromise;
      await page.waitForFunction(() => window.__zezoDashboardMutationCount > 0);
    }
    await verifyUi();
    const uiAt = Date.now();
    const timing = {
      path, method,
      clickToApiMs: requestAt ? Number((requestAt - clickAt).toFixed(1)) : null,
      apiMs: requestAt ? Number((responseAt - requestAt).toFixed(1)) : null,
      responseToUiMs: Number((uiAt - responseAt).toFixed(1)),
      clickToUiMs: Number((uiAt - clickAt).toFixed(1)),
      controlledNetworkDelayMs
    };
    console.log(`[DASHBOARD_ACTION_TIMING] ${JSON.stringify(timing)}`);
    return timing;
  } finally {
    page.off('request', onRequest);
  }
}

async function workspaceViewportMatrix(page, tab, name, testInfo) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator(`#dashboardTabs [data-dash-tab="${tab}"]`).click();
    await expect(page.locator('#dashboardBackdrop.open')).toBeVisible();
    const bounds = await page.evaluate(() => {
      const rect = document.querySelector('.dashboard').getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        left: rect.left,
        right: rect.right,
        contentWidth: document.querySelector('#dashboardContent')?.scrollWidth || 0,
        contentViewport: document.querySelector('#dashboardContent')?.clientWidth || 0,
        dashboardWidth: document.querySelector('.dashboard')?.getBoundingClientRect().width || 0,
        layoutWidth: document.querySelector('.dashboard-layout')?.getBoundingClientRect().width || 0,
        contentRectWidth: document.querySelector('#dashboardContent')?.getBoundingClientRect().width || 0,
        notes: [...document.querySelectorAll('#dashboardContent .subtle-note')].map(note => {
          const style = getComputedStyle(note);
          const rect = note.getBoundingClientRect();
          return { width: note.clientWidth, rectWidth: rect.width, left: rect.left, right: rect.right, scroll: note.scrollWidth, whiteSpace: style.whiteSpace, wrap: style.overflowWrap };
        })
      };
    });
    expect(bounds.page, `${name} page overflow at ${width}px`).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.left, `${name} workspace clipped on the left at ${width}px`).toBeGreaterThanOrEqual(-1);
    expect(bounds.right, `${name} workspace clipped on the right at ${width}px`).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.layoutWidth, `${name} dashboard grid expanded past its container at ${width}px`).toBeLessThanOrEqual(bounds.dashboardWidth + 1);
    expect(bounds.contentRectWidth, `${name} content column expanded past the dashboard grid at ${width}px`).toBeLessThanOrEqual(bounds.layoutWidth + 1);
    expect(bounds.contentWidth, `${name} dashboard content overflows internally at ${width}px`).toBeLessThanOrEqual(bounds.contentViewport + 1);
    expect(bounds.notes.some(note => note.scroll > note.width), `${name} dashboard text is clipped at ${width}px`).toBe(false);
    expect(bounds.notes.some(note => note.rectWidth > bounds.contentRectWidth + 1), `${name} helper text extends past the content column at ${width}px`).toBe(false);
    if (name === 'owner-projects' && width === 390) console.log(`[MOBILE_NOTE_LAYOUT] ${JSON.stringify(bounds)}`);
    await page.screenshot({ path: testInfo.outputPath(`workspace-${name}-${width}.png`) });
  }
}

test('browser navigation works in Chromium, Firefox, and WebKit', async ({ page, browserName }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#zf-content h1')).toBeVisible();
  await expect(page.locator('script[src="/app.js"]')).toHaveCount(0);
  await page.goto('/templates?lang=en');
  await expect(page.getByRole('heading', { name: 'Template library' })).toBeVisible();
  await expect(page.locator('.zezo-platform')).toHaveAttribute('dir', 'ltr');
  await page.goto('/?preview=web-thread-studio', { waitUntil: 'domcontentloaded' });
  await waitForZezoApp(page);
  await expect(page.locator('#templatePreviewApp .template-preview-shell h1')).toBeVisible();
  await expect(page.locator('#templatePreviewApp .template-preview-actions a')).toHaveCount(2);
  await page.locator('#templatePreviewLanguage').click();
  await expect(page.locator('#templatePreviewApp .template-preview-shell')).toHaveCSS('direction', 'ltr');
  expect(errors, `${browserName} reported browser errors`).toEqual([]);
});

test('responsive page layouts, navigation, and screenshots at requested widths', async ({ page, browserName }, testInfo) => {
  test.setTimeout(240_000);
  test.skip(browserName !== 'chromium', 'Viewport screenshot matrix is run in Chromium; cross-browser navigation runs separately.');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const pages = [
    { name: 'home', url: '/' },
    { name: 'templates', url: '/templates' },
    { name: 'services', url: '/services' },
    { name: 'service-detail', url: '/services/web' },
    { name: 'template-detail', url: '/templates/web-copper-table' },
    { name: 'request', url: '/request?template=web-copper-table' },
    { name: 'work', url: '/work' },
    { name: 'reviews', url: '/reviews' },
    { name: 'about', url: '/about' },
    { name: 'contact', url: '/contact' },
    { name: 'account', url: '/account' },
    { name: 'team', url: '/team' },
    { name: 'template-web-thread-studio', url: '/?preview=web-thread-studio' }
  ];
  for (const width of widths) {
    for (const route of pages) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route.url);
      if (route.name === 'team') await expect(page.locator('#authModal')).toHaveAttribute('aria-hidden', 'false');
      else if (route.name === 'template-web-thread-studio') await expect(page.locator('#templatePreviewApp .template-preview-shell')).toBeVisible();
      else await expect(page.locator('#zf-content h1')).toBeVisible();

      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      expect(dimensions.content, `${route.name} has horizontal overflow at ${width}px (${JSON.stringify(dimensions)})`).toBeLessThanOrEqual(dimensions.viewport + 1);
      await page.screenshot({ path: testInfo.outputPath(`${route.name}-${width}.png`), fullPage: route.name === 'templates' });
    }
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'افتح القائمة' });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.locator('#zf-navigation')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-navigation-375.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await menu.click();
  await page.locator('#zf-navigation a[href="/templates"]').click();
  await expect(page).toHaveURL(/\/templates$/);
  await expect(page.locator('#zf-navigation')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('the mobile recovery form stays actionable while the privacy choice is pending', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Mobile stacking check runs once in Chromium.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#resetPassword=${'A'.repeat(43)}`);
  await expect(page).toHaveURL(/\/account(?:#.*)?$/);
  await expect(page.locator('.zf-privacy')).toBeVisible();
  await expect(page.getByLabel('كلمة المرور الجديدة (12 خانة على الأقل)')).toBeVisible();
  await page.locator('.zc-form button').click({ trial: true });
});

test('all 40 catalog templates open and both request actions route to the correct template', async ({ page, browserName }, testInfo) => {
  test.setTimeout(240_000);
  test.skip(browserName !== 'chromium', 'The 40-template sweep runs once in Chromium.');
  const ids = await templateIds();
  expect(ids).toHaveLength(40);
  await page.goto('/classic#templates');
  await expect(page.locator('#templateGrid .template-card')).toHaveCount(40);

  const report = [];
  for (const id of ids) {
    await page.goto(`/?preview=${encodeURIComponent(id)}`);
    const shell = page.locator('#templatePreviewApp .template-preview-shell');
    await expect(shell, `${id} preview`).toBeVisible();
    await expect(shell.locator('h1').first()).not.toBeEmpty();
    const order = shell.locator('.template-preview-actions a').nth(0);
    const customize = shell.locator('.template-preview-actions a').nth(1);
    await expect(order).toHaveAttribute('href', new RegExp(`templateRequest=${id}.*templateAction=order`));
    await expect(customize).toHaveAttribute('href', new RegExp(`templateRequest=${id}.*templateAction=customize`));
    if (['web-copper-table', 'web-thread-studio', 'web-luma-clinic', 'app-daygrid', 'ai-helio-desk', 'idea-business-canvas'].includes(id)) {
      await page.screenshot({ path: testInfo.outputPath(`template-${id}.png`), fullPage: true });
    }
    report.push(id);
  }
  expect(report).toHaveLength(40);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/classic#templates');
  for (const id of ids) {
    for (const action of ['order', 'customize']) {
      const requestButton = page.locator(`[data-template-id="${id}"] [data-template-request="${id}"][data-template-action="${action}"]`);
      await requestButton.click();
      await expect(page.locator('#templateOrderModal.open')).toBeVisible();
      await expect(page.locator('#templateOrderTitle')).not.toBeEmpty();
      await expect(page.locator('#templateOrderPrice')).toContainText('200');
      await expect(page.locator('#templateOrderModal [data-order-channel="chat"]')).toBeVisible();
      await expect(page.locator('#templateOrderModal [data-order-channel="whatsapp"]')).toBeVisible();
      await page.locator('#templateOrderModal [data-close-template-order]').click();
    }
  }
});

test('customer, Order Manager, developer, marketer, and Owner complete a synthetic browser journey', async ({ page, browser, request, browserName }, testInfo) => {
  test.setTimeout(240_000);
  test.skip(browserName !== 'chromium', 'Stateful synthetic business journey runs once in Chromium.');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const ownerUsername = `e2e_owner_${suffix}`;
  const ownerTemporary = `Owner!${suffix}Temporary2026`;
  const ownerPassword = `Owner!${suffix}Changed2026`;
  const ownerApi = await playwrightRequest.newContext({ baseURL });

  const ownerDb = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'zezo-playwright-owner-bootstrap' });
  await ownerDb.connect();
  const provisionedOwner = await provisionFirstOwner({
    client: ownerDb,
    name: 'Synthetic E2E Owner',
    username: ownerUsername,
    email: `${ownerUsername}@example.test`,
    password: ownerTemporary,
  });
  await ownerDb.end();
  expect(provisionedOwner.mustChangePassword).toBe(true);
  const bootstrapLogin = await json(await ownerApi.post('/api/auth/login', { data: { username: ownerUsername, password: ownerTemporary, accountType: 'management' } }));
  expect(bootstrapLogin.user.role).toBe('admin');
  await json(await ownerApi.post('/api/auth/password', { data: { currentPassword: ownerTemporary, newPassword: ownerPassword } }));
  const ownerLogin = await json(await ownerApi.post('/api/auth/login', { data: { username: ownerUsername, password: ownerPassword, accountType: 'management' } }));
  const ownerMfa = await json(await ownerApi.get('/api/auth/mfa/setup'));
  await json(await ownerApi.post('/api/auth/mfa/enable', { data: { code: totp(ownerMfa.secret) } }));
  const ownerSecure = await json(await ownerApi.post('/api/auth/login', { data: { username: ownerUsername, password: ownerPassword, accountType: 'management', mfaCode: totp(ownerMfa.secret) } }));
  expect(ownerLogin.user.role).toBe('admin');
  expect(ownerSecure.user.mfaEnabled).toBe(true);

  async function createEmployee(role) {
    const username = `e2e_${role}_${suffix}`;
    const password = `Staff!${role}${suffix}2026`;
    const invite = await json(await ownerApi.post('/api/admin/invite', { data: {
      name: `Synthetic ${role}`, username, email: `${username}@example.test`, role
    } }));
    const activationApi = await playwrightRequest.newContext({ baseURL });
    const activation = await json(await activationApi.post('/api/auth/activate', { data: { token: invite.activationToken, password } }));
    let mfaSecret = '';
    if (['hr_manager', 'marketing_manager', 'order_manager'].includes(role)) {
      const mfa = await json(await activationApi.get('/api/auth/mfa/setup'));
      mfaSecret = mfa.secret;
      await json(await activationApi.post('/api/auth/mfa/enable', { data: { code: totp(mfa.secret) } }));
    }
    await activationApi.dispose();
    return { id: activation.user.id, username, password, mfaSecret };
  }

  const orderManager = await createEmployee('order_manager');
  const developer = await createEmployee('developer');
  const marketer = await createEmployee('marketer');
  const marketerApi = await playwrightRequest.newContext({ baseURL });
  await json(await marketerApi.post('/api/auth/login', { data: { username: marketer.username, password: marketer.password, accountType: 'employee' } }));
  const marketerDashboard = await json(await marketerApi.get('/api/dashboard'));
  const referralCode = marketerDashboard.user.referralCode;
  expect(referralCode).toBeTruthy();
  const ownerNotifications = await json(await ownerApi.get('/api/notifications?limit=100'));
  const activationNotices = ownerNotifications.notifications.filter(item => item.titleEn === 'An employee activated an account');
  expect(activationNotices.length).toBeGreaterThanOrEqual(3);
  const crossAccountRead = await marketerApi.patch(`/api/notifications/${encodeURIComponent(activationNotices[0].id)}`);
  expect(crossAccountRead.status()).toBe(404);
  await marketerApi.dispose();

  // A team session left in the browser must not expose its notifications while
  // a visitor is composing a client request; switching accounts must sign it out.
  const staffSwitchPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const staffSessionApi = await playwrightRequest.newContext({ baseURL });
  const staffLoginResponse = await staffSessionApi.post('/api/auth/login', {
    data: { username: marketer.username, password: marketer.password, accountType: 'employee' }
  });
  expect(staffLoginResponse.status()).toBe(200);
  const staffSessionCookie = staffLoginResponse.headers()['set-cookie']?.match(/(?:^|[,;]\s*)zezo_session=([^;,\s]+)/)?.[1];
  expect(staffSessionCookie).toBeTruthy();
  const browserOrigin = new URL(baseURL);
  await staffSwitchPage.context().addCookies([{
    name: 'zezo_session', value: staffSessionCookie, domain: browserOrigin.hostname, path: '/',
    httpOnly: true, secure: browserOrigin.protocol === 'https:', sameSite: 'Lax'
  }]);
  await staffSwitchPage.goto('/classic');
  await waitForZezoApp(staffSwitchPage);
  await expect(staffSwitchPage.locator('#notificationBell')).toBeHidden();
  const staffConversationPosts = [];
  const observeStaffConversationPost = request => {
    if (new URL(request.url()).pathname === '/api/conversations' && request.method() === 'POST') staffConversationPosts.push(request);
  };
  staffSwitchPage.on('request', observeStaffConversationPost);
  await staffSwitchPage.locator('#templateGrid').scrollIntoViewIfNeeded();
  await staffSwitchPage.locator('[data-template-id="web-copper-table"] [data-template-request][data-template-action="order"]').click();
  await staffSwitchPage.locator('#templateOrderModal [data-order-channel="chat"]').click();
  await staffSwitchPage.locator('#conversationStartForm [name="message"]').fill('Synthetic request composed while a marketer session is active.');
  await staffSwitchPage.locator('#conversationStartForm button[type="submit"]').click();
  await expect(staffSwitchPage.locator('#authModal.open')).toBeVisible();
  await expect(staffSwitchPage.locator('#clientSessionNotice')).toBeVisible();
  await expect(staffSwitchPage.locator('#clientIntentNotice')).toBeVisible();
  await expect(staffSwitchPage.locator('#notificationBell')).toBeHidden();
  expect(staffConversationPosts).toHaveLength(0);
  await staffSwitchPage.locator('#switchToClientAccount').click();
  await expect(staffSwitchPage.locator('#dashboardBackdrop.open')).toHaveCount(0);
  const afterStaffLogout = await staffSwitchPage.evaluate(async () => {
    const response = await fetch('/api/notifications?limit=8', { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(afterStaffLogout.status).toBe(401);
  await expect(staffSwitchPage.locator('#notificationBell')).toBeHidden();
  await Promise.all([staffSwitchPage.close(), staffSessionApi.dispose()]);

  // Reproduce the visitor journey from a clean page: keep the referral, template,
  // and message until the visitor creates a client account, then create one chat.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`/classic?ref=${encodeURIComponent(referralCode)}`);
  await waitForZezoApp(page);
  await expect(page.locator('#notificationBell')).toBeHidden();
  const anonymousNotifications = await page.evaluate(async () => {
    const response = await fetch('/api/notifications?limit=8', { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(anonymousNotifications.status).toBe(401);
  expect(anonymousNotifications.body.authenticated).not.toBe(true);
  const attributionResponse = await page.evaluate(async () => {
    const response = await fetch('/api/referral-attribution', { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(attributionResponse.status).toBe(200);
  expect(attributionResponse.body).toMatchObject({ attributed: true, code: referralCode });
  const attributionCookie = (await page.context().cookies(baseURL)).find(item => item.name === 'zezo_referral_attribution');
  expect(attributionCookie?.httpOnly).toBe(true);
  expect(attributionCookie?.sameSite).toBe('Lax');
  if (baseURL.startsWith('https://')) expect(attributionCookie?.secure).toBe(true);

  const referralDb = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'zezo-playwright-referral-verification' });
  await referralDb.connect();
  const conversationCountBefore = Number((await referralDb.query('SELECT count(*)::int AS count FROM conversations')).rows[0]?.count || 0);
  const anonymousConversationPosts = [];
  const observeConversationPost = request => {
    if (new URL(request.url()).pathname === '/api/conversations' && request.method() === 'POST') anonymousConversationPosts.push(request);
  };
  page.on('request', observeConversationPost);
  await page.locator('#templateGrid').scrollIntoViewIfNeeded();
  await page.locator('[data-template-id="web-copper-table"] [data-template-request][data-template-action="order"]').click();
  await page.locator('#templateOrderModal [data-order-channel="chat"]').click();
  const initialQuestion = 'Synthetic anonymous browser question about the restaurant template.';
  await page.locator('#conversationStartForm [name="message"]').fill(initialQuestion);
  await page.locator('#conversationStartForm button[type="submit"]').click();
  await expect(page.locator('#authModal.open')).toBeVisible();
  await expect(page.locator('#customerChoicePanel [data-customer-view="login"]')).toBeVisible();
  await expect(page.locator('#customerChoicePanel [data-customer-view="register"]')).toBeVisible();
  await expect(page.locator('#clientIntentNotice')).toContainText('لم تُرسل بعد');
  await page.screenshot({ path: testInfo.outputPath('guest-referral-auth-choice.png'), fullPage: true });
  expect(anonymousConversationPosts).toHaveLength(0);
  expect(Number((await referralDb.query('SELECT count(*)::int AS count FROM conversations')).rows[0]?.count || 0)).toBe(conversationCountBefore);
  page.off('request', observeConversationPost);
  await page.locator('#customerChoicePanel [data-customer-view="register"]').click();
  await expect(page.locator('#referralAttributionNotice')).toBeVisible();
  await expect(page.locator('#referralAttributionNotice')).toContainText(referralCode);
  await page.locator('#clientRegisterForm [name="name"]').fill('Synthetic Browser Customer');
  await page.locator('#clientRegisterForm [name="email"]').fill(`e2e_customer_${suffix}@example.test`);
  const customerPassword = `Customer!${suffix}Password2026`;
  await page.locator('#clientRegisterForm [name="password"]').fill(customerPassword);
  await page.locator('#clientRegisterForm [name="confirmPassword"]').fill(customerPassword);
  await page.locator('#clientRegisterForm button[type="submit"]').click();
  await expect(page.locator('#conversationModal.open')).toBeVisible();
  await expect(page.locator('#conversationMessages')).toContainText(initialQuestion);
  await expect(page.locator('#clientIntentNotice')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('guest-referral-conversation-created.png'), fullPage: true });
  expect((await page.context().cookies(baseURL)).some(item => item.name === 'zezo_referral_attribution')).toBe(false);
  const customerDashboard = await page.evaluate(async () => {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    return response.ok ? response.json() : null;
  });
  const customerId = customerDashboard?.user?.id;
  expect(customerId).toBeTruthy();
  const savedAttribution = await referralDb.query(
    'SELECT data ->> $2 AS value FROM user_accounts WHERE id = $1', [customerId, 'referralUserId']
  );
  const signupEvent = await referralDb.query(
    'SELECT COUNT(*)::int AS count FROM referral_events WHERE "userId" = $1 AND "eventType" = $2 AND "resourceId" = $3',
    [marketer.id, 'client_signup', customerId]
  );
  expect(savedAttribution.rows[0]?.value).toBe(marketer.id);
  expect(signupEvent.rows[0]?.count).toBe(1);
  const persistedConversation = await referralDb.query(`
    SELECT c."customerId", c.data ->> 'referralUserId' AS referral_user,
      c.data ->> 'referralCode' AS referral_code, m.body
    FROM conversations c JOIN conversation_messages m ON m."conversationId" = c.id
    WHERE c."customerId" = $1 AND m.body = $2
  `, [customerId, initialQuestion]);
  expect(persistedConversation.rows).toHaveLength(1);
  expect(persistedConversation.rows[0]).toMatchObject({
    customerId,
    referral_user: marketer.id,
    referral_code: referralCode,
    body: initialQuestion
  });
  const marketerJourneyApi = await playwrightRequest.newContext({ baseURL });
  await json(await marketerJourneyApi.post('/api/auth/login', { data: { username: marketer.username, password: marketer.password, accountType: 'employee' } }));
  const signupDashboard = await json(await marketerJourneyApi.get('/api/dashboard'));
  expect(signupDashboard.referralMetrics.signups).toBe(1);
  expect(signupDashboard.referredClients).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: customerId, name: 'Synthetic Browser Customer', requestCount: 0 })
  ]));
  expect(JSON.stringify(signupDashboard.referredClients)).not.toContain(`e2e_customer_${suffix}@example.test`);
  expect(JSON.stringify(signupDashboard.referredClients)).not.toContain('501234567');

  // Continue the authenticated chat, then verify it survives logout and login.
  await page.locator('#conversationReplyForm [name="message"]').fill('Synthetic customer follow-up message.');
  await page.locator('#conversationReplyForm button[type="submit"]').click();
  await expect(page.locator('#conversationMessages')).toContainText('Synthetic customer follow-up message');
  await page.locator('#conversationModal [data-close-conversation]').click();
  await page.locator('.login-open').click();
  await expect(page.locator('#dashboardBackdrop.open')).toBeVisible();
  await page.locator('#dashboardLogout').click();
  await expect(page.locator('#dashboardBackdrop.open')).toHaveCount(0);
  await page.locator('.login-open').click();
  await page.locator('#customerChoicePanel [data-customer-view="login"]').click();
  await page.locator('#clientLoginForm [name="username"]').fill(`e2e_customer_${suffix}@example.test`);
  await page.locator('#clientLoginForm [name="password"]').fill(customerPassword);
  await page.locator('#clientLoginForm button[type="submit"]').click();
  await expect(page.locator('#dashboardBackdrop.open')).toBeVisible();
  const conversationResponse = await page.evaluate(async () => {
    const res = await fetch('/api/conversations');
    return res.ok ? res.json() : null;
  });
  expect(conversationResponse?.conversations).toHaveLength(1);
  const conversationId = conversationResponse.conversations[0].id;

  // An Owner assigns the conversation. The Order Manager responds and drafts a quote through the UI.
  await json(await ownerApi.patch(`/api/conversations/${encodeURIComponent(conversationId)}`, { data: { assignedUserId: orderManager.id } }));
  const orderPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(orderPage, { username: orderManager.username, password: orderManager.password, accountType: 'management', mfaCode: totp(orderManager.mfaSecret) });
  await orderPage.locator('[data-dash-tab="conversations"]').click();
  const staffConversation = orderPage.locator('details.conversation-staff-card').filter({ hasText: 'مطعم السعادة' });
  await expect(staffConversation).toBeVisible();
  await staffConversation.locator(':scope > summary').click();
  await staffConversation.locator(`[data-conversation-reply="${conversationId}"] textarea[name="message"]`).fill('Synthetic Order Manager response.');
  await measureDashboardAction(orderPage, `/api/conversations/${encodeURIComponent(conversationId)}/messages`, 'POST', () =>
    staffConversation.locator(`[data-conversation-reply="${conversationId}"] button[type="submit"]`).click(),
  async () => expect(staffConversation).toContainText('Synthetic Order Manager response.', { timeout: 30_000 }), { waitDashboard: true });
  const quoteEditor = staffConversation.locator('details.conversation-quote-editor');
  // The saved reply refreshes the dashboard markup; explicitly expand both native details panes afterward.
  await staffConversation.evaluate(element => { element.open = true; });
  await quoteEditor.evaluate(element => { element.open = true; });
  await expect(quoteEditor.locator('[name="amount"]')).toBeVisible();
  await quoteEditor.locator('[name="amount"]').fill('200');
  await quoteEditor.locator('[name="scope"]').fill('Single responsive ZEZO restaurant website scope for browser acceptance tests.');
  await quoteEditor.locator('[name="included"]').fill('One responsive landing page and contact details.');
  await measureDashboardAction(orderPage, `/api/conversations/${encodeURIComponent(conversationId)}/quote`, 'POST', () =>
    quoteEditor.locator('button[type="submit"]').click(),
  async () => expect(staffConversation).toContainText('200'), { waitDashboard: true });
  await workspaceViewportMatrix(orderPage, 'conversations', 'order-manager', testInfo);
  await orderPage.close();

  // The customer reloads the saved conversation, accepts the quote, and sends a formal request.
  await page.reload();
  await waitForZezoApp(page);
  await page.locator('.login-open').click();
  await expect(page.locator('#dashboardBackdrop.open')).toBeVisible();
  await page.locator('[data-dash-tab="conversations"]').click();
  await page.locator('[data-open-customer-conversation]').first().click();
  await expect(page.locator('[data-conversation-accept-quote]')).toBeVisible();
  await page.locator('[data-conversation-accept-quote]').click();
  await expect(page.locator('#conversationQuote')).toContainText('قُبل العرض');
  await page.locator('#conversationOfficialOrder').click();
  await page.locator('#projectForm [name="whatsappCountryCode"]').selectOption('+971');
  await page.locator('#projectForm [name="whatsappLocalNumber"]').fill('501234567');
  await page.locator('#projectForm [name="budget"]').selectOption('100–300 ILS');
  await page.locator('#projectForm [name="consent"]').check();
  await page.locator('#projectForm .form-submit').click();
  await expect(page.locator('#formResult')).toContainText('متابعة الطلب', { timeout: 30_000 });
  const orderResult = await page.evaluate(async () => {
    const res = await fetch('/api/dashboard');
    const data = await res.json();
    return data.orders?.[0] || null;
  });
  expect(orderResult?.id).toBeTruthy();
  const leadId = orderResult.id;
  const savedRequestAttribution = await referralDb.query(
    'SELECT "referrerId", data ->> $2 AS referral_user_id, data ->> $3 AS referral_code FROM project_requests WHERE id = $1',
    [leadId, 'referralUserId', 'referralCode']
  );
  expect(savedRequestAttribution.rows[0]?.referrerId).toBe(marketer.id);
  expect(savedRequestAttribution.rows[0]?.referral_user_id).toBe(marketer.id);
  expect(savedRequestAttribution.rows[0]?.referral_code).toBe(referralCode);
  const marketerAfterRequest = await json(await marketerJourneyApi.get('/api/dashboard'));
  expect(marketerAfterRequest.leads.some(lead => lead.id === leadId)).toBe(true);
  expect(marketerAfterRequest.referredClients[0]?.requestCount).toBe(1);

  // Owner: assign developer and record a synthetic, verified manual payment in the UI.
  const ownerPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(ownerPage, { username: ownerUsername, password: ownerPassword, accountType: 'management', mfaCode: totp(ownerMfa.secret) });
  await expect(ownerPage.locator('#dashboardTabs .dashboard-nav-group')).toHaveCount(5);
  await expect(ownerPage.locator('#dashboardTabs')).toContainText('العملاء والطلبات');
  await expect(ownerPage.locator('#dashboardTabs')).toContainText('الفريق والإحالات');
  const ownerDashboardWidth = await ownerPage.locator('.dashboard').evaluate(element => element.getBoundingClientRect().width);
  expect(ownerDashboardWidth).toBeGreaterThan(1300);
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await expect(ownerPage.locator('[data-dash-tab="overview"]')).toBeVisible();
  expect(await ownerPage.locator('.dashboard').evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
  await ownerPage.setViewportSize({ width: 1366, height: 900 });
  await ownerPage.locator('[data-dash-tab="ranks"]').click();
  await expect(ownerPage.locator('#dashboardContent')).toContainText('20%');
  await expect(ownerPage.locator('#dashboardContent')).toContainText('35%');
  await expect(ownerPage.locator('#dashboardContent')).toContainText('80+');
  await expect(ownerPage.locator('#dashboardContent')).toContainText('إشعاراتها الداخلية في ZEZO بشكل مستقل عن البريد');
  await ownerPage.locator('[data-dash-tab="marketing"]').click();
  await expect(ownerPage.locator('#dashboardContent')).toContainText('لا ينشر تلقائياً على Instagram أو Facebook');
  await ownerPage.locator('[data-dash-tab="team"]').click();
  const inviteForm = ownerPage.locator('#inviteForm');
  const inviteName = `Synthetic UI Invite ${suffix}`;
  const inviteUsername = `e2e_ui_invite_${suffix}`;
  await inviteForm.locator('[name="name"]').fill(inviteName);
  await inviteForm.locator('[name="username"]').fill(inviteUsername);
  await inviteForm.locator('[name="email"]').fill(`${inviteUsername}@example.test`);
  await inviteForm.locator('[name="role"]').selectOption('marketer');
  // The owner workspace fills mobile and desktop viewports, so an outside
  // backdrop click may not exist. If there is an outside target, verify it does
  // not discard the unsaved form; otherwise verify the full-screen layout.
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  let dashboardReadsAfterUnsavedInput = 0;
  ownerPage.on('request', request => {
    if (new URL(request.url()).pathname === '/api/dashboard' && request.method() === 'GET') dashboardReadsAfterUnsavedInput++;
  });
  const outsideDashboardPoint = await ownerPage.evaluate(() => {
    const panel = document.querySelector('.dashboard').getBoundingClientRect();
    const bounds = document.querySelector('#dashboardBackdrop').getBoundingClientRect();
    const candidates = [
      [bounds.left + 2, bounds.top + 2],
      [bounds.right - 2, bounds.top + 2],
      [bounds.left + 2, bounds.bottom - 2],
      [bounds.right - 2, bounds.bottom - 2]
    ];
    return candidates.find(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !(x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom)) || null;
  });
  if (outsideDashboardPoint) {
    await ownerPage.mouse.click(outsideDashboardPoint[0], outsideDashboardPoint[1]);
  } else {
    const bounds = await ownerPage.locator('.dashboard').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
    expect(bounds.right).toBe(bounds.width);
    expect(bounds.bottom).toBe(bounds.height);
  }
  await expect(ownerPage.locator('#dashboardBackdrop.open')).toBeVisible();
  await expect(inviteForm.locator('[name="name"]')).toHaveValue(inviteName);
  await expect(inviteForm.locator('[name="username"]')).toHaveValue(inviteUsername);
  expect(dashboardReadsAfterUnsavedInput).toBe(0);
  await ownerPage.setViewportSize({ width: 1366, height: 900 });
  let uiInviteRequests = 0;
  ownerPage.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/invite' && request.method() === 'POST') uiInviteRequests++; });
  await ownerPage.route('**/api/admin/invite', async route => {
    await new Promise(resolve => setTimeout(resolve, 350));
    await route.continue();
  });
  await measureDashboardAction(ownerPage, '/api/admin/invite', 'POST', async () => {
    await inviteForm.locator('button[type="submit"]').click();
    await expect(inviteForm.locator('button[type="submit"]')).toBeDisabled();
    await expect(inviteForm.locator('button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
    await expect(ownerPage.locator('.zezo-submit-status')).toContainText('جارٍ تنفيذ العملية');
    await ownerPage.evaluate(() => document.querySelector('#inviteForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  }, async () => {
    await expect(ownerPage.locator('#inviteResult a[href*="/activate?token="]')).toBeVisible();
  }, { controlledNetworkDelayMs: 350 });
  expect(uiInviteRequests).toBe(1);
  await ownerPage.unroute('**/api/admin/invite');

  const uiInviteId = await ownerPage.evaluate(async username => {
    const response = await fetch('/api/dashboard');
    const dashboard = await response.json();
    return dashboard.invitations?.find(invitation => invitation.username === username)?.id || '';
  }, inviteUsername);
  expect(uiInviteId).toBeTruthy();
  // A successful invitation displays its one-time link immediately; the list
  // is refreshed on the next page load. Exercise the visible revoke/reissue UI.
  await ownerPage.reload();
  await waitForZezoApp(ownerPage);
  await ownerPage.locator('[data-dash-tab="team"]').click();
  const revokeButton = ownerPage.locator(`[data-invitation-action="revoked"][data-invitation-id="${uiInviteId}"]`);
  await expect(revokeButton).toBeVisible();
  await revokeButton.click();
  const resendButton = ownerPage.locator(`[data-invitation-resend="${uiInviteId}"][data-invitation-status="revoked"]`);
  // The revoke click starts an async API call; wait for its refreshed status
  // before reissuing, otherwise a pending invite still opens a confirmation.
  await expect(resendButton).toBeVisible();
  const resendPath = `/api/admin/invitations/${encodeURIComponent(uiInviteId)}/resend`;
  // Keep the server response pending long enough to assert the visible busy
  // state; the synthetic database can otherwise finish before Playwright's
  // next locator check runs.
  await ownerPage.route(`**${resendPath}`, async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.continue();
  });
  await measureDashboardAction(ownerPage, resendPath, 'POST', async () => {
    await resendButton.click();
    await expect(resendButton).toBeDisabled();
    await expect(resendButton).toHaveAttribute('aria-busy', 'true');
    await expect(ownerPage.locator('#inviteResult [role="status"]')).toContainText('جارٍ إصدار رابط تفعيل جديد');
  }, async () => {
    await expect(ownerPage.locator('#inviteResult a[href*="/activate?token="]')).toBeVisible();
    await expect(ownerPage.locator('#inviteResult [data-copy-invite]')).toBeVisible();
  });
  await ownerPage.unroute(`**${resendPath}`);

  await ownerPage.locator('[data-dash-tab="permissions"]').click();
  const permissionForm = ownerPage.locator(`[data-permission-form="${marketer.id}"]`);
  await expect(permissionForm).toBeVisible();
  await permissionForm.locator('[name="perm_conversations.read"]').selectOption('assigned');
  await measureDashboardAction(ownerPage, `/api/admin/permissions/${encodeURIComponent(marketer.id)}`, 'PATCH', async () => {
    await permissionForm.locator('button[type="submit"]').click();
    await expect(permissionForm.locator('button[type="submit"]')).toBeDisabled();
    await expect(ownerPage.locator('.zezo-submit-status')).toContainText('جارٍ تنفيذ العملية');
  }, async () => {
    await expect(ownerPage.locator(`[data-permission-form="${marketer.id}"] [name="perm_conversations.read"]`)).toHaveValue('assigned');
  }, { waitDashboard: true });

  await ownerPage.locator('[data-dash-tab="requests"]').click();
  const leadCard = ownerPage.locator(`[data-lead-card="${leadId}"]`);
  await expect(leadCard).toBeVisible();
  if (!(await leadCard.evaluate(element => element.open))) await leadCard.locator(':scope > summary').click();
  const waitForOwnerDashboardWrite = async (path, action, method = 'PATCH') => {
    return measureDashboardAction(ownerPage, path, method, action, async () => {}, { waitDashboard: true });
  };
  await leadCard.locator('[data-lead-edit] [name="contractAmount"]').first().fill('200');
  await waitForOwnerDashboardWrite(`/api/admin/leads/${encodeURIComponent(leadId)}`, () =>
    leadCard.locator('[data-lead-edit] button[type="submit"]').first().click()
  );
  if (!(await leadCard.evaluate(element => element.open))) await leadCard.locator(':scope > summary').click();
  const assign = leadCard.locator(`[data-developer-assign="${leadId}"]`);
  await expect(assign).toBeVisible();
  await assign.locator('[name="developerUserId"]').selectOption(developer.id);
  await assign.locator('[name="developerDueDate"]').fill('2026-12-15');
  await waitForOwnerDashboardWrite(`/api/projects/${encodeURIComponent(leadId)}/assignment`, () =>
    assign.locator('button[type="submit"]').click()
  );
  // Wait for the persisted task status; the developer name also exists in the option list before assignment.
  await expect(leadCard).toContainText('offered', { timeout: 30_000 });
  if (!(await leadCard.evaluate(element => element.open))) await leadCard.locator(':scope > summary').click();
  const payment = leadCard.locator(`[data-payment-form="${leadId}"]`);
  await expect(payment).toBeVisible();
  await payment.locator('[name="amount"]').fill('200');
  await payment.locator('[name="note"]').fill('Synthetic manual payment; no funds moved.');
  await payment.locator('[name="verified"]').check();
  let paymentRequests = 0;
  ownerPage.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/payment' && request.method() === 'POST') paymentRequests++; });
  await waitForOwnerDashboardWrite('/api/admin/payment', async () => {
    await payment.locator('button[type="submit"]').click();
    await expect(payment.locator('button[type="submit"]')).toBeDisabled();
    await ownerPage.evaluate(formId => document.querySelector(formId).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })), `[data-payment-form="${leadId}"]`);
  }, 'POST');
  expect(paymentRequests, 'A fast repeated payment submit must not create a second API request.').toBe(1);
  await expect(leadCard).toContainText('200');

  // Developer accepts, submits synthetic delivery; Owner reviews and completes it.
  const devPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(devPage, { username: developer.username, password: developer.password });
  const dualRoleDeveloper = await devPage.evaluate(async () => {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    return response.json();
  });
  expect(dualRoleDeveloper.user.referralCode).toBeTruthy();
  expect(dualRoleDeveloper.referralLink).toBeTruthy();
  expect(dualRoleDeveloper.projects.some(project => project.id === leadId)).toBe(true);
  await expect(devPage.locator('#dashboardTabs [data-dash-tab="referral"]')).toBeVisible();
  await devPage.locator('[data-dash-tab="referral"]').click();
  await expect(devPage.locator('#dashboardContent')).toContainText(dualRoleDeveloper.user.referralCode);
  await expect(devPage.locator('#dashboardContent')).toContainText(/عمولة تنفيذ المشروع منفصلة|Project execution is separate/);
  await devPage.locator('[data-dash-tab="development"]').click();
  const project = devPage.locator(`[data-project-card="${leadId}"]`);
  await expect(project).toBeVisible();
  const waitForDeveloperDashboardWrite = async (path, action, method) => {
    return measureDashboardAction(devPage, path, method, action, async () => {}, { waitDashboard: true });
  };
  await waitForDeveloperDashboardWrite(`/api/developer/projects/${encodeURIComponent(leadId)}/decision`, () =>
    project.locator('[data-task-decision="accept"]').click(), 'POST'
  );
  await project.evaluate(element => { element.open = true; });
  const devFileForm = project.locator(`[data-dev-file="${leadId}"]`);
  await expect(devFileForm).toBeVisible();
  await devFileForm.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-delivery.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Synthetic browser-only delivery file.\n')
  });
  await waitForDeveloperDashboardWrite(`/api/developer/projects/${encodeURIComponent(leadId)}/files`, () =>
    devFileForm.locator('button[type="submit"]').click(), 'POST'
  );
  await project.evaluate(element => { element.open = true; });
  await expect(project).toContainText('synthetic-delivery.pdf', { timeout: 30_000 });
  const devProgress = project.locator(`[data-dev-progress="${leadId}"]`);
  await expect(devProgress).toBeVisible();
  await devProgress.locator('[name="status"]').selectOption('review_requested');
  await devProgress.locator('[name="note"]').fill('Synthetic delivery sent for review.');
  await waitForDeveloperDashboardWrite(`/api/developer/projects/${encodeURIComponent(leadId)}`, () =>
    devProgress.locator('button[type="submit"]').click(), 'PATCH'
  );
  await workspaceViewportMatrix(devPage, 'development', 'developer', testInfo);
  await devPage.close();

  await ownerPage.reload();
  await ownerPage.locator('[data-dash-tab="requests"]').click();
  const refreshedLead = ownerPage.locator(`[data-lead-card="${leadId}"]`);
  if (!(await refreshedLead.evaluate(element => element.open))) await refreshedLead.locator(':scope > summary').click();
  await refreshedLead.locator(`[data-developer-review="${leadId}"] [name="decision"]`).selectOption('approved');
  await waitForOwnerDashboardWrite(`/api/admin/projects/${encodeURIComponent(leadId)}/review`, () =>
    refreshedLead.locator(`[data-developer-review="${leadId}"] button[type="submit"]`).click(), 'POST'
  );
  if (!(await refreshedLead.evaluate(element => element.open))) await refreshedLead.locator(':scope > summary').click();
  await expect(refreshedLead).toContainText('approved', { timeout: 30_000 });
  await refreshedLead.locator(`[data-project-stage-form="${leadId}"] [name="stage"]`).selectOption('completed');
  await waitForOwnerDashboardWrite(`/api/admin/projects/${encodeURIComponent(leadId)}/stage`, () =>
    refreshedLead.locator(`[data-project-stage-form="${leadId}"] button[type="submit"]`).click()
  );
  await expect(refreshedLead).toContainText('25%');
  await workspaceViewportMatrix(ownerPage, 'requests', 'owner-projects', testInfo);

  // Verify the marketer's own view reflects referral sales and 15%, without exposing team records.
  const marketerPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(marketerPage, { username: marketer.username, password: marketer.password });
  await expect(marketerPage.locator('#dashboardTabs [data-dash-tab="referral"]')).toBeVisible();
  await marketerPage.locator('[data-dash-tab="referral"]').click();
  await expect(marketerPage.locator('#dashboardContent')).toContainText(/Rookie|مبتدئ/);
  await expect(marketerPage.locator('#dashboardContent')).toContainText('15%');
  await expect(marketerPage.locator('#dashboardContent')).toContainText('Synthetic Browser Customer');
  await expect(marketerPage.locator('#dashboardContent')).not.toContainText(`e2e_customer_${suffix}@example.test`);
  await expect(marketerPage.locator('#dashboardContent')).not.toContainText('501234567');
  await expect(marketerPage.locator('#dashboardContent')).not.toContainText('Synthetic E2E Owner');
  await workspaceViewportMatrix(marketerPage, 'referral', 'marketer', testInfo);
  await expect(page.locator('#dashboardContent')).not.toContainText('Synthetic E2E Owner');

  const newCustomerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await newCustomerPage.goto(`/?lang=en&ref=${encodeURIComponent(referralCode)}`);
    await expect.poll(async () => (await newCustomerPage.context().cookies(baseURL)).some(cookie => cookie.name === 'zezo_referral_attribution' && cookie.httpOnly)).toBe(true);
    await newCustomerPage.goto('/templates/web-copper-table?lang=en');
    await newCustomerPage.locator('main a[href*="/request?"][href*="template=web-copper-table"][href*="action=order"]').first().click();
    await expect(newCustomerPage.getByLabel('Template (optional)')).toHaveValue('web-copper-table');
    await newCustomerPage.screenshot({ path: testInfo.outputPath('platform-request-mobile.png') });
    await newCustomerPage.getByRole('button', { name: 'Continue', exact: true }).click();
    const projectDetails = `Synthetic referral request through the new customer portal ${suffix}.`;
    await newCustomerPage.getByLabel('What would you like to build?').fill(projectDetails);
    await newCustomerPage.getByLabel('International WhatsApp number').fill('+971551234568');
    await newCustomerPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await newCustomerPage.getByLabel('Attachment (optional)').setInputFiles({
      name: 'synthetic-request.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Platform acceptance attachment.\n')
    });
    await newCustomerPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await newCustomerPage.getByRole('checkbox').check();
    await newCustomerPage.getByRole('button', { name: 'Sign in to continue' }).click();
    await expect(newCustomerPage).toHaveURL(/\/account\?/);
    await newCustomerPage.getByRole('button', { name: 'Create an account', exact: true }).click();
    await newCustomerPage.getByLabel('Full name').fill('Synthetic Platform Customer');
    await newCustomerPage.getByLabel('Email address').fill(`platform_${suffix}@example.test`);
    const password = `Platform!${suffix}2026`;
    await newCustomerPage.locator('input[name="password"]').fill(password);
    await newCustomerPage.getByLabel('Confirm password').fill(password);
    await newCustomerPage.getByRole('button', { name: 'Create a customer account' }).click();
    await expect(newCustomerPage).toHaveURL(/\/request\?lang=en$/);
    await expect(newCustomerPage.getByText(projectDetails, { exact: true })).toBeVisible();
    await expect(newCustomerPage.getByText('synthetic-request.pdf', { exact: true })).toBeVisible();
    const submission = newCustomerPage.waitForResponse(response => new URL(response.url()).pathname === '/api/leads' && response.request().method() === 'POST');
    await newCustomerPage.getByRole('button', { name: 'Submit request', exact: true }).click();
    const response = await submission;
    expect(response.status()).toBe(201);
    await expect(newCustomerPage).toHaveURL(/\/account\/orders\/lead_[a-f0-9]+\?lang=en$/);
    const submittedId = new URL(newCustomerPage.url()).pathname.split('/').at(-1);
    await expect(newCustomerPage.getByRole('log')).toContainText(projectDetails);
    await expect(newCustomerPage.getByText('synthetic-request.pdf', { exact: true })).toBeVisible();
    const saved = await referralDb.query(`
      SELECT p."referrerId", p."templateId", c.id AS conversation_id, c."customerId" AS chat_customer,
        p."customerId" AS request_customer
      FROM project_requests p JOIN conversations c ON c.id = p.data->>'conversationId'
      WHERE p.id = $1 AND c.data->>'leadId' = p.id
    `, [submittedId]);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({ referrerId: marketer.id, templateId: 'web-copper-table', chat_customer: saved.rows[0].request_customer });
    const noAccess = await request.get(`/api/conversations/${saved.rows[0].conversation_id}`);
    expect([401, 404]).toContain(noAccess.status());
    await newCustomerPage.screenshot({ path: testInfo.outputPath('platform-order-with-chat-mobile.png'), fullPage: true });
    await newCustomerPage.goto('/account/overview?lang=en');
    await expect(newCustomerPage.getByText('Synthetic Platform Customer', { exact: true })).toBeVisible();
    await newCustomerPage.screenshot({ path: testInfo.outputPath('platform-customer-dashboard-mobile.png'), fullPage: true });
  } finally { await newCustomerPage.close(); }

  await Promise.all([ownerApi.dispose(), marketerJourneyApi.dispose(), ownerPage.close(), marketerPage.close(), referralDb.end()]);
});

test('interactive demos perform their core local actions without external services', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Representative local demo interactions run once in Chromium.');
  await page.goto('/?preview=web-copper-table');
  const restaurant = page.locator('[data-zfx-web="web-copper-table"]');
  await restaurant.locator('[data-web="add"]').first().click();
  await expect(restaurant.locator('.zfx-bag b')).toHaveText('1');
  await restaurant.locator('[data-web="view"][data-view="cart"]').click();
  await expect(restaurant.locator('.zfx-cart-line')).toHaveCount(1);
  await restaurant.locator('[data-web="view"][data-view="checkout"]').click();
  await restaurant.locator('[data-web-form="checkout"] .zfx-primary').click();
  await expect(restaurant.locator('.zfx-success')).toBeVisible();
  await restaurant.locator('.zfx-success .zfx-primary[data-view="admin"]').click();
  await expect(restaurant.locator('.zfx-record')).toHaveCount(1);

  await page.goto('/?preview=web-luma-clinic');
  await page.locator('[data-ld="clinic-step"]').first().click();
  await page.locator('[data-ld="specialty"]').first().click();
  await page.locator('[data-ld="doctor"]').first().click();
  await page.locator('[data-ld-form="clinic-date"] input[name="date"]').fill('2026-12-01');
  await page.locator('[data-ld-form="clinic-date"] .ld-primary').click();
  await page.locator('[data-ld="clinic-time"]').first().click();
  await page.locator('[data-ld="confirm-booking"]').click();
  await expect(page.locator('.ld-clinic-confirmed')).toBeVisible();

  await page.goto('/?preview=app-daygrid');
  await page.locator('[data-ld="view"][data-view="list"]').click();
  await expect(page.locator('.ld-list-view')).toBeVisible();
  await page.locator('[data-ld-form="task"] [name="title"]').fill('Synthetic QA browser task');
  await page.locator('[data-ld-form="task"] .ld-primary').click();
  await expect(page.locator('.ld-kanban')).toContainText('Synthetic QA browser task');

  await page.goto('/?preview=ai-helio-desk');
  await page.locator('.ld-chat-form textarea[name="prompt"]').fill('What courses are available?');
  await page.locator('.ld-chat-form .ld-primary').click();
  await expect(page.locator('.ld-message.user')).toContainText('What courses are available?');
  await expect(page.locator('.ld-message-list .ld-message')).toHaveCount(3);

  await page.goto('/?preview=idea-business-canvas');
  const canvas = page.locator('.canvas-grid');
  await expect(canvas).toBeVisible();
  await canvas.locator('textarea[name="value"]').fill('Synthetic idea saved locally');
  await page.locator('.canvas-toolbar [data-idea-action="save"]').click();
  await expect(page.locator('#templatePreviewNotice')).toContainText('حُفظت');
});


