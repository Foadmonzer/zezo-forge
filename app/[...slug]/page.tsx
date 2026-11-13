import { notFound } from 'next/navigation';
import LegacyPage from '../legacy-page';

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: ['team'] }, { slug: ['activate'] }];
}

export default async function LegacyPathPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const route = slug.join('/');
  if (!['team', 'activate'].includes(route)) notFound();
  return <LegacyPage />;
}
