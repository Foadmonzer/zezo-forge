
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../platform/customer.css';

export const metadata: Metadata = {
  title: 'حسابي | ZEZO Forge',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function AccountLayout({ children }: { children: ReactNode }) {
  return children;
}
