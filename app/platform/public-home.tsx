import Image from 'next/image';
import { PublicBlock, PublicHero, PublicButton, PublicSectionTitle, ServiceGrid, ExampleTiles, ProcessSteps, PublicCallout } from './public-blocks';
import { publicHref, publicTemplates, startRequest, type PublicLanguage } from './public-content';
import { PublicReviewPreview } from './public-review-preview';

const highlights = ['web-copper-table', 'app-serveflow', 'ai-helio-desk'];

export function PublicHome({ language }: { language: PublicLanguage }) {
  const isAr = language === 'ar';
  return (
    <PublicBlock language={language}>
      <PublicHero
        label="ZEZO DIGITAL SOLUTIONS & AI"
        title={isAr ? 'من الفكرة إلى الواقع الرقمي.' : 'From idea to digital reality.'}
        detail={isAr ? 'نصمّم ونطوّر مواقع وتطبيقات وحلول ذكاء اصطناعي تساعد مشروعك على البدء والنمو.' : 'We design and build websites, apps, and AI solutions that help your project get started and grow.'}
        actions={<><PublicButton href={startRequest(language)} primary>{isAr ? 'اطلب مشروعك' : 'Start a project'}</PublicButton>
          <PublicButton href={publicHref('/templates', language)}>{isAr ? 'استكشف القوالب' : 'Explore templates'}</PublicButton></>}>
        <div className="zpub-hero-art" aria-hidden="true">
          <span className="zpub-orbit" />
          <span className="zpub-orbit zpub-orbit-outer" />
          <div className="zpub-planet">
            <Image src="/assets/zezo-planet-texture.jpg" alt="" fill sizes="(max-width: 550px) 230px, (max-width: 900px) 290px, 390px" loading="lazy" decoding="async" />
          </div>
          <span className="zpub-orbit-point"/>
        </div>
      </PublicHero>
      <section className="zpub-section">
        <PublicSectionTitle title={isAr ? 'خدماتنا' : 'Our services'}
          detail={isAr ? 'اختر نوع المشروع الأقرب إلى هدفك.' : 'Choose the service that fits what you want to do.'}
          action={<PublicButton href={publicHref('/services', language)}>{isAr ? 'جميع الخدمات' : 'All services'}</PublicButton>} />
        <ServiceGrid language={language} />
      </section>
      <section className="zpub-section">
        <PublicSectionTitle title={isAr ? 'جرّب فكرة قبل أن تطلبها' : 'Try an idea before you request it'}
          detail={isAr ? 'نماذج تفاعلية من مكتبة ZEZO تساعدك على اختيار نقطة البداية.' : 'Interactive demos from the ZEZO library can help you choose a starting point.'}
          action={<PublicButton href={publicHref('/work', language)}>{isAr ? 'شاهد أعمالنا' : 'Explore our work'}</PublicButton>} />
        <ExampleTiles templates={publicTemplates.filter(template => highlights.includes(template.id))} language={language} />
      </section>
      <section className="zpub-section">
        <PublicSectionTitle title={isAr ? 'كيف نعمل' : 'How we work'}
          action={<PublicButton href={publicHref('/reviews', language)}>{isAr ? 'آراء العملاء' : 'Customer reviews'}</PublicButton>} />
        <ProcessSteps language={language} />
      </section>
      <PublicReviewPreview language={language} />
      <PublicCallout language={language} />
    </PublicBlock>
  );
}

export default PublicHome;
