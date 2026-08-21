-- =====================================================================
--  LogNavAK — verrouillage de la base Supabase
--  A executer dans Supabase → SQL Editor, en une fois.
--  Idempotent : on peut le rejouer sans dommage.
--
--  Principe : la cle publiable est publique par construction — elle est
--  dans le code de l'application, que tout visiteur peut lire. Elle ne
--  protege donc rien. Ce qui protege, c'est la RLS : PostgreSQL n'accorde
--  a chaque requete que les lignes que la politique lui autorise, quelle
--  que soit la cle presentee.
--
--  Sans RLS, avec la seule cle publiable et sans compte :
--    - lire l'integralite des profils (noms, e-mails, telephones) ;
--    - lire, modifier et EFFACER les navigations et les traces de tous.
--  Avec ces regles, chacun ne voit et ne touche que ses propres lignes.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Qui est administrateur ?
--    Dans cette application, c'est le role « owner » (« admin » est accepte
--    par prudence, au cas ou la colonne prendrait un jour cette valeur).
--    Une politique posee sur « profiles » ne peut pas interroger
--    « profiles » : la lecture declencherait la politique, qui relirait la
--    table, sans fin. On passe donc par une fonction SECURITY DEFINER, qui
--    s'execute avec les droits de son proprietaire et echappe a la RLS.
--    search_path fige : sans cela, un schema pirate pourrait la detourner.
-- ---------------------------------------------------------------------
create or replace function public.est_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('owner','admin')
  );
$$;

revoke all on function public.est_admin() from public;
grant execute on function public.est_admin() to authenticated;


-- ---------------------------------------------------------------------
-- 2. RLS active partout.
--    « force » vaut aussi pour le proprietaire des tables : personne n'y
--    echappe, hormis les fonctions SECURITY DEFINER ci-dessus.
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.navigations enable row level security;
alter table public.traces      enable row level security;
alter table public.favorites   enable row level security;

alter table public.profiles    force row level security;
alter table public.navigations force row level security;
alter table public.traces      force row level security;
alter table public.favorites   force row level security;


-- ---------------------------------------------------------------------
-- 3. Le visiteur non connecte n'a rien a faire ici.
--    L'application exige une connexion avant toute requete : le role
--    « anon » ne sert qu'a s'authentifier.
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.navigations, public.traces, public.favorites from anon;


-- ---------------------------------------------------------------------
-- 4. profiles — chacun le sien ; l'administrateur les voit tous
--    (c'est ce dont a besoin l'ecran de validation des inscriptions).
-- ---------------------------------------------------------------------
drop policy if exists "profil : lecture de soi"        on public.profiles;
drop policy if exists "profil : lecture par l'admin"   on public.profiles;
drop policy if exists "profil : modification de soi"   on public.profiles;
drop policy if exists "profil : modification par l'admin" on public.profiles;

create policy "profil : lecture de soi"
  on public.profiles for select to authenticated
  using ( id = auth.uid() );

create policy "profil : lecture par l'admin"
  on public.profiles for select to authenticated
  using ( public.est_admin() );

create policy "profil : modification de soi"
  on public.profiles for update to authenticated
  using ( id = auth.uid() ) with check ( id = auth.uid() );

create policy "profil : modification par l'admin"
  on public.profiles for update to authenticated
  using ( public.est_admin() ) with check ( public.est_admin() );

-- Ni insertion ni suppression cote client : aucune politique, donc refus.
-- La ligne de profil doit etre creee par un declencheur sur auth.users
-- (SECURITY DEFINER), ou a la main par l'administrateur. Verifiez-le avant
-- de tester une inscription (voir le controle 3 en fin de fichier).

-- Le nerf de l'affaire. Sans quoi la politique « modification de soi »
-- laisserait n'importe qui s'ecrire role = 'owner' ou status = 'approved' et
-- s'octroyer la base entiere.
--   On ne peut pas simplement retirer le droit d'ecrire ces colonnes : c'est
--   l'application elle-meme qui les modifie quand vous validez une
--   inscription (« cloudProf(email, {status:'approved'}) »), et un droit de
--   colonne ne distingue pas l'administrateur du membre. Un declencheur, si :
--   il remet en place les anciennes valeurs pour quiconque n'est pas
--   administrateur, et laisse passer les siennes.
create or replace function public.profil_garde_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.est_admin() then
    new.id     := old.id;
    new.role   := old.role;
    new.status := old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists profil_garde_privileges on public.profiles;
create trigger profil_garde_privileges
  before update on public.profiles
  for each row execute function public.profil_garde_privileges();


-- ---------------------------------------------------------------------
-- 5. navigations, traces, favorites — strictement personnelles.
--    Noter l'importance du DELETE : l'application efface par identifiant
--    seul (« delete().in('id', …) »). Sans politique, un client malveillant
--    effacerait les navigations d'autrui en devinant des identifiants.
--    Avec elle, la suppression ne mord que sur ses propres lignes.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['navigations','traces','favorites'] loop
    execute format('drop policy if exists %I on public.%I', t||' : lecture',      t);
    execute format('drop policy if exists %I on public.%I', t||' : ecriture',     t);
    execute format('drop policy if exists %I on public.%I', t||' : modification', t);
    execute format('drop policy if exists %I on public.%I', t||' : suppression',  t);

    execute format(
      'create policy %I on public.%I for select to authenticated using ( user_id = auth.uid() )',
      t||' : lecture', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ( user_id = auth.uid() )',
      t||' : ecriture', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using ( user_id = auth.uid() ) with check ( user_id = auth.uid() )',
      t||' : modification', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using ( user_id = auth.uid() )',
      t||' : suppression', t);
  end loop;
end $$;

-- « upsert » est un INSERT qui peut devenir UPDATE : les deux politiques
-- sont necessaires, et le sont ci-dessus.


-- =====================================================================
--  CONTROLES — a lancer apres coup
-- =====================================================================

-- Controle 1 : RLS active sur les quatre tables (rowsecurity = true)
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class
--   where relname in ('profiles','navigations','traces','favorites');

-- Controle 2 : les politiques en place, table par table
--   select tablename, policyname, cmd, roles
--   from pg_policies where schemaname = 'public' order by tablename, policyname;

-- Controle 2 bis : le garde-fou des privileges est-il pose ?
--   select tgname from pg_trigger
--   where tgrelid = 'public.profiles'::regclass and not tgisinternal;
--   Doit rendre « profil_garde_privileges ».

-- Controle 3 : la ligne de profil est-elle creee par un declencheur ?
--   select tgname, tgrelid::regclass from pg_trigger
--   where not tgisinternal and tgrelid = 'auth.users'::regclass;
--   Si le resultat est vide, une inscription ne creera aucun profil et la
--   connexion echouera sur « Profil introuvable » : il faut alors ajouter
--   ce declencheur, ou creer les profils a la main.

-- Controle 4 : aucune table publique oubliee sans RLS
--   select tablename from pg_tables t
--   where schemaname = 'public'
--     and not exists (select 1 from pg_class c
--                     where c.relname = t.tablename and c.relrowsecurity);
