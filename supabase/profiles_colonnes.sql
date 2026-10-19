-- LogNavAK — deux colonnes de la table « profiles », à ajouter une fois.
--
-- À QUOI ÇA SERT. Ces deux colonnes ne servent qu'à faire SUIVRE deux
-- réglages d'un appareil à l'autre (iPhone, iPad, Mac). Sans elles,
-- l'application marche : elle garde tout dans le cache du navigateur.
-- Ce qui manque, c'est la synchronisation.
--
--   arx_favs  les terrains gardés en favori dans la fenêtre « Recherche
--             aérodrome » (bouton FAV). Posés sur l'iPhone, ils ne
--             réapparaissent pas sur l'iPad. Depuis la v.662 ce sont
--             aussi eux dont les cartes VAC sont rapatriées d'elles-
--             mêmes : sans la colonne, chaque appareil a sa propre
--             liste, et donc ses propres planches.
--
--   fav_pos   OÙ chaque favori est posé sur la carte. Les favoris
--             eux-mêmes voyagent déjà (table « favorites ») ; leur
--             position, elle, ne vivait que dans le cache, et un autre
--             appareil les remettait à leur place d'usine.
--
-- L'application est écrite pour TOLÉRER leur absence : l'envoi de ces
-- deux colonnes est séparé du reste et son échec est ignoré. Rien ne
-- casse donc si ce fichier n'est jamais joué — on perd seulement le
-- confort de retrouver ses réglages sur un autre appareil.
--
-- COMMENT LE JOUER. Supabase > SQL Editor > New query, coller ce
-- fichier, Run. C'est sans effet s'il a déjà été joué (« if not
-- exists »), et sans danger pour les données existantes : on ajoute des
-- colonnes, on n'en modifie aucune.
--
-- Pas de politique RLS à écrire : celles de « profiles » valent pour la
-- ligne entière, donc pour ces colonnes aussi. (Seul un GRANT posé
-- colonne par colonne demanderait un ajout — ce n'est pas le cas d'une
-- base Supabase ordinaire.)

alter table public.profiles
  add column if not exists arx_favs jsonb not null default '[]'::jsonb;

alter table public.profiles
  add column if not exists fav_pos  jsonb not null default '{}'::jsonb;

-- Vérification : les deux lignes doivent apparaître.
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'profiles'
   and column_name in ('arx_favs','fav_pos')
 order by column_name;
