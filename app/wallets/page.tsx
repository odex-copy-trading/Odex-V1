import type { Metadata } from 'next';
import { WalletsView } from '@/features/wallets/WalletsView';

export const metadata: Metadata = { title: 'Wallets · Whal Bot' };

export default function WalletsPage() {
  return <WalletsView />;
}
