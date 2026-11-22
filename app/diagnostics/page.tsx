import type { Metadata } from 'next';
import { DiagnosticsView } from '@/features/diagnostics/DiagnosticsView';

export const metadata: Metadata = { title: 'Diagnostics · Whal Bot' };
export default function Page() { return <DiagnosticsView />; }
