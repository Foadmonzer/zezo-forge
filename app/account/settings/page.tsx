
import { CustomerWorkspace } from '../../platform/customer-workspace';
import { languageFrom, type Search, value } from '../../platform/customer-data';
import { PlatformShell } from '../../platform/shell';

export default async function AccountSettingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const language = languageFrom(query);
  return <PlatformShell language={language}><CustomerWorkspace language={language} view="settings" tab={value(query.tab)} conversationId={value(query.conversation)} /></PlatformShell>;
}
