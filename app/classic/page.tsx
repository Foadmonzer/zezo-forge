import type { Metadata } from 'next';
import LegacyPage from '../legacy-page';

export const metadata: Metadata = {
  title: 'ZEZO Forge',
  robots: { index: false, follow: false },
  referrer: 'no-referrer'
};

export default function ClassicPage() {
  return <LegacyPage />;
}
