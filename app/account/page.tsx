
import { CustomerAccess } from '../platform/customer-access';
import { languageFrom, safeReturnPath, value, type Search } from '../platform/customer-data';
import { PlatformShell } from '../platform/shell';

export default async function AccountPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const language = languageFrom(query);
  return <PlatformShell language={language}><CustomerAccess language={language} suggestedMode={value(query.mode)} next={safeReturnPath(value(query.next))} /></PlatformShell>;
}
