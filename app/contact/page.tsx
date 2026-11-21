import { ContactChannels, ContactForm } from '../platform/contact-form';
import { publicContentMetadata, publicLanguage, type PublicQuery } from '../platform/public-content';
import { PlatformShell, platformLink } from '../platform/shell';

const title = { ar: 'تواصل معنا', en: 'Contact ZEZO' };
const details = { ar: 'أرسل استفسارك إلى فريق ZEZO وتابع الردود في حسابك.', en: 'Send the ZEZO team an enquiry and check your account for replies.' };
const questions = [
  { ar: ['كيف أتابع الرد على استفساري؟', 'افتح قسم الرسائل في حساب العميل. ستجد المحادثة والردود هناك.'], en: ['How do I follow up on my enquiry?', 'Open Messages in your customer account to find the enquiry and any replies.'] },
  { ar: ['كيف أطلب عرض سعر؟', 'ابدأ من صفحة طلب مشروع واختر الخدمة أو القالب واذكر احتياجاتك. يراجع الفريق التفاصيل قبل تقديم العرض.'], en: ['How do I request a quote?', 'Start from the project request page, choose a service or template, and share your requirements. The team reviews the details before quoting.'] },
  { ar: ['هل يمكنني متابعة طلب قائم؟', 'نعم. سجّل الدخول إلى حسابك وافتح الطلب من قسم الطلبات لتجد حالته والمحادثة المرتبطة به إن وجدت.'], en: ['Can I check an existing request?', 'Yes. Sign in and open the request under Orders to see its status and any linked conversation.'] }
];

export async function generateMetadata({ searchParams }: { searchParams: PublicQuery }) {
  const language = publicLanguage(await searchParams);
  return publicContentMetadata('/contact', language, title[language], details[language]);
}

export default async function ContactPage({ searchParams }: { searchParams: PublicQuery }) {
  const query = await searchParams;
  const language = publicLanguage(query);
  const en = language === 'en';
  return <PlatformShell language={language} incomingReferral={typeof query.ref === 'string' ? query.ref : undefined}>
    <div className="zf-wrap zf-feedback-page">
      <header className="zf-feedback-hero"><h1>{title[language]}</h1><p>{details[language]}</p></header>
      <div className="zf-contact-grid">
        <ContactForm language={language} />
        <div className="zf-contact-side">
          <ContactChannels language={language} />
          <section className="zf-feedback-box"><h2>{en ? 'Request a project' : 'طلب مشروع'}</h2><a className="zf-button" href={platformLink('/request', language)}>{en ? 'Start a project' : 'اطلب مشروعك'}</a></section>
        </div>
      </div>
      <section className="zf-feedback-box zf-contact-faq">
        <h2>{en ? 'Frequently asked questions' : 'أسئلة شائعة'}</h2>
        {questions.map(question => <details key={question.en[0]}><summary>{question[language][0]}</summary><p>{question[language][1]}</p></details>)}
      </section>
    </div>
  </PlatformShell>;
}
