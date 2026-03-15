-- Offline wallet and offline transaction support
-- Safe additive migration: does not modify existing online transaction flow.

create table if not exists public.offline_wallets (
  id bigserial primary key,
  user_id text not null unique,
  btc numeric not null default 0,
  eth numeric not null default 0,
  usdt numeric not null default 0,
  nonce bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.offline_wallet_loads (
  id bigserial primary key,
  load_id text not null unique,
  user_id text not null,
  token text not null,
  amount numeric not null check (amount > 0),
  source_wallet_type text not null default 'main_wallet',
  status text not null default 'synced',
  created_at timestamptz not null default now(),
  synced_at timestamptz
);

create table if not exists public.offline_transactions (
  id bigserial primary key,
  tx_id text not null unique,
  from_user_id text not null,
  to_user_id text not null,
  merchant_id text,
  amount numeric not null check (amount > 0),
  token text not null,
  is_offline_payment boolean not null default true,
  sync_status text not null default 'pending',
  mode text not null default 'offline',
  status text not null,
  nonce bigint,
  signature text,
  source_device_id text,
  local_server_id text,
  offline_created_at timestamptz,
  offline_received_at timestamptz,
  blockchain_synced_at timestamptz,
  created_at timestamptz not null default now(),
  synced_at timestamptz,
  sync_error text
);

create index if not exists idx_offline_transactions_status
  on public.offline_transactions (status);

create index if not exists idx_offline_transactions_merchant
  on public.offline_transactions (merchant_id);

create index if not exists idx_offline_wallet_loads_user
  on public.offline_wallet_loads (user_id);

alter table public.transactions
  add column if not exists is_offline_payment boolean default false;

alter table public.transactions
  add column if not exists offline_created_at timestamptz;

alter table public.transactions
  add column if not exists offline_received_at timestamptz;

alter table public.transactions
  add column if not exists blockchain_synced_at timestamptz;

alter table public.transactions
  add column if not exists sync_status text;
