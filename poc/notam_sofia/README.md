# POC — NOTAM via SOFIA-Briefing pour LOGNAVAK

Analyse du document *Procédure d'accès NOTAM SOFIA LOGNAVAK v2*, évaluation de
faisabilité, et POC exécutable. **`index.html` n'a pas été touché.**

---

## 1. Verdict

**Faisabilité technique : démontrée, contre le vrai serveur.**

Test réel du 27/08/2026 depuis un Mac, `node poc.js --route LFPN,LFPZ` :

```
session     GET  200  1213 ms  cookies: JSESSIONID
preparation POST 200    31 ms
pib         POST 200  2561 ms   107 823 o
pibUid : NL912608272061 · LFPN → LFPZ · 84 NOTAM · 3942 ms au total
```

Les trois étapes passent, le double décodage donne `listnotams`, et le risque n° 1
que j'avais signalé — un service `.gouv.fr` filtrant les appels automatisés — ne
s'est pas matérialisé depuis une IP résidentielle. **Il reste à vérifier depuis une
IP de datacenter** (Supabase), ce que seul le déploiement dira.

Côté banc, 57 assertions passent, et trois défauts réels ont été trouvés dans le
Worker v1 du document, chacun mesuré, chacun corrigé.

### Ce que le test réel a appris, et que le document ne disait pas

1. **`duration=1200` vaut bien 12 heures.** `validFrom 14:13:11Z` →
   `validTo 02:13:00Z` le lendemain. Le format HHMM est confirmé sur pièce.
2. **Le champ `id` n'est PAS le numéro de NOTAM.** Le PIB porte un identifiant
   interne (`400000051804734`) là où le document citait `E 3550/26` — pour le même
   NOTAM, « RWY 07R/25L NIGHT VFR PROHIBITED. ». Le vrai numéro est ailleurs dans
   la structure. L'aplatisseur doit être recalé sur une capture réelle.
3. **Les catégories réelles sont bien plus riches** que les deux du document :
   `aerodromes_services`, `aire_mouvement`, `balisage`,
   `aides_atter_instal_radionav_GNSS`, `procedures`,
   `organisation_espace_services_circulation`, `obstacles`, plus un bloc FIR entier.
4. **Le volume est un sujet produit.** 84 NOTAM et 108 ko pour un vol de 12 NM.
   Le bloc FIR contient beaucoup de choses sans objet en VFR local — CPDLC
   Eurocontrol, restrictions Iran/Irak/Qatar pour transporteurs français, DME
   en-route. Un filtrage sera nécessaire, sinon le badge NOTAM sera illisible.

---

## 2. Ce qui est démontré ici

```
node test_poc.js        →  35 OK / 0 ÉCHEC     le client
node test_worker.mjs    →  22 OK / 0 ÉCHEC     l'artefact déployable
```

La doublure `faux_sofia.js` n'est pas complaisante : elle applique littéralement
le protocole du document et **refuse** chacun des pièges du § 7.

| Piège du § 7 | Réaction de la doublure | Le POC |
|---|---|---|
| `route[]` agrégé en `LFPN,LFPZ` (Hashtable PowerShell) | `HTTP 500` | envoie une occurrence par point |
| Pas de `JSESSIONID` / UUID pris pour la session | `HTTP 403` | garde le même `JSESSIONID` sur les deux POST |
| `valid_from` sans `Z`, ou incohérent avec `departure_*` | `HTTP 400` | refuse avant même l'appel réseau |
| `duration` convertie en minutes | `HTTP 400` | garde le format HHMM |
| `status.message` lu comme un objet | — | double décodage |
| PIB sans `postsaveinsessionprepa` | `HTTP 409` | garde l'étape (§ 11.9) |

Le PIB rendu reprend le résultat réel du § 6 : `NW432608262157`, LFPN → LFPZ,
et les cinq NOTAM, jusqu'à `E 3550/26 RWY 07R/25L NIGHT VFR PROHIBITED.`

---

## 3. Trois défauts dans le Worker v1 du document

Mesurés dans `test_worker.mjs`, pas supposés.

**a) `:operation` se retrouve en fin de corps.** La v1 fait
`new URLSearchParams(common)` puis `.set(":operation", …)`. Or `set()` sur une clé
**absente** ajoute **en queue**. Le corps produit finit par
`…route%5B%5D=LFPZ&%3Aoperation=postsaveinsessionprepa`, alors que le test
PowerShell validé le met **en tête**. Un servlet s'en moque probablement — mais le
seul appel dont on sait qu'il a marché avait cet ordre-là, et c'est celui-là qu'il
faut reproduire tant qu'on n'a pas prouvé le contraire. Le POC construit le corps
en chaîne brute, ordre garanti.

*(À décharge : `new URLSearchParams(uneAutre)` **préserve** bien les `route[]`
répétés — ce point de la v1 était bon, et c'est vérifié.)*

**b) `redirect:"follow"` peut perdre le `JSESSIONID`.** `fetch` n'expose que les
en-têtes de la **réponse finale**. Si SOFIA pose son cookie sur une `302` — un
serveur J2EE le fait couramment — la v1 ne le voit jamais et échoue sur
« JSESSIONID missing ». Mesuré : en `follow`, le cookie a disparu ; en `manual`, il
est là. Le POC suit les redirections à la main et récolte les cookies **à chaque
saut**.

