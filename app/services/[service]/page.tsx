import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PlatformShell } from '../../platform/shell';
import { PublicBlock, PublicHero, PublicButton, ProcessSteps, PublicSectionTitle, ExampleTiles, PublicCallout, ServiceMark } from '../../platform/public-blocks';
import { findPublicService, publicContentMetadata, publicHref, publicLanguage, publicReferral, publicServices, publicTemplates, startRequest, type PublicQuery } from '../../platform/public-content';

type PageProps = { params: Promise<{ service: string }>; searchParams: PublicQuery };

export const dynamicParams = false;
export function generateStaticParams() { return publicServices.map(({ id }) => ({ service: id })); }

export async function generateMetadata({ params, searchParams }: PageProps) {
  const [{ service: id }, query] = await Promise.all([params, searchParams]);
  const service = findPublicService(id);
  if (!service) notFound();
  const language = publicLanguage(query);
  const example = publicTemplates.find(template => template.id === service.example);
  return publicContentMetadata(`/services/${service.id}`, language, service.title[language], service.summary[language], example?.image);
}

export default async function ServicePage({ params, searchParams }: PageProps) {
  const [{ service: id }, query] = await Promise.all([params, searchParams]);
  const language = publicLanguage(query);
  const isAr = language === 'ar';
  const service = findPublicService(id);
  if (!service) notFound();
  const example = publicTemplates.find(template => template.id === service.example);
  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><PublicBlock language={language}>
    <Link className="zpub-back" href={publicHref('/services', language)} prefetch={false}>{isAr ? 'جميع الخدمات' : 'All services'}</Link>
    <PublicHero label={service.label[language]} title={service.title[language]} detail={service.outcome[language]}
      actions={<PublicButton href={startRequest(language, { service: service.id })} primary>{isAr ? 'اطلب هذه الخدمة' : 'Request this service'}</PublicButton>}>
      <div className={`zpub-icon-panel zpub-icon-${service.id}`} data-service-card={service.id}><ServiceMark service={service.id} /></div>
    </PublicHero>
    <section className="zpub-section">
      <PublicSectionTitle title={isAr ? 'أنواع المشاريع' : 'Project types'} />
      <div className="zpub-category-grid">{service.categories.map(category => (
        <PublicButton key={category.id} href={startRequest(language, { service: service.id, category: category.id })}>{category.label[language]}</PublicButton>
      ))}</div>
    </section>
    <section className="zpub-section zpub-columns">
      <div><PublicSectionTitle title={isAr ? 'ما الذي نبنيه؟' : 'What we build'} />
        <ul className="zpub-feature-list">{service.features.map(feature => <li key={feature.en}>{feature[language]}</li>)}</ul>
      </div>
      {example && <div><PublicSectionTitle title={isAr ? 'جرّب نموذجاً' : 'Try a demo'} /><ExampleTiles templates={[example]} language={language} /></div>}
    </section>
    <section className="zpub-section"><PublicSectionTitle title={isAr ? 'خطوات العمل' : 'Our process'} /><ProcessSteps language={language} /></section>
    <section className="zpub-section">
      <PublicSectionTitle title={isAr ? 'أسئلة شائعة' : 'Frequently asked questions'} />
      <div className="zpub-faq">{service.faq.map(item => (
        <details key={item.question.en}><summary>{item.question[language]}</summary><p>{item.answer[language]}</p></details>
      ))}</div>
    </section>
    <PublicCallout language={language} service={service.id} />
  </PublicBlock></PlatformShell>;
}
