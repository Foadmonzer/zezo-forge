import { NextResponse, type NextRequest } from 'next/server';
import { consumeRateLimitBucket } from './src/server/postgres-runtime.js';
import {
  createStagingSession,
  isStagingSessionValid,
  STAGING_ACCESS_COOKIE,
  STAGING_SESSION_TTL_SECONDS,
  stagingPasswordMatches
} from './src/server/staging-auth.js';

const stagingHeaders = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY'
};

function loginPage(status: number, message = '') {
  const error = message ? `<p class="error" role="alert">${message}</p>` : '';
  const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>دخول بيئة اختبار ZEZO</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070a;color:#edf3ff;font-family:Segoe UI,Tahoma,Arial,sans-serif;padding:24px}.card{width:min(100%,430px);padding:34px;border:1px solid #233149;background:linear-gradient(145deg,#0d1521,#080b10);box-shadow:0 24px 80px #0009}.brand{color:#a3ff12;font-size:12px;letter-spacing:.2em;font-weight:800}.eyebrow{margin:28px 0 8px;color:#91a1b8;font-size:12px;letter-spacing:.08em}.card h1{margin:0 0 10px;font-size:28px}.card p{margin:0 0 24px;color:#9ba9bb;line-height:1.8;font-size:14px}label{display:block;font-size:13px;margin-bottom:9px}input{width:100%;height:48px;border:1px solid #31415a;background:#05070a;color:#fff;padding:0 14px;font-size:16px;direction:ltr;text-align:left}input:focus{outline:2px solid #0066ff;border-color:transparent}button{width:100%;margin-top:16px;height:48px;border:0;background:#a3ff12;color:#071006;font-weight:800;font-size:14px;cursor:pointer}.error{padding:10px 12px;margin:0 0 16px;border:1px solid #743d43;color:#ffb5bb;background:#35151a;font-size:13px}.foot{margin-top:22px!important;margin-bottom:0!important;font-size:11px!important;color:#728099!important}</style><main class="card"><div class="brand">ZEZO<span style="color:#0066ff">.</span> / STAGING</div><div class="eyebrow">PRIVATE TEST ENVIRONMENT</div><h1>دخول بيئة الاختبار</h1><p>أدخل كلمة المرور التي ظهرت عند تشغيل نسخة ZEZO الاختبارية.</p>${error}<form method="post" action="/__staging/login"><label for="password">كلمة مرور المعاينة</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required autofocus><button type="submit">دخول آمن ↗</button></form><p class="foot">بيانات تجريبية مستقلة. لا تستخدم بيانات حقيقية.</p></main></html>`;
  return new Response(html, { status, headers: { ...stagingHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

function requestAddress(request: NextRequest) {
  if (process.env.VERCEL === '1') return request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (process.env.ZEZO_TRUST_PROXY === '1') return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  return 'local';
}

export async function proxy(request: NextRequest) {
  if (process.env.ZEZO_STAGING !== 'true') return NextResponse.next();

  const path = request.nextUrl.pathname;
  if (path === '/robots.txt') {
    const response = NextResponse.next();
    for (const [name, value] of Object.entries(stagingHeaders)) response.headers.set(name, value);
    return response;
  }

  // A hosted staging gate must use a shared limiter. Do not silently fall back
  // to per-instance memory, where a serverless scale-out would reset attempts.
  if (process.env.VERCEL === '1' && !process.env.DATABASE_URL) {
    return loginPage(503, 'لم يتم ربط قاعدة بيانات بيئة الاختبار. الدخول متوقف لحين إعدادها.');
  }

  if (!process.env.ZEZO_STAGING_ACCESS_PASSWORD || process.env.ZEZO_STAGING_ACCESS_PASSWORD.length < 16) {
    return loginPage(503, 'لم يتم إعداد كلمة مرور قوية لبيئة الاختبار.');
  }

  if (path === '/__staging/login' && request.method === 'POST') {
    let allowed: boolean;
    try {
      allowed = await consumeRateLimitBucket('staging-login', requestAddress(request), 12, 15 * 60_000);
    } catch {
      return loginPage(503, 'تعذر التحقق من خدمة حماية المعاينة. حاول لاحقاً.');
    }
    if (!allowed) return loginPage(429, 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.');

    let password = '';
    try {
      const form = await request.formData();
      const value = form.get('password');
      if (typeof value === 'string') password = value;
    } catch {
      return loginPage(400, 'تعذر قراءة كلمة المرور. حاول مرة أخرى.');
    }
    if (!stagingPasswordMatches(password)) return loginPage(401, 'كلمة المرور غير صحيحة.');

    const response = NextResponse.redirect(new URL('/', request.url), 303);
    for (const [name, value] of Object.entries(stagingHeaders)) response.headers.set(name, value);
    response.cookies.set({
      name: STAGING_ACCESS_COOKIE,
      value: createStagingSession(),
      path: '/',
      maxAge: STAGING_SESSION_TTL_SECONDS,
      httpOnly: true,
      sameSite: 'strict',
      secure: request.nextUrl.protocol === 'https:' || process.env.VERCEL === '1'
    });
    return response;
  }

  if (path === '/__staging/logout') {
    const response = NextResponse.redirect(new URL('/', request.url), 303);
    response.cookies.set({ name: STAGING_ACCESS_COOKIE, value: '', path: '/', maxAge: 0, httpOnly: true, sameSite: 'strict', secure: request.nextUrl.protocol === 'https:' || process.env.VERCEL === '1' });
    for (const [name, value] of Object.entries(stagingHeaders)) response.headers.set(name, value);
    return response;
  }

  const cookieValue = request.cookies.get(STAGING_ACCESS_COOKIE)?.value || '';
  if (!isStagingSessionValid(cookieValue)) {
    if (path.startsWith('/api/')) {
      return Response.json({ error: 'كلمة مرور بيئة الاختبار مطلوبة / Staging password required', stagingAccessRequired: true }, { status: 401, headers: stagingHeaders });
    }
    return loginPage(200);
  }

  const response = NextResponse.next();
  for (const [name, value] of Object.entries(stagingHeaders)) response.headers.set(name, value);
  return response;
}

export const config = {
  // Protect assets too: a password gate that only covers pages still exposes
  // the private staging site's compiled application bundle to anonymous users.
  matcher: ['/:path*']
};
