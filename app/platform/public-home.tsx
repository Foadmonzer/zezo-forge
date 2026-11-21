import { PublicArt, PublicBlock, PublicHero, PublicButton, PublicSectionTitle, ServiceGrid, ExampleTiles, ProcessSteps, PublicCallout } from './public-blocks';
import { publicHref, publicTemplates, startRequest, type PublicLanguage } from './public-content';
import { PublicReviewPreview } from './public-review-preview';

const highlights = ['web-copper-table', 'app-serveflow', 'ai-helio-desk'];

export function PublicHome({ language }: { language: PublicLanguage }) {
  const isAr = language === 'ar';
  return (
    <PublicBlock language={language}>
      <PublicHero
        label="ZEZO Digital Solutions & AI"
        title={isAr ? 'من الفكرة إلى الواقع الرقمي.' : 'From idea to digital reality.'}
        detail={isAr ? 'نصمّم ونطوّر مواقع وتطبيقات وحلول ذكاء اصطناعي تساعدك على إطلاق مشروعك وتطويره.' : 'We design and build websites, apps, and AI solutions that help you launch and grow your business.'}
        actions={<><PublicButton href={startRequest(language)} primary>{isAr ? 'اطلب مشروعك' : 'Start a project'}</PublicButton>
          <PublicButton href={publicHref('/templates', language)}>{isAr ? 'استكشف القوالب' : 'Explore templates'}</PublicButton></>}>
        <PublicArt scene="hero" />
      </PublicHero>
      <section className="zpub-section">
        <PublicSectionTitle title={isAr ? 'خدماتنا' : 'Our services'}
          detail={isAr ? 'اختر الخدمة التي تناسب هدف مشروعك.' : 'Choose the service that fits your project.'}
          action={<PublicButton href={publicHref('/services', language)}>{isAr ? 'جميع الخدمات' : 'All services'}</PublicButton>} />
        <ServiceGrid language={language} />
      </section>
      <section className="zpub-section">
        <PublicSectionTitle title={isAr ? 'جرّب النماذج التفاعلية' : 'Try our interactive demos'}
          detail={isAr ? 'استكشف نماذج من مكتبة ZEZO واختر ما يناسب فكرتك.' : 'Explore the ZEZO library and find a starting point for your idea.'}
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
