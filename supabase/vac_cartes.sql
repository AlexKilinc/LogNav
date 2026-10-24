-- ============================================================================
-- Cartes VAC géoréférencées — rangement dans le compte
-- ============================================================================
-- À jouer UNE fois dans Supabase > SQL Editor.
--
-- Jusqu'ici les cartes VAC ne vivaient que sur l'appareil (IndexedDB) : caler
-- une planche sur l'ordinateur ne la donnait pas au téléphone, et un
-- effacement du stockage par le navigateur les perdait sans retour.
-- Cette table les attache au compte : elles suivent le pilote d'un appareil à
-- l'autre, et survivent à un effacement local.
--
-- Poids : une planche est ramenée à 2200 px de large et gravée en WebP ou
-- JPEG, soit 0,3 à 1 Mo une fois encodée en base64. Postgres range cela hors
-- ligne (TOAST) sans difficulté ; l'application, elle, ne renvoie l'image que
-- lorsqu'elle a réellement changé — déplacer un coin n'envoie que le calage.
-- ============================================================================

create table if not exists public.vac_cartes (
  id       text primary key,                 -- identifiant fabriqué par l'appli
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null default '',         -- « LFPN », « LFOX »…
  aero     text not null default '',         -- code OACI si connu
  corners  jsonb,                            -- les 4 coins, dans l'ordre du calage
  orig     jsonb,                            -- calage d'origine, pour « rétablir »
  w        integer not null default 0,       -- taille de la planche, en pixels
  h        integer not null default 0,
  opacity  real    not null default 1,
  img      text,                             -- la planche (data:image/…;base64,…)
  maj      timestamptz not null default now()
);

create index if not exists vac_cartes_user_idx on public.vac_cartes(user_id);

-- Chaque pilote ne voit et ne modifie QUE ses propres cartes.
alter table public.vac_cartes enable row level security;

drop policy if exists "vac : lecture par le propriétaire"     on public.vac_cartes;
drop policy if exists "vac : écriture par le propriétaire"    on public.vac_cartes;
drop policy if exists "vac : mise à jour par le propriétaire" on public.vac_cartes;
drop policy if exists "vac : effacement par le propriétaire"  on public.vac_cartes;

create policy "vac : lecture par le propriétaire"
  on public.vac_cartes for select
  using (auth.uid() = user_id);

create policy "vac : écriture par le propriétaire"
  on public.vac_cartes for insert
  with check (auth.uid() = user_id);

create policy "vac : mise à jour par le propriétaire"
  on public.vac_cartes for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "vac : effacement par le propriétaire"
  on public.vac_cartes for delete
  using (auth.uid() = user_id);

-- Vérification rapide, une fois la table créée :
--   select id, name, w, h, length(img) as octets, maj from public.vac_cartes;
