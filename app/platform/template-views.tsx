'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PublicButton, PublicPhoto } from './public-blocks';
import { findPublicService, publicHref, publicServices, startRequest, type Localized, type PublicLanguage, type PublicTemplate, type ServiceId } from './public-content';

type CatalogConfig = {
  templatePrices: Record<string, number | string | null>;
  templateActive: Record<string, boolean>;
  templateInclusions: Record<string, Partial<Localized>>;
};

type Pricing = { state: 'loading' } | { state: 'unavailable' } | { state: 'ready'; value: CatalogConfig };
const pageSize = 9;

let requestInFlight: Promise<CatalogConfig> | null = null;

function fetchCatalogConfig() {
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetch('/api/public', { cache: 'no-store', credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('Public catalog unavailable');
    const value = await response.json();
    if (!value || typeof value.templatePrices !== 'object' || !value.templatePrices ||
      typeof value.templateActive !== 'object' || !value.templateActive) throw new Error('Invalid public catalog');
    return { ...value, templateInclusions: value.templateInclusions || {} } as CatalogConfig;
  }).finally(() => { requestInFlight = null; });
  return requestInFlight;
}

function useCatalogPricing() {
  const [pricing, setPricing] = useState<Pricing>({ state: 'loading' });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    fetchCatalogConfig().then(value => {
      if (active) setPricing({ state: 'ready', value });
    }).catch(() => {
      if (active) setPricing({ state: 'unavailable' });
    });
    return () => { active = false; };
  }, [attempt]);
  return { pricing, reload: () => { setPricing({ state: 'loading' }); retry(value => value + 1); } };
}

function priceOf(template: PublicTemplate, pricing: Pricing) {
  if (pricing.state !== 'ready' || pricing.value.templateActive[template.id] === false) return null;
  const value = pricing.value.templatePrices[template.id];
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function PriceLabel({ template, pricing, language }: { template: PublicTemplate; pricing: Pricing; language: PublicLanguage }) {
  const isAr = language === 'ar';
  if (pricing.state === 'loading') return <span className="zpub-price is-muted">{isAr ? 'جارٍ تحميل السعر…' : 'Loading price…'}</span>;
  if (pricing.state === 'unavailable') return <span className="zpub-price is-muted">{isAr ? 'السعر غير متاح الآن' : 'Price temporarily unavailable'}</span>;
  if (pricing.value.templateActive[template.id] === false) return <span className="zpub-price is-muted">{isAr ? 'الطلب غير متاح مؤقتًا' : 'Temporarily unavailable to order'}</span>;
  const amount = priceOf(template, pricing);
  if (amount === null) return <span className="zpub-price">{isAr ? 'عرض سعر حسب الطلب' : 'Quote on request'}</span>;
  const formatted = new Intl.NumberFormat(isAr ? 'ar' : 'en', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 }).format(amount);
  return <span className="zpub-price">{isAr ? 'ابتداءً من' : 'From'} <bdi>{formatted}</bdi></span>;
}

function PricingNotice({ pricing, language, retry }: { pricing: Pricing; language: PublicLanguage; retry: () => void }) {
  if (pricing.state !== 'unavailable') return null;
  const isAr = language === 'ar';
  return <div role="status" className="zpub-data-notice">
    <span>{isAr ? 'تعذّر تحميل الأسعار. يمكنك معاينة القوالب الآن والمحاولة مجدّدًا.' : 'Prices didn’t load. You can preview templates and try again.'}</span>
    <button className="zpub-button" type="button" onClick={retry}>{isAr ? 'أعد المحاولة' : 'Retry'}</button>
  </div>;
}

