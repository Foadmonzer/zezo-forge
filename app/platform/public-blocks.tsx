import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { publicHref, publicServices, startRequest, workSteps, type PublicLanguage, type PublicTemplate, type ServiceId } from './public-content';
import './public-content.css';

export function PublicBlock({ language, children }: { language: PublicLanguage; children: ReactNode }) {
  return <div className="ze-public" lang={language} dir={language === 'ar' ? 'rtl' : 'ltr'}>{children}</div>;
}

export function PublicHero({ title, detail, actions, children, label }: { title: string; detail: string; actions?: ReactNode; children?: ReactNode; label?: string }) {
  return (
    <header className={`zpub-hero${children ? ' zpub-hero-split' : ''}`}>
      <div className="zpub-hero-copy">
        {label && <p className="zpub-kicker"><bdi>{label}</bdi></p>}
        <h1>{title}</h1>
        <p className="zpub-lede">{detail}</p>
        {actions && <div className="zpub-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

const publicScenes = {
  hero: { src: '/assets/zezo-idea-to-product.svg', height: 550 },
  about: { src: '/assets/zezo-about-studio.svg', height: 560 },
};

export function PublicArt({ scene, lazy = false }: { scene: keyof typeof publicScenes; lazy?: boolean }) {
  const { src, height } = publicScenes[scene];
  return <figure className="zpub-scene" data-zezo-art={scene} aria-hidden="true">
    <img src={src} width={760} height={height} alt="" loading={lazy ? 'lazy' : 'eager'} fetchPriority={lazy ? undefined : 'high'} decoding="async" />
  </figure>;
}

export function PublicButton({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return <Link href={href} className={`zpub-button${primary ? ' zpub-primary' : ''}`} prefetch={false}>{children}<span aria-hidden="true">↗</span></Link>;
}

export function PublicSectionTitle({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="zpub-section-title"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</div>;
}

export function ServiceGrid({ language, includeRequest = false }: { language: PublicLanguage; includeRequest?: boolean }) {
  return <div className="zpub-service-grid">{publicServices.map(service => (
    <article className="zpub-service-tile" key={service.id} data-service-card={service.id}>
      <ServiceMark service={service.id} />
      <h3><Link href={publicHref(`/services/${service.id}`, language)} prefetch={false}>{service.title[language]}</Link></h3>
      <p>{service.summary[language]}</p>
      {includeRequest && <ul className="zpub-feature-list">{service.features.slice(0, 2).map(feature => <li key={feature.en}>{feature[language]}</li>)}</ul>}
      <Link className="zpub-inline-link" href={publicHref(`/services/${service.id}`, language)} prefetch={false}>
        {language === 'ar' ? 'تفاصيل الخدمة' : 'Service details'} <span aria-hidden="true">↗</span>
      </Link>
      {includeRequest && <PublicButton href={startRequest(language, { service: service.id })}>{language === 'ar' ? 'اطلب هذه الخدمة' : 'Request this service'}</PublicButton>}
    </article>
  ))}</div>;
}

export function ServiceMark({ service }: { service: ServiceId }) {
  const paths = {
    web: 'M4 6h16v12H4zM4 9h16M7 7.5h.01M9 7.5h.01M10 12 8 14l2 2m4-4 2 2-2 2',
    apps: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 14h4M9 7h6',
    ai: 'm12 2 2.7 6.8 7.3 3.2-7.3 3.2L12 22l-2.7-6.8L2 12l7.3-3.2L12 2zM18 3v4m-2-2h4',
    ideas: 'M9 17h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3zM12 7v4'
  };
  return (
    <span className={`zpub-service-mark zpub-mark-${service}`} aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"><path d={paths[service]} /></svg>
    </span>
  );
}

export function PublicPhoto({ template, language, hero = false }: { template: PublicTemplate; language: PublicLanguage; hero?: boolean }) {
  return <div className={`zpub-photo${hero ? ' zpub-photo-hero' : ''}`}>
    <Image
      src={template.image}
      alt={template.imageAlt[language]}
      fill
      sizes={hero ? '(max-width: 760px) 100vw, 600px' : '(max-width: 540px) 92vw, (max-width: 920px) 46vw, 380px'}
      loading={hero ? 'eager' : 'lazy'}
      fetchPriority={hero ? 'high' : undefined}
      decoding="async"
    />
  </div>;
}

export function ExampleTiles({ templates, language }: { templates: PublicTemplate[]; language: PublicLanguage }) {
  return <div className="zpub-examples">{templates.map(template => (
    <article className="zpub-example" key={template.id} data-template-id={template.id}>
      <Link href={publicHref(`/templates/${template.id}`, language)} className="zpub-example-link" prefetch={false}>
        <PublicPhoto template={template} language={language} />
        <div className="zpub-example-caption">
          <span>{language === 'ar' ? 'نموذج استعراضي' : 'Interactive demo'}</span>
          <h3>{template.title[language]} <span aria-hidden="true">↗</span></h3>
        </div>
      </Link>
    </article>
  ))}</div>;
}

export function ProcessSteps({ language }: { language: PublicLanguage }) {
  return <ol className="zpub-process">{workSteps.map((step, index) => (
    <li key={step.title.en}>
      <span className="zpub-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
      <h3>{step.title[language]}</h3>
      <p>{step.detail[language]}</p>
    </li>
  ))}</ol>;
}

export function PublicCallout({ language, service }: { language: PublicLanguage; service?: ServiceId }) {
  const isAr = language === 'ar';
  return (
    <section className="zpub-callout" aria-label={isAr ? 'ابدأ مع ZEZO' : 'Start with ZEZO'}>
      <div><h2>{isAr ? 'ما المشروع الذي ترغب في تنفيذه؟' : 'What project would you like to bring to life?'}</h2>
        <p>{isAr ? 'شاركنا فكرتك ومتطلبات مشروعك، وسنساعدك على تحويلها إلى حل رقمي متكامل.' : 'Tell us about your idea and what your project needs. We’ll help you turn it into a complete digital solution.'}</p></div>
      <PublicButton href={startRequest(language, service ? { service } : {})} primary>{isAr ? 'اطلب مشروعك' : 'Start a project'}</PublicButton>
    </section>
  );
}
