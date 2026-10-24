# Worker « meteo-sofia » — TEMSI / WINTEM depuis SOFIA, PDF servi avec CORS

## Pourquoi ce Worker

Météo-France refuse les octets des planches aux adresses IP de centres de
données — dont celle du relais Supabase (« Request forbidden by administrative
rules », constat du 25–26/08). La note technique du 26/08/2026 a établi que la
même récupération **aboutit depuis un Worker Cloudflare** (autre adresse de
sortie), en rejouant le chemin du navigateur : session SOFIA (JSESSIONID),
POST `postsaveinsessionprepa`, POST `postTemsi` / `postWintem`, puis le lien
`affiche_image.php` tout frais.

Ce Worker est la coque HTTP du client `poc/temsi_wintem/meteo_client.js` —
éprouvé par 73 assertions contre une doublure stricte de SOFIA et de
Météo-France, plus 20 assertions sur le Worker complet (`test_worker.mjs`).

Il règle AUSSI, pour les cartes, la question de la mise en pause du projet
Supabase gratuit : un Worker Cloudflare ne s'endort pas.

## Points d'accès

    GET /                                            ce que sert le Worker
    GET /api/meteo/catalog?product=P[&reference=ISO] catalogue classé (JSON)
    GET /api/meteo/pdf?product=P[&valid=ISO][&reference=ISO]

`P` ∈ `temsi-france`, `temsi-euroc`, `wintem-france`.
Sans `valid`, le PDF servi est la carte **en vigueur** à `reference` (défaut :
maintenant), sinon la prochaine publiée, sinon la dernière connue — la même
règle que l'application, et l'en-tête `X-Meteo-Statut` le dit. Le `login`
éphémère des liens Météo-France ne sort jamais du Worker.

## Déployer (une fois, ~10 min)

    npm install -g wrangler
    cd cloudflare/meteo-sofia
    wrangler login          # ouvre le navigateur, compte Cloudflare gratuit
    wrangler deploy         # affiche l'adresse https://lognavak-meteo-sofia.<compte>.workers.dev

Vérifier depuis un navigateur ou curl :

    curl -sS "https://…workers.dev/api/meteo/catalog?product=temsi-france" | head -40
    curl -sSo temsi.pdf "https://…workers.dev/api/meteo/pdf?product=temsi-france" \
      && head -c 5 temsi.pdf     # doit afficher %PDF-

Si le PDF sort : la voie Cloudflare est confirmée chez vous comme dans la note.

## Brancher au relais Supabase (secours automatique)

Le relais `cartes` **7.44** tente d'abord lui-même le protocole complet ; s'il
échoue (IP refusée), il se replie sur ce Worker si le secret est posé :

    Supabase > Edge Functions > cartes > Secrets :
      CARTES_WORKER = https://lognavak-meteo-sofia.<compte>.workers.dev

puis redéployer la fonction `cartes` (coller `supabase/functions/cartes/
index.ts` en entier ; `?version=1` doit répondre **7.44**).

Rien à changer dans `index.html` ni dans `cartes.json` : l'application passe
toujours par le relais, et sa voie octets (`&img=1`) se met à répondre — le
bouton « Imprimer dossier de vol » cuit alors les planches en vraies images
(scénario B du banc v.567, rotation TEMSI comprise).

## Vérifier la chaîne complète

    curl -sS "https://fshhzsvpyabtylwnxroz.supabase.co/functions/v1/cartes?version=1"
    curl -sSo t.pdf "https://fshhzsvpyabtylwnxroz.supabase.co/functions/v1/cartes?type=sigwx/fr/france&date=AAAAMMJJHH0000&img=1" && head -c 5 t.pdf

En cas d'échec, la réponse JSON liste chaque voie tentée (`sofia-session`,
les hôtes directs, `worker`) avec le verdict de chacune — c'est ce journal
qu'il faut me rapporter pour itérer.

## Entretien

Le corps de `src/index.js` (jusqu'à « LA COQUE HTTP ») est
`poc/temsi_wintem/meteo_client.js` à l'identique, moins son export CommonJS.
Pour toute évolution : modifier le client LÀ-BAS, rejouer
`poc/temsi_wintem/test_meteo.js` (73 assertions) puis `test_worker.mjs` ici
(20 assertions), et recopier.
