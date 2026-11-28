-- Buzzbite schema. Every table hangs off a workspace so the app can become
-- multi-tenant (one workspace per customer) without a data migration.

create extension if not exists pgcrypto;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  profile jsonb not null,
  logo_on_light text,   -- data URL of the logo used on light backgrounds
  logo_on_dark text,    -- data URL of the logo used on dark backgrounds
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists brands_workspace_idx on brands(workspace_id);

create table if not exists ideas (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  title text not null,
  angle text not null,
  pillar text not null default '',
  format text not null default 'image',  -- image | video
  status text not null default 'new',    -- new | used | dismissed
  created_at timestamptz not null default now()
);
create index if not exists ideas_brand_idx on ideas(brand_id, created_at desc);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  idea_id uuid references ideas(id) on delete set null,
  publish_on date,
  status text not null default 'draft',  -- draft | approved | posted
  spec jsonb not null,                   -- template + visual fields
  linkedin text not null default '',
  instagram text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists posts_brand_idx on posts(brand_id, publish_on);

-- Photos and video clips: uploaded, or generated with fal.ai.
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  kind text not null,                     -- image | video
  status text not null default 'ready',   -- ready | pending | failed
  source text not null default 'upload',  -- upload | ai
  url text,                               -- public Vercel Blob URL once ready
  description text not null default '',
  fal_endpoint text,
  fal_request_id text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists media_brand_idx on media(brand_id, created_at desc);

-- Trend radar: Claude's web research, turned into post recommendations.
create table if not exists trend_reports (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  summary text not null,
  items jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists trend_reports_brand_idx on trend_reports(brand_id, created_at desc);

-- v2: posting plan per brand, media linked to the post it was made for, post titles.
alter table brands add column if not exists settings jsonb not null default '{"days":[0,2,4],"time":"10:00"}'::jsonb;
alter table media add column if not exists post_id uuid references posts(id) on delete set null;
alter table media add column if not exists role text;          -- image | video, when made for a post
create index if not exists media_post_idx on media(post_id);
alter table posts add column if not exists title text not null default '';
alter table posts add column if not exists pillar text not null default '';
-- post status: making (photos/video still generating) | review | approved | posted
alter table posts add column if not exists issue text;  -- why a photo or video could not be made

-- v4: auto-posting through Zernio.
-- brands.social: { profileId, accounts: [{ id, platform, name, username, picture }] }
-- posts.publishing: { targets, files, filesKey, zernioId, state, error, urls, scheduledFor }
alter table brands add column if not exists social jsonb;
alter table posts add column if not exists publishing jsonb;

-- v5: sign-ups from the website (waitlist, campaign enquiries, creators).
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  kind text not null,              -- waitlist | campaign | creator
  email text not null,
  name text not null default '',
  company text not null default '',
  handle text not null default '',
  message text not null default '',
  source text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists leads_created on leads (created_at desc);

-- v6: accounts and billing.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,          -- stored lower-case
  name text not null default '',
  password_hash text not null,         -- scrypt: salt:hash (hex)
  created_at timestamptz not null default now()
);
create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member', -- owner | member
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create table if not exists invites (
  token text primary key,
  kind text not null,                  -- signup (a new workspace) | team (join a workspace)
  workspace_id uuid references workspaces(id) on delete cascade,
  email text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
-- plan: internal | trial | starter | growth | agency; status: trialing | active | past_due | canceled
alter table workspaces add column if not exists plan text not null default 'trial';
alter table workspaces add column if not exists plan_status text not null default 'trialing';
alter table workspaces add column if not exists trial_ends_at timestamptz;
alter table workspaces add column if not exists billing jsonb not null default '{}'::jsonb;

-- v7: alerts for work that failed while no one was watching; usage costs.
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  post_id uuid references posts(id) on delete cascade,
  kind text not null,                 -- media | schedule | publish
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists alerts_open_one on alerts (post_id, kind) where resolved_at is null;
create index if not exists alerts_workspace_open on alerts (workspace_id) where resolved_at is null;
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid references brands(id) on delete set null,
  post_id uuid references posts(id) on delete set null,
  provider text not null,             -- anthropic | fal
  model text not null,
  action text not null default '',    -- what it was for, e.g. plan, revise, image, video
  units jsonb not null default '{}'::jsonb,
  cost_usd numeric(10,4) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists usage_workspace_month on usage_events (workspace_id, created_at);

-- v8: security basics. Sign-in attempts (rate limiting), password reset links,
-- and a session version so changing a password signs out every other device.
alter table users add column if not exists session_version int not null default 0;
create table if not exists auth_attempts (
  key text not null,                  -- "login:email:<email>", "login:ip:<ip>", "reset:ip:<ip>", ...
  at timestamptz not null default now()
);
create index if not exists auth_attempts_key_at on auth_attempts (key, at);
create table if not exists password_resets (
  token_hash text primary key,        -- sha256 of the token in the link; the link itself is never stored
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- v9: results. Per-post metrics and follower counts read from Zernio's analytics.
create table if not exists post_metrics (
  post_id uuid not null references posts(id) on delete cascade,
  platform text not null,
  brand_id uuid not null references brands(id) on delete cascade,
  impressions int not null default 0, reach int not null default 0, views int not null default 0,
  likes int not null default 0, comments int not null default 0, shares int not null default 0,
  saves int not null default 0, clicks int not null default 0, follows int not null default 0,
  url text, published_at timestamptz, synced_at timestamptz not null default now(),
  primary key (post_id, platform)
);
create index if not exists post_metrics_brand on post_metrics (brand_id, published_at);
create table if not exists brand_followers (
  brand_id uuid not null references brands(id) on delete cascade,
  platform text not null,
  day date not null,
  followers int not null,
  primary key (brand_id, platform, day)
);
create table if not exists brand_analytics (
  brand_id uuid primary key references brands(id) on delete cascade,
  synced_at timestamptz,
  access boolean,                     -- false when the Zernio analytics add-on is off
  error text
);

-- v10: notifications: what happened (posted, failed, ready to review, nothing approved for tomorrow).
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid references brands(id) on delete cascade,
  post_id uuid references posts(id) on delete set null,
  kind text not null,                 -- posted | failed | review | gap
  title text not null,
  body text not null default '',
  link text not null default '',
  dedupe text,                        -- one notification per key, e.g. gap:<brand>:<date>
  created_at timestamptz not null default now(),
  read_at timestamptz,
  emailed_at timestamptz
);
create unique index if not exists notifications_dedupe on notifications (workspace_id, dedupe) where dedupe is not null;
create index if not exists notifications_ws_time on notifications (workspace_id, created_at desc);
