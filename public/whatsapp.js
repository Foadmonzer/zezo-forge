export function normalizeWhatsAppNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 && /^[1-9]/.test(digits) ? digits : '';
}

export function buildWhatsAppUrl(value, message = '') {
  const phone = normalizeWhatsAppNumber(value);
  if (!phone) return '';
  const text = String(message ?? '');
  return `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function buildTemplateEnquiryMessage({ title, code, price, referralCode = '', language = 'ar' } = {}) {
  const english = language === 'en';
  const amount = price == null || price === ''
    ? (english ? 'Quote after scope review' : 'يحدد بعد مراجعة النطاق')
    : `${new Intl.NumberFormat(english ? 'en' : 'ar', { maximumFractionDigits: 2 }).format(Number(price))} ${english ? 'ILS' : 'شيكل'}`;
  const lines = english
    ? ['Hello, I would like to request a template from ZEZO Forge.', `Template name: ${title || '—'}`, `Template code: ${code || '—'}`, `Starting price: ${amount}`, 'I would like to customize the project and learn about the available options and final cost.']
    : ['السلام عليكم، أريد طلب قالب من ZEZO Forge.', `اسم القالب: ${title || '—'}`, `رمز القالب: ${code || '—'}`, `السعر الابتدائي: ${amount}`, 'أريد معرفة خيارات تخصيص المشروع والتكلفة النهائية.'];
  if (referralCode) lines.push(`${english ? 'Referral code' : 'رمز الإحالة'}: ${referralCode}`);
  return lines.join('\n');
}
