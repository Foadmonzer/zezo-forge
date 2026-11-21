import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PlatformShell } from '../../platform/shell';
import { PublicBlock, PublicHero, PublicPhoto, PublicSectionTitle, ExampleTiles } from '../../platform/public-blocks';
import { findPublicService, publicContentMetadata, publicHref, publicLanguage, publicReferral, publicTemplates, type PublicQuery } from '../../platform/public-content';
import { TemplateDetailsActions } from '../../platform/template-views';

type PageProps = { params: Promise<{ template: string }>; searchParams: PublicQuery };
const templates = new Map(publicTemplates.map(template => [template.id, template]));

export const dynamicParams = false;
export function generateStaticParams() { return publicTemplates.map(({ id }) => ({ template: id })); }

export async function generateMetadata({ params, searchParams }: PageProps) {
  const [{ template: id }, query] = await Promise.all([params, searchParams]);
  const template = templates.get(id);
  if (!template) notFound();
  const language = publicLanguage(query);
  return publicContentMetadata(`/templates/${template.id}`, language, template.title[language], template.description[language], template.image);
}

export default async function TemplatePage({ params, searchParams }: PageProps) {
  const [{ template: id }, query] = await Promise.all([params, searchParams]);
  const language = publicLanguage(query);
  const isAr = language === 'ar';
  const template = templates.get(id);
  if (!template) notFound();
  const service = findPublicService(template.service);
  const related = publicTemplates.filter(item => item.id !== template.id && item.service === template.service).slice(0, 3);
  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><PublicBlock language={language}>
    <Link className="zpub-back" href={publicHref('/templates', language)} prefetch={false}>{isAr ? 'مكتبة القوالب' : 'Template library'}</Link>
    <PublicHero label={`${isAr ? 'قالب استعراضي' : 'Interactive template'} · ${template.code}`}
      title={template.title[language]} detail={template.description[language]}
      actions={<a className="zpub-button" href={publicHref(`/?preview=${encodeURIComponent(template.id)}`, language)}>
        {isAr ? 'جرّب المعاينة التفاعلية' : 'Open interactive preview'} <span aria-hidden="true">↗</span>
      </a>}>
      <div data-template-id={template.id}><PublicPhoto template={template} language={language} hero /></div>
    </PublicHero>
    <section className="zpub-section zpub-columns">
      <div><PublicSectionTitle title={isAr ? 'ميزات القالب' : 'Template features'} />
        <ul className="zpub-feature-list">{template.features[language].map(feature => <li key={feature}>{feature}</li>)}</ul>
        {service && <Link className="zpub-inline-link" href={publicHref(`/services/${service.id}`, language)} prefetch={false}>{service.title[language]} <span aria-hidden="true">↗</span></Link>}
      </div>
      <TemplateDetailsActions template={template} language={language} />
    </section>
    <section className="zpub-section"><PublicSectionTitle title={isAr ? 'قوالب ذات صلة' : 'Related templates'} /><ExampleTiles templates={related} language={language} /></section>
  </PublicBlock></PlatformShell>;
}
