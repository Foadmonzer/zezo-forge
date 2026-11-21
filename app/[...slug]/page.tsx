import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import LegacyPage from '../legacy-page';
import { privatePageMetadata } from '../platform/share-metadata';

export const metadata: Metadata = {
  ...privatePageMetadata,
  title: 'مساحة فريق ZEZO',
};

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
