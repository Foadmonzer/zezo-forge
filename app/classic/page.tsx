import type { Metadata } from 'next';
import LegacyPage from '../legacy-page';
import { privatePageMetadata } from '../platform/share-metadata';

export const metadata: Metadata = {
  ...privatePageMetadata,
  title: 'ZEZO Forge',
};

export default function ClassicPage() {
  return <LegacyPage />;
}
