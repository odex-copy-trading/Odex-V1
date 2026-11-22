import type { Metadata } from 'next';
import { TreasuryView } from '@/features/treasury/TreasuryView';

export const metadata: Metadata = { title: 'Treasury & inventory' };

export default function Page() {
  return <TreasuryView />;
}
