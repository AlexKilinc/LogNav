# LogNavAK — projets en attente

Pistes gardées de côté, à reprendre plus tard. Ce fichier existe pour que
rien ne se perde entre deux sessions de travail.

---

## Projet SOFIA — NOTAM en français, et recherche par zone

**En attente.** Décidé le 25 août 2026. À évaluer plus tard.

### L'idée

Obtenir les NOTAM **en français** et permettre une **recherche par zone**
(et non plus seulement terrain par terrain), en passant par SOFIA-Briefing,
le service de briefing du SIA.

### Pourquoi c'est possible

Contrairement à ce que j'avais d'abord répondu, il existe bien une source de
NOTAM en français. L'OACI n'impose l'anglais que pour les NOTAM intéressant
la navigation internationale ; un État peut publier en langue nationale ceux
qui ne concernent que son espace. La France le fait largement — treuillage
planeur, parachutage, manifestations aériennes, travaux sur plateformes VFR.
**Le texte français est l'original, pas une traduction.** SOFIA les sert tels
qu'ils ont été émis ; autorouter, agrégateur international alimenté par la
distribution AFTN, retient la variante anglaise.

### Ce qui joue en notre faveur

Le relais `supabase/functions/cartes` **parle déjà à SOFIA** : c'est par lui
qu'il récupère les cartes TEMSI et WINTEM, via le point d'accès applicatif
public `POST /sofia` (`:operation=postTemsi` / `postWintem`), **sans
authentification** — voir `posteSofia()` et `viaSofia()`. Et SOFIA répond aux
requêtes serveur, contrairement aux images d'`aviation.meteo.fr` qui les
refusent (403, « Request forbidden by administrative rules »).

Passer les NOTAM par le même chemin serait donc dans la continuité de ce qui
fonctionne déjà.

### La question ouverte, qui décide de tout

La partie *cartes* de SOFIA est ouverte. La partie *briefing NOTAM* l'est
peut-être moins : elle est probablement derrière un compte SIA.

- si elle est ouverte → une opération de plus dans le relais ;
- si elle est fermée → il faut des identifiants SIA en secrets Supabase,
  comme `AUTOROUTER_ID` / `AUTOROUTER_MDP`.

### Premier pas quand on reprendra

Une **sonde** dans le relais : interroger SOFIA sur un terrain (LFPN) et
rapporter ce qui revient — du JSON de NOTAM, une page de connexion, ou un
refus. Une dizaine de lignes, aucun risque pour l'existant, et cela tranche.

Attention : cette vérification n'est **pas** faisable depuis une session
Claude Code — le proxy réseau bloque `sofia-briefing.aviation-civile.gouv.fr`
(403 sur le tunnel CONNECT). Seul le relais déployé peut l'atteindre.

### Bénéfice collatéral

SOFIA deviendrait une **seconde source** de NOTAM, indépendante d'autorouter
et de son plafond de 20 jetons actifs — celui qui a bloqué le service toute
la journée du 24 août.

### Deuxième volet : recherche par zone

Aujourd'hui les NOTAM sont demandés terrain par terrain (`itemas=[...]`,
40 codes au plus). Une recherche par zone — un rayon autour de la trace, ou
un rectangle — donnerait aussi les NOTAM d'espace qui ne sont rattachés à
aucun aérodrome. À évaluer selon ce que SOFIA accepte.
