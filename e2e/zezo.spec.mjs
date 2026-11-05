import { test, expect } from '@playwright/test';
import { request as playwrightRequest } from 'playwright';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';

const widths = [375, 390, 768, 1366, 1440];
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

async function templateIds() {
  const source = await readFile(new URL('../public/template-catalog.js', import.meta.url), 'utf8');
  return [...source.matchAll(/^\['([^']+)','(?:web|apps|ai|ideas)'/gm)].map(match => match[1]);
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
        right: rect.right
      };
    });
    expect(bounds.page, `${name} page overflow at ${width}px`).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.left, `${name} workspace clipped on the left at ${width}px`).toBeGreaterThanOrEqual(-1);
    expect(bounds.right, `${name} workspace clipped on the right at ${width}px`).toBeLessThanOrEqual(bounds.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`workspace-${name}-${width}.png`) });
  }
}

test('browser navigation works in Chromium, Firefox, and WebKit', async ({ page, browserName }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#heroTitle')).toBeVisible();
  await expect(page.locator('#templateGrid .template-card')).toHaveCount(40);
  await page.goto('/?preview=web-thread-studio');
  await expect(page.locator('#templatePreviewApp .template-preview-shell h1')).toBeVisible();
  await expect(page.locator('#templatePreviewApp .template-preview-actions a')).toHaveCount(2);
  await page.locator('#templatePreviewLanguage').click();
  await expect(page.locator('#templatePreviewApp .template-preview-shell')).toHaveCSS('direction', 'ltr');
  expect(errors, `${browserName} reported browser errors`).toEqual([]);
});

test('responsive page layouts, navigation, and screenshots at requested widths', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Viewport screenshot matrix is run in Chromium; cross-browser navigation runs separately.');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const pages = [
    { name: 'home', url: '/' },
    { name: 'templates', url: '/#templates' },
    { name: 'team', url: '/team' },
    { name: 'template-web-thread-studio', url: '/?preview=web-thread-studio' }
  ];
  for (const width of widths) {
    for (const route of pages) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route.url);
      if (route.name === 'team') await expect(page.locator('#authModal')).toHaveAttribute('aria-hidden', 'false');
      else if (route.name === 'templates') await expect(page.locator('#templateGrid .template-card')).toHaveCount(40);
      else if (route.name.startsWith('template-')) await expect(page.locator('#templatePreviewApp .template-preview-shell')).toBeVisible();
      else await expect(page.locator('#heroTitle')).toBeVisible();

      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      expect(dimensions.content, `${route.name} has horizontal overflow at ${width}px (${JSON.stringify(dimensions)})`).toBeLessThanOrEqual(dimensions.viewport + 1);
      await page.screenshot({ path: testInfo.outputPath(`${route.name}-${width}.png`), fullPage: route.name === 'templates' });
    }
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.locator('#mobileMenu')).toBeVisible();
  await page.locator('#mobileMenu').click();
  await expect(page.locator('#mainNav')).toHaveClass(/open/);
  await page.locator('#mainNav a[href="#templates"]').click();
  await expect(page).toHaveURL(/#templates$/);
  await expect(page.locator('#mainNav')).not.toHaveClass(/open/);
  expect(errors).toEqual([]);
});

