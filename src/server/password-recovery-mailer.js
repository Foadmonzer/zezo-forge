import nodemailer from 'nodemailer';
import { resendConfigured, sendWithResend } from './resend-mail.js';

export const PASSWORD_RECOVERY_SENDER = 'zezo.info.2026@gmail.com';
const RESEND_TIMEOUT_MS = 2200;

function passwordRecoveryProvider(env) {
  return String(env.ZEZO_PASSWORD_RECOVERY_PROVIDER || 'gmail').trim().toLowerCase();
}

/** Allow the bounded Resend call to settle before either public response goes out. */
export function passwordRecoveryMinimumResponseMs(env = process.env) {
  return passwordRecoveryProvider(env) === 'resend' ? RESEND_TIMEOUT_MS + 600 : 0;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

export function passwordRecoveryEmailReady(env = process.env) {
  if (!passwordRecoveryOrigin(env)) return false;
  const provider = passwordRecoveryProvider(env);
  if (provider === 'resend') {
    return env.ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL === 'true' && resendConfigured(env);
  }
  if (provider !== 'gmail') return false;
  const username = String(env.ZEZO_GMAIL_SMTP_USER || '').trim().toLowerCase();
  const appPassword = String(env.ZEZO_GMAIL_SMTP_APP_PASSWORD || '').replace(/\s/g, '');
  const enabled = env.ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL === 'true' ||
    (env.ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL === undefined && Boolean(username && appPassword));
  return enabled && username === PASSWORD_RECOVERY_SENDER && appPassword.length > 0;
}

export function passwordRecoveryOrigin(env = process.env) {
  // Fail closed instead of silently sending a preview reset link to Production.
  // Netlify's preview URL must be configured explicitly for that deploy context.
  const configured = String(env.ZEZO_PUBLIC_URL || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(configured);
    const testHttpAllowed = env.NODE_ENV === 'test' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !testHttpAllowed) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function createPasswordResetUrl(rawToken, env = process.env) {
  const origin = passwordRecoveryOrigin(env);
  if (!origin) throw new Error('password_recovery_origin_invalid');
  const url = new URL('/', origin);
  url.hash = `resetPassword=${encodeURIComponent(String(rawToken))}`;
  return url.toString();
}

export function renderPasswordRecoveryEmail({ resetUrl, language = 'ar' }) {
  const safeUrl = escapeHtml(resetUrl);
  const english = String(language).toLowerCase().startsWith('en');
  const copy = english ? {
    subject: 'Reset your ZEZO Forge password',
    title: 'Reset your password',
    intro: 'We received a request to reset the password for your ZEZO Forge account.',
    button: 'Choose a new password',
    expiry: 'This secure link expires in 1 hour and can be used once.',
    ignore: 'If you did not request this, you can ignore this email. Your password will remain unchanged.',
    automated: 'This is an automated message. Please do not reply.',
    text: `We received a request to reset your ZEZO Forge password.\n\nChoose a new password using this secure link (expires in 1 hour and works once):\n${resetUrl}\n\nIf you did not request this, ignore this email. Your password remains unchanged.\n\nAutomated message from ZEZO Forge. Please do not reply.`
  } : {
    subject: 'إعادة تعيين كلمة مرور ZEZO Forge',
    title: 'إعادة تعيين كلمة المرور',
    intro: 'وصلنا طلب لإعادة تعيين كلمة المرور المرتبطة بحسابك في ZEZO Forge.',
    button: 'اختيار كلمة مرور جديدة',
    expiry: 'هذا الرابط الآمن صالح لمدة ساعة واحدة ويُستخدم مرة واحدة فقط.',
    ignore: 'إذا لم تطلب إعادة التعيين، فتجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.',
    automated: 'هذه رسالة آلية. يرجى عدم الرد عليها.',
    text: `وصلنا طلب لإعادة تعيين كلمة المرور المرتبطة بحسابك في ZEZO Forge.\n\nاختر كلمة مرور جديدة من هذا الرابط الآمن (صالح لساعة واحدة ولمرة واحدة):\n${resetUrl}\n\nإذا لم تطلب إعادة التعيين، فتجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.\n\nرسالة آلية من ZEZO Forge. يرجى عدم الرد عليها.`
  };
  return {
    subject: copy.subject,
    text: copy.text,
    html: `<!doctype html><html lang="${english ? 'en' : 'ar'}" dir="${english ? 'ltr' : 'rtl'}"><body style="margin:0;background:#05070A;color:#edf3ff;font-family:Arial,Tahoma,sans-serif;padding:28px 12px"><main style="max-width:560px;margin:auto;border:1px solid #17263b;background:#0b1018;padding:32px"><div style="color:#A3FF12;font-weight:700;letter-spacing:.12em">ZEZO FORGE</div><div style="height:3px;background:#0066FF;margin:18px 0 28px"></div><h1 style="font-size:24px;margin:0 0 14px">${copy.title}</h1><p style="font-size:15px;line-height:1.9;color:#c4cede">${copy.intro}</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#A3FF12;color:#081006;padding:14px 20px;text-decoration:none;font-weight:700">${copy.button}</a></p><p style="font-size:13px;line-height:1.8;color:#aab6c8">${copy.expiry}</p><p style="font-size:13px;line-height:1.8;color:#aab6c8">${copy.ignore}</p><div style="border-top:1px solid #263143;margin-top:28px;padding-top:18px;font-size:12px;color:#8290a4">${copy.automated}</div></main></body></html>`
  };
}

function transportOptions(env) {
  if (env.NODE_ENV === 'test' && env.ZEZO_TEST_SMTP_HOST && env.ZEZO_TEST_SMTP_PORT) {
    return {
      host: env.ZEZO_TEST_SMTP_HOST,
      port: Number(env.ZEZO_TEST_SMTP_PORT),
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 7000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true
    };
  }
  return {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: PASSWORD_RECOVERY_SENDER,
      pass: String(env.ZEZO_GMAIL_SMTP_APP_PASSWORD || '').replace(/\s/g, '')
    },
    connectionTimeout: 7000,
    greetingTimeout: 7000,
    socketTimeout: 10000,
    dnsTimeout: 5000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { minVersion: 'TLSv1.2' }
  };
}

export function passwordRecoveryFailureCode(error, env = process.env) {
  if (passwordRecoveryProvider(env) === 'resend') {
    if (error?.status === 401 || error?.status === 403) return 'resend_auth';
    if (error?.status === 429) return 'resend_rate_limited';
    if (error?.status >= 500) return 'resend_unavailable';
    if (error?.status >= 400) return 'resend_rejected';
    return 'resend_uncertain';
  }
  const code = String(error?.code || '').toUpperCase();
  if (['EAUTH', '535'].includes(code) || Number(error?.responseCode) === 535) return 'smtp_auth';
  if (['ETIMEDOUT', 'ESOCKET', 'ETIMEOUT'].includes(code)) return 'smtp_timeout';
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) return 'smtp_connection';
  if (Number(error?.responseCode) >= 400) return 'smtp_rejected';
  return 'smtp_error';
}

