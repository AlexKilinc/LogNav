-- =====================================================================
--  LogNavAK — securite de la base Supabase : constat et controles
--
--  ATTENTION : ce fichier ne modifie rien, et c'est voulu.
--  Une version anterieure posait des politiques RLS et un declencheur.
--  Verification faite le 21 aout 2026, la base etait DEJA correctement
--  protegee : ces ajouts faisaient double emploi, et le declencheur
--  introduisait une regression — il annulait les modifications de role
--  faites depuis le SQL Editor. Tout a ete retire.
--
--  Ne rejouez donc jamais l'ancienne version. Celle-ci sert a verifier
--  que l'etat decrit plus bas tient toujours.
-- =====================================================================


-- ---------------------------------------------------------------------
--  L'ETAT ATTENDU
--
--  Le visiteur non connecte (role « anon ») n'a AUCUN droit sur les
--  tables : la requete est refusee avant meme la RLS, code 42501.
--
--  L'utilisateur connecte (role « authenticated ») est filtre par huit
--  politiques, toutes restrictives — aucune ne dit « true » :
--
--    navigations  nav all own      ALL     user_id = auth.uid()
--    traces       tr all own       ALL     user_id = auth.uid()
--    favorites    fav all own      ALL     user_id = auth.uid()
--    profiles     profiles read    SELECT  id = auth.uid() OR is_owner()
--    profiles     profiles insert  INSERT  check id = auth.uid()
--    profiles     profiles update  UPDATE  id = auth.uid() OR is_owner()
--    profiles     profiles delete  DELETE  is_owner() AND id <> auth.uid()
--
--  Deux fonctions SECURITY DEFINER les servent : is_owner() reconnait
--  l'administrateur sans que la politique ait a relire « profiles » — ce
--  qui bouclerait sans fin — et guard_profile_update(), posee en
--  declencheur t_guard_profile, restaure role et status pour quiconque
--  n'est pas administrateur, SAUF quand auth.uid() est vide, c'est-a-dire
--  depuis le SQL Editor, ou l'administrateur doit garder la main.
--
--  Enfin, RLS est active ET forcee sur les quatre tables.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
--  CONTROLE 1 — la RLS est active et forcee sur les quatre tables
--  Attendu : quatre lignes, true / true.
-- ---------------------------------------------------------------------
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('profiles','navigations','traces','favorites')
order by relname;


-- ---------------------------------------------------------------------
--  CONTROLE 2 — les politiques, et surtout leur filtre
--  Attendu : les huit lignes ci-dessus. AUCUNE ne doit porter « true »
--  dans qual ou with_check : les politiques s'additionnent, il suffit
--  qu'une seule dise oui pour que l'acces passe.
--  (Le SQL Editor n'affiche que le resultat de la DERNIERE requete :
--   lancez chaque controle seul.)
-- ---------------------------------------------------------------------
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;


-- ---------------------------------------------------------------------
--  CONTROLE 3 — le garde-fou de role et status
--  Attendu : t_guard_profile figure parmi les declencheurs.
-- ---------------------------------------------------------------------
select tgname
from pg_trigger
where tgrelid = 'public.profiles'::regclass and not tgisinternal
order by tgname;


-- ---------------------------------------------------------------------
--  CONTROLE 4 — aucune table publique oubliee sans RLS
--  Attendu : aucune ligne. Toute table qui apparait ici est lisible sans
--  filtre par quiconque a les droits de table.
-- ---------------------------------------------------------------------
select t.tablename
from pg_tables t
join pg_class c on c.relname = t.tablename
where t.schemaname = 'public' and not c.relrowsecurity;


-- ---------------------------------------------------------------------
--  CONTROLE 5 — vu du dehors (a lancer dans le Terminal, pas ici)
--
--  Sans compte, les quatre tables doivent repondre 42501 :
--
--    for T in profiles navigations traces favorites; do echo "--- $T";
--    curl -s -w "\nHTTP %{http_code}\n" \
--      "https://fshhzsvpyabtylwnxroz.supabase.co/rest/v1/$T?select=*&limit=3" \
--      -H "apikey: LA_CLE_PUBLIABLE" -H "Authorization: Bearer LA_CLE_PUBLIABLE" \
--      | cut -c1-160; done
--
--  Avec un compte ordinaire, le nombre de proprietaires distincts dans
--  navigations, traces et favorites doit valoir 1.
--
--  NE JAMAIS suivre le conseil que PostgreSQL glisse dans son message
--  d'erreur (« GRANT SELECT ON public.profiles TO anon ») : il ouvrirait
--  precisement la porte que ce refus tient fermee.
-- ---------------------------------------------------------------------
