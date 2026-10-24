-- LogNavAK — les DOCUMENTS du pilote : table + rangement des fichiers.
--
-- À QUOI ÇA SERT. L'écran « Doc » tient les documents qu'on veut avoir
-- sous la main en vol : hauteur de survol, signaux d'interception,
-- signaux lumineux, check-list, manuel de vol, mémo perso. Ils doivent
-- SUIVRE LE PILOTE d'un appareil à l'autre — c'est la demande.
--
-- POURQUOI UN RANGEMENT DE FICHIERS ET NON UNE COLONNE. Un manuel de vol
-- pèse dix à vingt mégaoctets. Le mettre en base, encodé en texte, c'est
-- une ligne de trente mégaoctets à relire à chaque synchronisation. Le
-- rangement de fichiers de Supabase est fait pour ça : la base ne garde
-- que la fiche du document, le fichier vit à côté et ne se télécharge
-- qu'une fois, puis reste sur l'appareil.
--
-- CE QUE CE FICHIER CRÉE
--   1. le seau « docs », privé ;
--   2. les règles d'accès : chacun chez soi, et un dossier « commun » que
--      tout le monde LIT et que seul le propriétaire ÉCRIT ;
--   3. la table « documents », la fiche de chaque document.
--
-- LES DOCUMENTS COMMUNS. Ceux qui valent pour tous — hauteur de survol,
-- signaux d'interception, signaux lumineux — sont déposés UNE FOIS par le
-- propriétaire du club et apparaissent chez tout le monde, en lecture
-- seule. C'est le dossier « commun/ » du seau, et la colonne « commun »
-- de la table.
--
-- COMMENT LE JOUER. Supabase > SQL Editor > New query, coller ce fichier,
-- Run. Rejouable sans dommage : tout est en « if not exists » ou en
-- « on conflict do nothing ».
--
-- VÉRIFICATION. Les deux requêtes de la fin doivent répondre : le seau
-- « docs » d'une part, les quatre règles d'autre part.

-- 1 ---------------------------------------------------------------- seau
insert into storage.buckets (id, name, public)
values ('docs', 'docs', false)
on conflict (id) do nothing;

-- 2 -------------------------------------------------------------- accès
-- Chacun chez soi : le premier dossier du chemin est l'identifiant du
-- pilote. « commun » est le dossier partagé.
drop policy if exists "docs lecture" on storage.objects;
create policy "docs lecture" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'docs'
    and ( (storage.foldername(name))[1] = auth.uid()::text
          or (storage.foldername(name))[1] = 'commun' )
  );

drop policy if exists "docs dépôt" on storage.objects;
create policy "docs dépôt" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "docs remplacement" on storage.objects;
create policy "docs remplacement" on storage.objects for update
  to authenticated
  using (
    bucket_id = 'docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "docs retrait" on storage.objects;
create policy "docs retrait" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 3 ------------------------------------------------------------- fiches
create table if not exists public.documents (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  nom        text not null default '',
  genre      text not null default 'pdf',      -- 'pdf' ou 'image'
  octets     bigint not null default 0,
  chemin     text not null default '',         -- où le fichier est rangé
  commun     boolean not null default false,
  rang       int not null default 0,
  maj        timestamptz not null default now()
);

alter table public.documents enable row level security;

-- On lit les siens ET les communs ; on n'écrit que les siens.
drop policy if exists "documents lecture" on public.documents;
create policy "documents lecture" on public.documents for select
  to authenticated using (user_id = auth.uid() or commun = true);

drop policy if exists "documents écriture" on public.documents;
create policy "documents écriture" on public.documents for insert
  to authenticated with check (user_id = auth.uid());

drop policy if exists "documents mise à jour" on public.documents;
create policy "documents mise à jour" on public.documents for update
  to authenticated using (user_id = auth.uid());

drop policy if exists "documents retrait" on public.documents;
create policy "documents retrait" on public.documents for delete
  to authenticated using (user_id = auth.uid());

create index if not exists documents_user_idx on public.documents (user_id);
create index if not exists documents_commun_idx on public.documents (commun);

-- Vérification 1 : le seau existe.
select id, public from storage.buckets where id = 'docs';

-- Vérification 2 : les règles sont posées (4 sur storage, 4 sur documents).
select schemaname, tablename, policyname
  from pg_policies
 where policyname like 'docs %' or policyname like 'documents %'
 order by tablename, policyname;