function searchable(value: string) {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

export function TemplateLibrary({ templates, language, initialService }: { templates: PublicTemplate[]; language: PublicLanguage; initialService: ServiceId | 'all' }) {
  const [query, setQuery] = useState('');
  const [service, setService] = useState<ServiceId | 'all'>(initialService);
  const [sort, setSort] = useState<'featured' | 'name' | 'price'>('featured');
  const [limit, setLimit] = useState(pageSize);
  const { pricing, reload } = useCatalogPricing();
  const isAr = language === 'ar';
  const filtered = useMemo(() => {
    const term = searchable(query.trim());
    const matches = templates.filter(item => {
      const text = [item.title.ar, item.title.en, item.code, item.description.ar, item.description.en, item.kind].join(' ');
      return (service === 'all' || item.service === service) && (!term || searchable(text).includes(term));
    });
    if (sort === 'name') matches.sort((a, b) => a.title[language].localeCompare(b.title[language], language));
    if (sort === 'price') matches.sort((a, b) => {
      const first = priceOf(a, pricing), second = priceOf(b, pricing);
      if (first === null || second === null) return first === second ? 0 : first === null ? 1 : -1;
      return first - second;
    });
    return matches;
  }, [templates, query, service, sort, language, pricing]);
  return <>
    <section className="zpub-library" aria-label={isAr ? 'تصفية مكتبة القوالب' : 'Filter the template library'}>
      <div className="zpub-template-controls">
        <label>
          <span>{isAr ? 'ابحث في القوالب' : 'Search templates'}</span>
          <input type="search" name="query" autoComplete="off" value={query} onChange={event => { setQuery(event.target.value); setLimit(pageSize); }}
            placeholder={isAr ? 'اسم القالب أو رقمه…' : 'Template name or code…'} />
        </label>
        <label>
          <span>{isAr ? 'الخدمة' : 'Service'}</span>
          <select name="service" value={service} onChange={event => { setService(event.target.value as ServiceId | 'all'); setLimit(pageSize); }}>
            <option value="all">{isAr ? 'جميع الخدمات' : 'All services'}</option>
            {publicServices.map(item => <option key={item.id} value={item.id}>{item.title[language]}</option>)}
          </select>
        </label>
        <label>
          <span>{isAr ? 'الترتيب' : 'Sort by'}</span>
          <select name="sort" value={sort} onChange={event => { setSort(event.target.value as typeof sort); setLimit(pageSize); }}>
            <option value="featured">{isAr ? 'الترتيب الأصلي' : 'Default order'}</option>
            <option value="name">{isAr ? 'الاسم' : 'Name'}</option>
            <option value="price" disabled={pricing.state !== 'ready'}>{isAr ? 'من السعر الأقل إلى الأعلى' : 'Price, low to high'}</option>
          </select>
        </label>
      </div>
      <p aria-live="polite" className="zpub-results-count">{isAr ? `القوالب المعروضة (${Math.min(limit, filtered.length)} من ${filtered.length})` : `Showing ${Math.min(limit, filtered.length)} of ${filtered.length} templates`}</p>
      <PricingNotice pricing={pricing} language={language} retry={reload} />
      {!filtered.length && <div className="zpub-copy-panel">
        <h2>{isAr ? 'لم نجد قوالب مطابقة' : 'No matching templates'}</h2>
        <p>{isAr ? 'جرّب عبارة مختلفة أو اختر جميع الخدمات.' : 'Try a different term or select all services.'}</p>
        <button className="zpub-button" type="button" onClick={() => { setQuery(''); setService('all'); setLimit(pageSize); }}>{isAr ? 'إلغاء التصفية' : 'Clear filters'}</button>
      </div>}
      <div className="zpub-template-grid">
        {filtered.slice(0, limit).map(template => <article className="zpub-template-card" key={template.id} data-template-id={template.id}>
          <Link href={publicHref(`/templates/${template.id}`, language)} className="zpub-template-image-link" prefetch={false} aria-label={template.title[language]}>
            <PublicPhoto template={template} language={language} />
          </Link>
          <div className="zpub-template-card-content">
            <p className="zpub-template-category"><bdi>{template.code}</bdi><span>{findPublicService(template.service)?.title[language]}</span></p>
            <h2><Link href={publicHref(`/templates/${template.id}`, language)} prefetch={false}>{template.title[language]}</Link></h2>
            <p className="zpub-template-description">{template.description[language]}</p>
            <PriceLabel template={template} pricing={pricing} language={language} />
            <Link href={publicHref(`/templates/${template.id}`, language)} className="zpub-inline-link" prefetch={false}>
              {isAr ? 'تفاصيل القالب' : 'Template details'} <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </article>)}
      </div>
      {filtered.length > limit && <div className="zpub-load-more">
        <button className="zpub-button" type="button" onClick={() => setLimit(value => value + pageSize)}>
          {isAr ? 'عرض قوالب إضافية' : 'Show more templates'}
        </button>
      </div>}
    </section>
  </>;
}

export function TemplateDetailsActions({ template, language }: { template: PublicTemplate; language: PublicLanguage }) {
  const { pricing, reload } = useCatalogPricing();
  const isAr = language === 'ar';
  const canOrder = pricing.state === 'ready' && pricing.value.templateActive[template.id] !== false;
  const inclusion = pricing.state === 'ready' ? pricing.value.templateInclusions[template.id]?.[language] : undefined;
  const request = { service: template.service, category: template.category, template: template.id };

  return <aside className="zpub-price-panel" aria-label={isAr ? 'السعر والطلب' : 'Pricing and requests'}>
    <div aria-live="polite"><PriceLabel template={template} pricing={pricing} language={language} /></div>
    <PricingNotice pricing={pricing} language={language} retry={reload} />
    {inclusion && <p>{inclusion}</p>}
    {canOrder && <div className="zpub-actions">
      <PublicButton href={startRequest(language, { ...request, action: 'order' })} primary>{isAr ? 'اطلب هذا القالب' : 'Request this template'}</PublicButton>
      <PublicButton href={startRequest(language, { ...request, action: 'customize' })}>{isAr ? 'خصّص القالب' : 'Customize the template'}</PublicButton>
    </div>}
    <a className="zpub-inline-link" href={publicHref(`/?preview=${encodeURIComponent(template.id)}`, language)}>
      {isAr ? 'جرّب المعاينة التفاعلية' : 'Open interactive preview'} <span aria-hidden="true">↗</span>
    </a>
  </aside>;
}
