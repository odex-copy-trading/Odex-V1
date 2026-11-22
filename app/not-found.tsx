import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="num text-sm text-muted">404</p>
      <h1 className="mt-2 text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm text-fg2">That route doesn’t exist in the terminal.</p>
      <Link href="/" className="mt-6 inline-flex h-8.5 items-center rounded-[0.6rem] border border-line bg-card px-3.5 text-sm hover:bg-raised">Back to live feed</Link>
    </div>
  );
}
