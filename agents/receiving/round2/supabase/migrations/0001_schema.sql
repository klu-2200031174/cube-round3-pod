-- Receiving Manager schema. Tenancy isolation first (engineering rule 1):
-- every table carries org_id, RLS is ENABLED and FORCED, and access goes through org membership.

create table public.orgs (
  id   text primary key,          -- e.g. org_demo_alpha
  name text not null
);

create table public.org_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id  text not null references public.orgs (id) on delete cascade,
  role    text not null default 'operator' check (role in ('operator', 'supervisor')),
  primary key (user_id, org_id)
);

-- SECURITY DEFINER so policies can check membership without recursing into org_members' own RLS.
create or replace function public.is_member(org text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m where m.org_id = org and m.user_id = auth.uid()
  );
$$;
revoke all on function public.is_member(text) from public;
grant execute on function public.is_member(text) to authenticated;

-- Expected side: PO line + agreed spec. One row per unit, keyed by the chain-wide unit_id.
create table public.po_lines (
  unit_id                  text primary key,
  org_id                   text not null references public.orgs (id),
  po_number                text not null,
  po_line                  int  not null,
  supplier                 text not null,
  sku                      text not null,
  asin                     text not null,
  product_title            text not null,
  spec_colour              text not null,
  spec_variant             text not null,
  spec_components          text[] not null,
  cartons_ordered          int not null check (cartons_ordered >= 0),
  units_per_carton_ordered int not null check (units_per_carton_ordered >= 0),
  qty_ordered              int not null check (qty_ordered >= 0),
  unique (org_id, po_number, po_line)
);

-- One row per inspection. `evidence` is the full evidence record (see contract/). Rows are never
-- updated: a retry of a pending record inserts a new row pointing at it via retry_of.
create table public.inspections (
  id           uuid primary key default gen_random_uuid(),
  record_id    text not null unique,
  unit_id      text not null references public.po_lines (unit_id),
  org_id       text not null references public.orgs (id),
  status       text not null check (status in ('complete', 'pending')),
  overall      text not null check (overall in ('ACCEPT', 'EXCEPTION', 'REVIEW')),
  evidence     jsonb not null,
  content_hash text not null,
  operator_id  text not null,
  retry_of     uuid references public.inspections (id),
  created_by   uuid not null default auth.uid(),
  created_at   timestamptz not null default now(),
  -- the record inside must agree with the row it's stored in
  check (evidence ->> 'org_id' = org_id and evidence ->> 'record_id' = record_id and evidence ->> 'content_hash' = content_hash)
);
create index on public.inspections (org_id, created_at desc);
create index on public.inspections (unit_id);

create table public.inspection_photos (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections (id) on delete cascade,
  org_id        text not null references public.orgs (id),
  idx           int  not null,           -- matches the "#N" label the model saw
  role          text not null,
  path          text not null,           -- storage path: {org_id}/{uuid}.{ext}; a retry links the same objects
  sha256        text not null,
  unique (inspection_id, idx),
  check (split_part(path, '/', 1) = org_id)
);

-- Overrides are data (honesty rule): append-only, original verdict kept alongside the new one.
create table public.overrides (
  id               uuid primary key default gen_random_uuid(),
  inspection_id    uuid not null references public.inspections (id) on delete cascade,
  org_id           text not null references public.orgs (id),
  check_name       text not null,
  original_verdict text not null check (original_verdict in ('PASS', 'FAIL', 'UNCERTAIN')),
  new_verdict      text not null check (new_verdict in ('PASS', 'FAIL', 'UNCERTAIN')),
  reason           text not null check (length(trim(reason)) >= 3),
  operator_id      text not null,
  created_by       uuid not null default auth.uid(),
  created_at       timestamptz not null default now()
);
create index on public.overrides (inspection_id, created_at);

-- ── Row-level security: enabled AND forced on every table ────────────────────────────────
alter table public.orgs              enable row level security;
alter table public.orgs              force  row level security;
alter table public.org_members       enable row level security;
alter table public.org_members       force  row level security;
alter table public.po_lines          enable row level security;
alter table public.po_lines          force  row level security;
alter table public.inspections       enable row level security;
alter table public.inspections       force  row level security;
alter table public.inspection_photos enable row level security;
alter table public.inspection_photos force  row level security;
alter table public.overrides         enable row level security;
alter table public.overrides         force  row level security;

create policy orgs_read on public.orgs for select to authenticated using (public.is_member(id));
create policy members_read_own on public.org_members for select to authenticated using (user_id = auth.uid());

create policy po_read on public.po_lines for select to authenticated using (public.is_member(org_id));

create policy insp_read on public.inspections for select to authenticated using (public.is_member(org_id));
create policy insp_insert on public.inspections for insert to authenticated
  with check (public.is_member(org_id) and created_by = auth.uid());
-- no update / delete policies: records are immutable for app users

create policy photos_read on public.inspection_photos for select to authenticated using (public.is_member(org_id));
create policy photos_insert on public.inspection_photos for insert to authenticated with check (public.is_member(org_id));

create policy ovr_read on public.overrides for select to authenticated using (public.is_member(org_id));
create policy ovr_insert on public.overrides for insert to authenticated
  with check (public.is_member(org_id) and created_by = auth.uid());
-- no update / delete policies: overrides are append-only

-- ── Photo storage: private bucket, first path segment must be one of the caller's orgs ────
insert into storage.buckets (id, name, public) values ('receiving-photos', 'receiving-photos', false)
on conflict (id) do update set public = false;

create policy rcv_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'receiving-photos' and public.is_member((storage.foldername(name))[1]));
create policy rcv_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receiving-photos' and public.is_member((storage.foldername(name))[1]));
