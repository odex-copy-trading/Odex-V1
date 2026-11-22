'use client';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-2xl border border-rose-400/35 bg-rose-400/10 p-6 text-center">
      <h1 className="text-lg font-semibold">This panel crashed</h1>
      <p className="mt-2 text-sm text-fg2">{error.message || 'Unexpected error.'}</p>
      <button type="button" onClick={reset} className="mt-5 inline-flex h-8.5 items-center rounded-[0.6rem] border border-line bg-card px-3.5 text-sm hover:bg-raised">Try again</button>
    </div>
  );
}
