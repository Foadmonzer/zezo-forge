
import type { Metadata } from 'next';
import { templateCatalog } from '../../public/template-catalog';
import { CustomerRequest } from '../platform/customer-request';
import { languageFrom, value, type Search } from '../platform/customer-data';
import { PlatformShell } from '../platform/shell';
import { publicContentMetadata, publicReferral } from '../platform/public-content';
import '../platform/customer.css';

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }): Promise<Metadata> {
  const query = await searchParams;
  const language = languageFrom(query);
  const meta = publicContentMetadata('/request', language,
    language === 'ar' ? 'اطلب مشروعك' : 'Request a project',
    language === 'ar' ? 'صف مشروعك الرقمي وأرسل طلبك إلى فريق ZEZO Forge.' : 'Describe your digital project and send your request to the ZEZO Forge team.');
  return value(query.conversation) ? { ...meta, robots: { index: false, follow: false }, referrer: 'no-referrer' } : meta;
}

const templates = templateCatalog.map(({ id, service, category, title }) => ({ id, service, category, title }));

export default async function RequestPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const language = languageFrom(query);
  const options = { service: value(query.service), category: value(query.category), template: value(query.template), action: value(query.action), conversation: value(query.conversation) };
  return <PlatformShell language={language} incomingReferral={publicReferral(query)}><CustomerRequest language={language} templates={templates} options={options} /></PlatformShell>;
}
