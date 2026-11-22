import type { Metadata } from 'next';
import { WatchlistView } from '@/features/watchlist/WatchlistView';

export const metadata: Metadata = { title: 'KOL watchlist' };

export default function Page() {
  return <WatchlistView />;
}
