export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded-md bg-raised" />
      <div className="h-24 animate-pulse rounded-2xl bg-raised" />
      <div className="h-96 animate-pulse rounded-2xl bg-raised" />
    </div>
  );
}