test('all 40 catalog templates open and both request actions route to the correct template', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'The 40-template sweep runs once in Chromium.');
  const ids = await templateIds();
  expect(ids).toHaveLength(40);
  await page.goto('/#templates');
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

  await page.goto('/#templates');
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
  test.skip(browserName !== 'chromium', 'Stateful synthetic business journey runs once in Chromium.');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const ownerUsername = `e2e_owner_${suffix}`;
  const ownerTemporary = `Owner!${suffix}Temporary2026`;
  const ownerPassword = `Owner!${suffix}Changed2026`;
  const ownerApi = await playwrightRequest.newContext({ baseURL });

  const setup = await json(await ownerApi.post('/api/setup', { data: { name: 'Synthetic E2E Owner', username: ownerUsername, password: ownerTemporary } }));
  expect(setup.user.role).toBe('admin');
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
    if (['hr_manager', 'marketing_manager'].includes(role)) {
      const mfa = await json(await activationApi.get('/api/auth/mfa/setup'));
      await json(await activationApi.post('/api/auth/mfa/enable', { data: { code: totp(mfa.secret) } }));
    }
    await activationApi.dispose();
    return { id: activation.user.id, username, password };
  }

  const orderManager = await createEmployee('order_manager');
  const developer = await createEmployee('developer');
  const marketer = await createEmployee('marketer');
  const marketerApi = await playwrightRequest.newContext({ baseURL });
  await json(await marketerApi.post('/api/auth/login', { data: { username: marketer.username, password: marketer.password, accountType: 'employee' } }));
  const marketerDashboard = await json(await marketerApi.get('/api/dashboard'));
  const referralCode = marketerDashboard.user.referralCode;
  expect(referralCode).toBeTruthy();
  await marketerApi.dispose();

  // Create and sign in as a customer through the actual browser form, carrying the synthetic referral.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`/?ref=${encodeURIComponent(referralCode)}`);
  await page.locator('.login-open').click();
  await page.locator('[data-customer-view="register"]').click();
  await page.locator('#clientRegisterForm [name="name"]').fill('Synthetic Browser Customer');
  await page.locator('#clientRegisterForm [name="email"]').fill(`e2e_customer_${suffix}@example.test`);
  const customerPassword = `Customer!${suffix}Password2026`;
  await page.locator('#clientRegisterForm [name="password"]').fill(customerPassword);
  await page.locator('#clientRegisterForm [name="confirmPassword"]').fill(customerPassword);
  await page.locator('#clientRegisterForm button[type="submit"]').click();
  await expect(page.locator('#dashboardBackdrop.open')).toBeVisible();
  await page.locator('#dashboardClose').click();

  // Start a template conversation and send a customer message in the browser.
  await page.locator('#templateGrid').scrollIntoViewIfNeeded();
  await page.locator('[data-template-id="web-copper-table"] [data-template-request][data-template-action="order"]').click();
  await page.locator('#templateOrderModal [data-order-channel="chat"]').click();
  await page.locator('#conversationStartForm [name="message"]').fill('Synthetic browser question about the restaurant template.');
  await page.locator('#conversationStartForm button[type="submit"]').click();
  await expect(page.locator('#conversationModal.open')).toBeVisible();
  await page.locator('#conversationReplyForm [name="message"]').fill('Synthetic customer follow-up message.');
  await page.locator('#conversationReplyForm button[type="submit"]').click();
  await expect(page.locator('#conversationMessages')).toContainText('Synthetic customer follow-up message');
  await page.locator('#dashboardLogout').click();
  await expect(page.locator('#dashboardBackdrop.open')).toHaveCount(0);
  await page.locator('.login-open').click();
  await page.locator('[data-customer-view="login"]').click();
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
  await loginThroughUI(orderPage, { username: orderManager.username, password: orderManager.password });
  await orderPage.locator('[data-dash-tab="conversations"]').click();
  const staffConversation = orderPage.locator('details.conversation-staff-card').filter({ hasText: 'مطعم السعادة' });
  await expect(staffConversation).toBeVisible();
  await staffConversation.locator('summary').click();
  await staffConversation.locator(`[data-conversation-reply="${conversationId}"] textarea[name="message"]`).fill('Synthetic Order Manager response.');
  await staffConversation.locator(`[data-conversation-reply="${conversationId}"] button[type="submit"]`).click();
  const quoteEditor = staffConversation.locator('details.conversation-quote-editor');
  await quoteEditor.locator('summary').click();
  await quoteEditor.locator('[name="amount"]').fill('200');
  await quoteEditor.locator('[name="scope"]').fill('Single responsive ZEZO restaurant website scope for browser acceptance tests.');
  await quoteEditor.locator('[name="included"]').fill('One responsive landing page and contact details.');
  await quoteEditor.locator('button[type="submit"]').click();
  await expect(staffConversation).toContainText('200');
  await workspaceViewportMatrix(orderPage, 'conversations', 'order-manager', testInfo);
  await orderPage.close();

  // The customer reloads the saved conversation, accepts the quote, and sends a formal request.
  await page.reload();
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

  // Owner: assign developer and record a synthetic, verified manual payment in the UI.
  const ownerPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(ownerPage, { username: ownerUsername, password: ownerPassword, accountType: 'management', mfaCode: totp(ownerMfa.secret) });
  await ownerPage.locator('[data-dash-tab="requests"]').click();
  const leadCard = ownerPage.locator(`[data-lead-card="${leadId}"]`);
  await expect(leadCard).toBeVisible();
  if (!(await leadCard.evaluate(element => element.open))) await leadCard.locator('summary').click();
  await leadCard.locator('[data-lead-edit] [name="contractAmount"]').first().fill('200');
  await leadCard.locator('[data-lead-edit] button[type="submit"]').first().click();
  const assign = leadCard.locator(`[data-developer-assign="${leadId}"]`);
  await assign.locator('[name="developerUserId"]').selectOption(developer.id);
  await assign.locator('[name="developerDueDate"]').fill('2026-12-15');
  await assign.locator('button[type="submit"]').click();
  const payment = leadCard.locator(`[data-payment-form="${leadId}"]`);
  await payment.locator('[name="amount"]').fill('200');
  await payment.locator('[name="note"]').fill('Synthetic manual payment; no funds moved.');
  await payment.locator('[name="verified"]').check();
  await payment.locator('button[type="submit"]').click();
  await expect(leadCard).toContainText('200');

  // Developer accepts, submits synthetic delivery; Owner reviews and completes it.
  const devPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(devPage, { username: developer.username, password: developer.password });
  await devPage.locator('[data-dash-tab="development"]').click();
  const project = devPage.locator(`[data-project-card="${leadId}"]`);
  await expect(project).toBeVisible();
  await project.locator('[data-task-decision="accept"]').click();
  await project.locator(`[data-dev-progress="${leadId}"] [name="status"]`).selectOption('review_requested');
  await project.locator(`[data-dev-progress="${leadId}"] [name="note"]`).fill('Synthetic delivery sent for review.');
  await project.locator(`[data-dev-progress="${leadId}"] button[type="submit"]`).click();
  await project.locator(`[data-dev-file="${leadId}"] input[type="file"]`).setInputFiles({
    name: 'synthetic-delivery.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic browser-only delivery file.')
  });
  await project.locator(`[data-dev-file="${leadId}"] button[type="submit"]`).click();
  await expect(project).toContainText('ملف');
  await workspaceViewportMatrix(devPage, 'development', 'developer', testInfo);
  await devPage.close();

  await ownerPage.reload();
  await ownerPage.locator('[data-dash-tab="requests"]').click();
  const refreshedLead = ownerPage.locator(`[data-lead-card="${leadId}"]`);
  if (!(await refreshedLead.evaluate(element => element.open))) await refreshedLead.locator('summary').click();
  await refreshedLead.locator(`[data-developer-review="${leadId}"] [name="decision"]`).selectOption('approved');
  await refreshedLead.locator(`[data-developer-review="${leadId}"] button[type="submit"]`).click();
  await refreshedLead.locator(`[data-project-stage-form="${leadId}"] [name="stage"]`).selectOption('completed');
  await refreshedLead.locator(`[data-project-stage-form="${leadId}"] button[type="submit"]`).click();
  await expect(refreshedLead).toContainText('25%');
  await workspaceViewportMatrix(ownerPage, 'requests', 'owner-projects', testInfo);

  // Verify the marketer's own view reflects referral sales and 15%, without exposing team records.
  const marketerPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await loginThroughUI(marketerPage, { username: marketer.username, password: marketer.password });
  await expect(marketerPage.locator('#dashboardTabs [data-dash-tab="referral"]')).toBeVisible();
  await marketerPage.locator('[data-dash-tab="referral"]').click();
  await expect(marketerPage.locator('#dashboardContent')).toContainText(/Rookie|مبتدئ/);
  await expect(marketerPage.locator('#dashboardContent')).toContainText('15%');
  await expect(marketerPage.locator('#dashboardContent')).not.toContainText('Synthetic Browser Customer');
  await expect(marketerPage.locator('#dashboardContent')).not.toContainText('Synthetic E2E Owner');
  await workspaceViewportMatrix(marketerPage, 'referral', 'marketer', testInfo);
  await expect(page.locator('#dashboardContent')).not.toContainText('Synthetic E2E Owner');

  await Promise.all([ownerApi.dispose(), ownerPage.close(), marketerPage.close()]);
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
  await restaurant.locator('[data-web-form="checkout"] button[type="submit"]').click();
  await expect(restaurant.locator('.zfx-success')).toBeVisible();
  await restaurant.locator('[data-web="view"][data-view="admin"]').click();
  await expect(restaurant.locator('.zfx-record')).toHaveCount(1);

  await page.goto('/?preview=web-luma-clinic');
  await page.locator('[data-ld="clinic-step"]').first().click();
  await page.locator('[data-ld="specialty"]').first().click();
  await page.locator('[data-ld="doctor"]').first().click();
  await page.locator('[data-ld-form="clinic-date"] input[name="date"]').fill('2026-12-01');
  await page.locator('[data-ld-form="clinic-date"] button[type="submit"]').click();
  await page.locator('[data-ld="clinic-time"]').first().click();
  await page.locator('[data-ld="confirm-booking"]').click();
  await expect(page.locator('.ld-clinic-confirmed')).toBeVisible();

  await page.goto('/?preview=app-daygrid');
  await page.locator('[data-ld="view"][data-view="list"]').click();
  await expect(page.locator('.ld-list-view')).toBeVisible();
  await page.locator('[data-ld-form="task"] [name="title"]').fill('Synthetic QA browser task');
  await page.locator('[data-ld-form="task"] button[type="submit"]').click();
  await expect(page.locator('.ld-kanban')).toContainText('Synthetic QA browser task');

  await page.goto('/?preview=ai-helio-desk');
  await page.locator('.ld-chat-form textarea[name="prompt"]').fill('What courses are available?');
  await page.locator('.ld-chat-form button[type="submit"]').click();
  await expect(page.locator('.ld-message.user')).toContainText('What courses are available?');
  await expect(page.locator('.ld-message-list .ld-message')).toHaveCount(3);

  await page.goto('/?preview=idea-business-canvas');
  const planner = page.locator('#demoPlanner');
  await expect(planner).toBeVisible();
  await planner.locator('textarea').first().fill('Synthetic idea saved locally');
  await planner.locator('button[type="submit"]').click();
  await expect(page.locator('#templatePreviewNotice')).toContainText('حُفظت');
});

