import { createHash } from 'node:crypto';

export function mailWithFooter(text, language = 'ar') {
  const footer = {
    ar: 'رسالة تلقائية من ZEZO Forge. يرجى عدم الرد على هذه الرسالة.',
    en: 'This is an automated message from ZEZO Forge. Please do not reply.',
    both: 'رسالة تلقائية من ZEZO Forge. يرجى عدم الرد على هذه الرسالة.\nThis is an automated message from ZEZO Forge. Please do not reply.'
  };
  return `${text}\n\n${language === 'en' ? footer.en : language === 'both' ? footer.both : footer.ar}`;
}

export function verificationEmail({ name, verifyUrl, language }) {
  const english = language === 'en';
  return {
    subject: english ? 'Confirm your ZEZO email address' : 'تأكيد بريد حساب ZEZO',
    text: mailWithFooter(english
      ? `Hello ${name},\n\nConfirm your email address to activate your ZEZO account. This link expires in 24 hours:\n${verifyUrl}\n\nIf you did not create this account, ignore this email.`
      : `مرحباً ${name}،\n\nأكد بريدك لتفعيل حسابك في ZEZO خلال 24 ساعة:\n${verifyUrl}\n\nإذا لم تنشئ هذا الحساب، تجاهل الرسالة.`, language)
  };
}

export function customerReplyEmail({ siteBase, language, quote = false }) {
  const english = language === 'en';
  const subject = quote
    ? (english ? 'Your ZEZO quote is ready to review' : 'عرض سعر ZEZO جاهز للمراجعة')
    : (english ? 'ZEZO replied to your conversation' : 'رد فريق ZEZO على محادثتك');
  const text = english
    ? `Sign in to your ZEZO account and open your conversation to see the update:\n${siteBase}/`
    : `سجّل الدخول إلى حساب ZEZO وافتح محادثتك للاطلاع على التحديث:\n${siteBase}/`;
  return { subject, text: mailWithFooter(text, language) };
}

export function approvalEmail({ siteBase, language, approved, staff = false }) {
  const english = language === 'en';
  let subject = english ? 'Your ZEZO project status changed' : 'تحدّثت حالة مشروعك لدى ZEZO';
  if (approved === true) subject = english ? 'Your ZEZO project delivery was approved' : 'تم اعتماد تسليم مشروعك لدى ZEZO';
  if (approved === false) subject = english ? 'An update to your ZEZO project review' : 'تحديث على مراجعة مشروعك لدى ZEZO';
  const text = english
    ? `Sign in to review the latest project update in your workspace:\n${siteBase}${staff ? '/team' : '/'}`
    : `سجّل الدخول للاطلاع على آخر تحديث للمشروع في مساحتك:\n${siteBase}${staff ? '/team' : '/'}`;
  return { subject, text: mailWithFooter(text, language) };
}

export function teamInvitationEmail({ activationUrl, teamUrl, reissued = false }) {
  const subject = reissued
    ? 'تجديد دعوة ZEZO / Your ZEZO invitation was reissued'
    : 'دعوة للانضمام إلى ZEZO / Join the ZEZO team';
  const text = [
    'لتفعيل حسابك في مساحة الفريق، افتح الرابط واختر كلمة مرور. الرابط صالح لمرة واحدة ولمدة 24 ساعة.',
    'To activate your team account, open the link and choose a password. The link expires in 24 hours and can only be used once.',
    activationUrl,
    `بوابة الفريق / Team workspace: ${teamUrl}`,
    'إذا لم تتوقع هذه الدعوة، تجاهل الرسالة. / If you did not expect this invitation, ignore this email.'
  ].join('\n\n');
  return { subject, text: mailWithFooter(text, 'both') };
}

export function enqueuePostgresTransactionalMail(client, {
  eventKey, kind, recipient = '', recipientType = 'direct', subject, text, at
}) {
  if (!recipient && recipientType !== 'admin') return;
  const id = `mail_${createHash('sha256').update(eventKey).digest('hex').slice(0, 40)}`;
  const data = { id, to: recipient, recipientType, kind, subject, text, createdAt: at, updatedAt: at };
  return client.query(`
    INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
    VALUES ($1, $2, 'pending', 0, $3::jsonb, $4, $4)
    ON CONFLICT (id) DO NOTHING
  `, [id, recipient, JSON.stringify(data), at]);
}