async function withSmtpDeadline(transport, operation) {
  let timeout;
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          transport.close();
          const error = new Error('smtp_timeout');
          error.code = 'ETIMEDOUT';
          reject(error);
        }, 12_000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
    transport.close();
  }
}

export async function verifyPasswordRecoveryTransport(env = process.env) {
  if (!passwordRecoveryEmailReady(env)) throw new Error('password_recovery_email_not_configured');
  // A sending-only Resend key has no equivalent to SMTP's connection check.
  // The caller uses the same response deadline regardless of account existence.
  if (passwordRecoveryProvider(env) === 'resend') return;
  const transport = nodemailer.createTransport(transportOptions(env));
  return withSmtpDeadline(transport, () => transport.verify());
}

export async function sendPasswordRecoveryEmail({ to, resetUrl, language = 'ar', idempotencyKey }, env = process.env) {
  if (!passwordRecoveryEmailReady(env)) throw new Error('password_recovery_email_not_configured');
  const message = renderPasswordRecoveryEmail({ resetUrl, language });
  if (passwordRecoveryProvider(env) === 'resend') {
    const options = { ...message, to, idempotencyKey, env, timeoutMs: RESEND_TIMEOUT_MS };
    if (env.NODE_ENV === 'test' && env.ZEZO_TEST_RESEND_PORT) {
      const port = Number(env.ZEZO_TEST_RESEND_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_resend_test_port');
      options.fetchImpl = (_url, init) => fetch(`http://127.0.0.1:${port}/emails`, init);
    }
    return sendWithResend(options);
  }
  const testTransport = env.NODE_ENV === 'test' && env.ZEZO_TEST_SMTP_HOST && env.ZEZO_TEST_SMTP_PORT;
  const transport = nodemailer.createTransport(transportOptions(env));
  return withSmtpDeadline(transport, () => transport.sendMail({
    from: `ZEZO Forge <${PASSWORD_RECOVERY_SENDER}>`,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(testTransport ? {} : { envelope: { from: PASSWORD_RECOVERY_SENDER, to: [to] } })
  }));
}
