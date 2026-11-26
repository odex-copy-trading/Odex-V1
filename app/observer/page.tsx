import type { Metadata } from 'next';
import { ObserverView } from '@/features/observer/ObserverView';

export const metadata: Metadata = { title: 'Quant Observer · Whal Bot' };
export default function Page() { return <ObserverView />; }
