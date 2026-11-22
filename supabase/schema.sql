-- Whal Bot Terminal — Supabase PostgreSQL Schema
-- Paste into Supabase Dashboard -> SQL Editor -> Run.
-- Note: Never store private keys or raw API secrets in Supabase tables;
-- secrets stay encrypted on the engine/control-plane host.

create table if not exists public.config_versions (
  version integer primary key,
  config jsonb not null,
  created_at timestamptz not null default now(),
  actor text not null default 'operator'
);

create table if not exists public.kols (
  id text primary key,
  label text not null,
  pubkey text not null unique,
  quote text not null default 'SOL',
  trigger_margin double precision not null,
  buy_size_sol double precision not null,
  max_curve_reserve_sol double precision not null,
  enabled boolean not null default true,
  stats jsonb not null default '{"wins":0,"losses":0,"realizedSol":0,"lastSeenSlot":0}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.bursts (
  id text primary key,
  ts bigint not null,
  slot bigint not null,
  kind text not null,
  kol_id text,
  mint text not null,
  symbol text not null,
  image text,
  venue text not null,
  size_sol double precision not null,
  fanout integer not null default 0,
  winner text,
  signature text,
  cu_used integer not null default 0,
  reverts jsonb not null default '{"duplicate":0,"mutex":0,"kolNotLanded":0,"slippage":0,"expired":0}'::jsonb,
  outcome text not null,
  note text
);
create index if not exists idx_bursts_ts on public.bursts (ts desc);
create index if not exists idx_bursts_mint on public.bursts (mint);

create table if not exists public.closed_positions (
  id text primary key,
  mint text not null,
  symbol text not null,
  venue text not null,
  closed_at bigint not null,
  cost_sol double precision not null,
  realized_sol double precision not null,
  reason text not null,
  payload jsonb not null
);
create index if not exists idx_closed_positions_closed_at on public.closed_positions (closed_at desc);

create table if not exists public.sweeps (
  id text primary key,
  ts bigint not null,
  slot bigint not null,
  wsol_in double precision not null,
  usdc_out double precision not null,
  route text not null,
  status text not null
);
create index if not exists idx_sweeps_ts on public.sweeps (ts desc);

create table if not exists public.audit_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  actor text not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);

-- Enable Row Level Security (service-role / backend manages writes)
alter table public.config_versions enable row level security;
alter table public.kols enable row level security;
alter table public.bursts enable row level security;
alter table public.closed_positions enable row level security;
alter table public.sweeps enable row level security;
alter table public.audit_log enable row level security;
