
import { notFound } from 'next/navigation';
import { CustomerWorkspace } from '../../../platform/customer-workspace';
import { languageFrom, safeId, type Search } from '../../../platform/customer-data';
import { PlatformShell } from '../../../platform/shell';

export default async function AccountOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!safeId(id)) notFound();
  const language = languageFrom(query);
  return <PlatformShell language={language}><CustomerWorkspace language={language} view="order" orderId={id} /></PlatformShell>;
}
