import type { Metadata } from 'next';
import { ExecutionView } from '@/features/execution/ExecutionView';

export const metadata: Metadata = { title: 'Execution & landers' };

export default function Page() {
  return <ExecutionView />;
}