**c) Aucun délai de garde.** Le § 12 le renvoyait à une v2. Sans lui, un SOFIA qui
ne répond jamais bloque la requête indéfiniment. Mesuré contre un serveur muet :
le POC coupe à 20 s et rend un `502` explicite.

**d) La forme de `listnotams` n'est pas documentée.** Le document ne cite que
`ADDep.code` / `ADDes.code` et des textes de NOTAM. L'aplatisseur du POC descend
donc tout l'arbre et retient ce qui ressemble à un NOTAM, en **conservant le JSON
brut à côté**. Il faudra le recaler sur une vraie capture.

---

## 4. Correction d'architecture : pas de Cloudflare

Le document construit tout autour d'un Worker Cloudflare. **LOGNAVAK a déjà un
relais serveur** : la fonction Supabase `cartes`, avec ses secrets, son CORS et sa
table `relais_memo`. Ajouter Cloudflare, ce serait un second compte, un second
domaine, un second jeu de secrets et un second point de panne pour le même travail.

`supabase_notam_sofia.ts` est donc l'adaptateur transposé sur l'infrastructure
existante. `worker_v1_corrige.js` reste fourni si vous préférez malgré tout
Cloudflare — le code est le même.

Bonne nouvelle au passage : **ce flux ne demande aucune authentification**. Rien de
nouveau à mettre en secret, rien qui puisse fuir dans GitHub.

---

## 5. Ce qui reste ouvert après le test réel

1. **Que SOFIA accepte un appel depuis un datacenter.** Le test réel est passé
   depuis une IP résidentielle. Supabase sort d'un datacenter, et un service
   `.gouv.fr` peut l'y filtrer ou le ralentir. Seul le déploiement le dira, et si
   ça coince, c'est là que ça coincera.
2. **Le nommage exact des NOTAM dans `listnotams`** — voir le point 2 du § 1.
   L'aplatisseur est tolérant et conserve le JSON brut à côté, mais il faut le
   recaler sur une capture réelle.
3. **Le filtrage produit** : 84 NOTAM pour LFPN → LFPZ, dont un gros bloc FIR sans
   objet en VFR local. Quoi montrer, quoi replier, quoi écarter.
4. **Les quotas et le comportement en rafale.** Une requête isolée passe en 4 s ;
   rien ne dit ce qui arrive à la vingtième dans la minute.
5. **Si `postsaveinsessionprepa` est superflu** (§ 11.9 : ne pas le retirer avant
   preuve — le POC le garde).

---

## 6. Le point non technique, dit une fois

L'interface `/sofia` est une interface applicative **observée**, pas une API
publique. Automatiser son accès pour publier des NOTAM à des pilotes soulève la
même question que l'accord AEROWEB déjà mis de côté : ce n'est pas une question de
code, et aucun test ne la tranchera. Une demande écrite au SIA/DGAC est la seule
voie propre. Techniquement, le chemin est là ; c'est votre décision.

Si vous y allez : nommer SOFIA comme source, afficher l'heure de récupération et
les bornes de validité du PIB, et garder un lien vers le briefing officiel — ce
que le POC prépare déjà (`source`, `retrievedAt`, `pib.validFrom/validTo`).

---

## 7. Comment l'exécuter

**Contre la doublure locale** (marche partout, y compris ici) :

```bash
node faux_sofia.js 8899 &
node poc.js --route LFPN,LFPZ --origin http://127.0.0.1:8899
```

**Contre le vrai SOFIA — depuis votre Mac, Node ≥ 18** :

```bash
node poc.js --route LFPN,LFPZ
```

Sortie attendue : les trois étapes en `200`, le `pibUid`, LFPN → LFPZ, et les NOTAM.
En cas d'échec, le message dit **quelle étape** et **quel code HTTP** — jamais un
faux « aucun NOTAM ».

Options : `--route A,B,C` · `--duration HHMM` · `--traffic VI` · `--width NM` ·
`--radius NM` · `--fl-lower` · `--fl-upper` · `--lang fr|en` ·
`--valid-from 2026-08-28T09:00:00Z` · `--json` · `--sans-preparation` · `--origin`

Trois essais utiles, dans l'ordre du § 11 :

```bash
node poc.js --route LFPN,LFPZ                       # la référence du document
node poc.js --route LFPN,LFOZ,LFPZ                  # point tournant → route[] ×3
node poc.js --route LFPN,LFPZ --valid-from 2026-08-28T09:00:00Z   # départ futur
node poc.js --route LFPN,XXXX                       # erreur contrôlée attendue
```

---

## 8. Fichiers

| Fichier | Rôle |
|---|---|
| `sofia_client.js` | l'adaptateur, sans dépendance — Node / Deno / Workers |
| `poc.js` | le POC en ligne de commande |
| `faux_sofia.js` | la doublure SOFIA, stricte sur tous les pièges |
| `test_poc.js` | 35 assertions — le client |
| `test_worker.mjs` | 22 assertions — l'artefact déployable et les corrections |
| `supabase_notam_sofia.ts` | **la cible recommandée** — Edge Function Supabase |
| `worker_v1_corrige.js` | la variante Cloudflare, si vous y tenez |

---

## 9. Si le test réel passe, la suite

1. Capturer un vrai PIB en JSON et recaler l'aplatisseur dessus.
2. Déployer `supabase_notam_sofia.ts`, comparer trois routes avec SOFIA à l'écran.
3. Seulement après : brancher LOGNAVAK sur le badge NOTAM, à côté de SupAIP —
   **et pas avant** que le point du § 6 soit tranché.
