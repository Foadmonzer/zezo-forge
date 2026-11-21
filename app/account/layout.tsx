
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { privatePageMetadata } from '../platform/share-metadata';
import '../platform/customer.css';

export const metadata: Metadata = {
  ...privatePageMetadata,
  title: 'حسابي | ZEZO Forge',
};

export default function AccountLayout({ children }: { children: ReactNode }) {
  return children;
}
