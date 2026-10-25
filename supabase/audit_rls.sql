-- LogNavAK — contrôle de la RLS. À jouer dans Supabase > SQL Editor.
-- Lecture seule : ce fichier ne modifie RIEN, il ne fait que montrer.
--
-- POURQUOI. La clé « publiable » (window.__SB_KEY) est dans index.html,
-- et c'est normal : elle est faite pour être publique. Mais elle n'est
-- SANS DANGER que si la RLS (Row Level Security) est juste sur CHAQUE
-- table. Une seule table sans politique, et n'importe qui ayant lu la
-- page peut lire — ou écrire — les données de tout le monde.
--
-- Ce qu'il faut voir en sortie :
--   1. AUCUNE ligne. Chaque table doit avoir la RLS activée.
--   2. AUCUNE ligne, sauf une table volontairement fermée à la clé
--      publiable (RLS activée + zéro politique = tout est refusé).
--   3. Pour chaque table de données : des politiques dont la condition
--      ramène à l'utilisateur (auth.uid() = ...). Une politique dont la
--      condition est « true » ouvre la table à tous.
--   4. Le rôle « anon » ne devrait pas porter de droits d'écriture
--      (INSERT/UPDATE/DELETE) sur une table de données.

-- 1 ------ tables de public SANS RLS : à corriger en premier ----------
select c.relname as table_sans_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and not c.relrowsecurity
 order by 1;

-- 2 ------ RLS activée mais AUCUNE politique --------------------------
select c.relname as table_sans_politique
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and c.relrowsecurity
   and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
 order by 1;

-- 3 ------ qui peut faire quoi, table par table -----------------------
--  « qual » est la condition de lecture, « with_check » celle d'écriture.
--  Une condition « true » sur une table de données est une porte ouverte.
select tablename, policyname, cmd, roles::text as roles, qual, with_check
  from pg_policies
 where schemaname = 'public'
 order by tablename, cmd, policyname;

-- 4 ------ droits accordés au rôle anonyme ----------------------------
--  C'est le rôle sous lequel agit la clé publiable tant que personne
--  n'est connecté.
select table_name,
       string_agg(distinct privilege_type, ', ' order by privilege_type) as droits_anon
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee = 'anon'
 group by table_name
 order by table_name;
