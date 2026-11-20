
import { CustomerWorkspace } from '../../platform/customer-workspace';
import { languageFrom, type Search } from '../../platform/customer-data';
import { PlatformShell } from '../../platform/shell';

export default async function AccountOverviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const language = languageFrom(query);
  return <PlatformShell language={language}><CustomerWorkspace language={language} view="overview" /></PlatformShell>;
}
