import type { Metadata } from 'next';
import { OverviewView } from '@/features/overview/OverviewView';

export const metadata: Metadata = { title: 'Live feed' };

export default function Page() {
  return <OverviewView />;
}
