# POC — TEMSI France / EUROC et WINTEM France depuis SOFIA

Analyse de la note technique *TEMSI/WINTEM via SOFIA — LOGNAVAK v1*, POC
exécutable, et évaluation. **`index.html` et le relais ne sont pas touchés.**

---

## 1. Verdict, en une phrase

**Faisable — et l'essentiel tourne déjà chez vous.** Votre relais `cartes` fait
la moitié de ce que la note décrit, en production, depuis des semaines. Ce qui
manque n'est pas l'accès aux cartes : c'est la **validité**.

```
node test_meteo.js    →  58 OK / 0 ÉCHEC
```

---

## 2. Ce que votre relais fait DÉJÀ

Avant d'écrire quoi que ce soit, la question honnête est : qu'est-ce qui manque
vraiment ? Beaucoup moins que la note ne le laisse croire.

| La note décrit | Dans `cartes` 7.43 |
|---|---|
| session SOFIA + POST `postTemsi` / `postWintem` | `posteSofia()` — **déjà là** |
| double décodage de `status.message` | `recolteSofia()` — **déjà là** |
| préfixer `aviation.meteo.fr` au lien relatif | **déjà là** |
| catalogue des échéances publiées | `?dates=1&type=…` — **déjà là** |
| proxifier le PDF avec CORS | `?img=1`, qui accepte déjà `application/pdf` — **déjà là** |
| repli AEROWEB | `viaAeroweb()` — **déjà là** (mais en PREMIER, voir § 5) |
| Worker Cloudflare | inutile : vous avez Supabase |

**Ce qui manque réellement, et c'est tout :**

1. **La classification** — en vigueur / à venir / périmée. `?dates=1` rend une
   liste brute d'échéances ; rien ne dit laquelle est la bonne.
2. **La sélection par la fenêtre du vol** — un vol de 4 h traverse deux
   échéances. C'est le cas qui compte pour un dossier de vol.
3. **La vérification du PDF** — voir § 4c.

---

## 3. Ce que le POC démontre

`faux_meteo.js` est une doublure stricte de SOFIA **et** d'aviation.meteo.fr.
Elle applique la note à la lettre et refuse chacun de ses pièges du § 13.

| Piège du § 13 | Réaction | Le POC |
|---|---|---|
| Lire `postsaveinsessionprepa` comme le catalogue | rend `""` | fait le second POST |
| Oublier le double JSON | `status.message` est une chaîne | double décodage |
| Utiliser `expiration` comme fin de validité | `expiration == date`, toujours | l'ignore, et **alerte** s'il diverge |
| Conserver le lien Météo-France | `login` régénéré à chaque appel | rafraîchit le catalogue avant tout téléchargement |
| Croire que c'est une image | sert `application/pdf` | vérifie les octets |
| Prendre une carte future pour « en vigueur » | plusieurs futures publiées | `PUBLISHED_FUTURE` ≠ `CURRENT` |
| Oublier l'heure du vol | — | `cartesPourVol(depart, arrivee)` |

Les huit tests de non-régression du § 15 passent, y compris la bascule
d'échéance à la seconde près : à 11:59:59Z c'est encore la carte de 09:00Z, à
12:00:00Z c'est celle de 12:00Z.

---

## 4. Trois corrections apportées à la note

**a) La fin de validité doit être bornée par la cadence.** La note calcule la
fin d'une carte comme le début de **la suivante du catalogue**. Si une échéance
manque — publication en retard, trou — la carte de 15:00 resterait « en
vigueur » jusqu'à 21:00 : **six heures**, le double de la cadence et le double
de la limite pratique du guide Météo-France. Le POC borne à la cadence, signale
le trou, et ne déclare **aucune** carte en vigueur à l'intérieur du trou. Mieux
vaut « pas de carte de référence » qu'une carte périmée présentée comme bonne.

**b) `expiration` n'est pas seulement inutile — sa divergence est un signal.**
La note dit de ne pas s'en servir ; le POC va plus loin et **alerte** s'il vient
à différer de `date`, parce que ce serait un changement de schéma SOFIA, à
savoir avant qu'il ne fasse des dégâts.

**c) Un PDF se vérifie sur ses octets, pas sur son Content-Type.** La doublure
sait servir du HTML en `200` avec `Content-Type: application/pdf` — c'est ce que
fait un portail en panne. Le POC lit les cinq premiers octets et exige `%PDF-`.
Preuve indépendante dans le banc : un vrai lecteur (pypdf) ouvre le fichier et y
compte ses pages.

---

## 5. Deux réserves à connaître

**Le WINTEM ne donne pas le niveau demandé.** La note annonce « `postWintem` +
`level=100` » et relève `level=FL20-100`. Mais elle relève **aussi**, dans la
même page, `layer=wintemp/fr/france/fl020`. SOFIA **étiquette** FL20-100 et
**sert** la planche FL020, celle par défaut. Votre relais l'avait déjà constaté
en production — *« level=NNN simple : PROUVÉ inopérant, l'image reste le fl020 »*
— et y a laissé une chasse aux formes qui n'a jamais trouvé la bonne. Le POC ne
prétend donc pas obtenir un niveau choisi : il obtient la planche FL020,
correctement identifiée. **Demander FL050 ou FL100 reste un problème ouvert.**

**L'ordre SOFIA → AEROWEB inverse le vôtre.** Vous demandez SOFIA d'abord,
AEROWEB en repli ; le relais fait l'inverse aujourd'hui. En pratique cela ne
change rien tant que `AEROWEB_ID` est vide — `viaAeroweb` rend `null` aussitôt et
SOFIA sert déjà. Mais si vous obtenez un jour le code de la convention
Météo-France, l'ordre mérite d'être rediscuté : AEROWEB est la voie
**contractuelle**, SOFIA une interface observée.

---

## 6. Ce que le POC ne prouve pas

Les vrais serveurs. L'accès sortant vers `sofia-briefing.aviation-civile.gouv.fr`
et `aviation.meteo.fr` est refusé par la politique réseau de cette session, et
votre relais Supabase ne m'est pas accessible non plus. **Mais votre relais leur
parle tous les jours** : c'est par lui que vos TEMSI et WINTEM arrivent. Le
risque « SOFIA filtre les datacenters » est donc retiré par votre production.

---

## 7. Comment l'exécuter

**Contre la doublure** (marche partout, y compris ici) :

```bash
FM_REF=2026-08-28T10:00:00Z node faux_meteo.js 8897 &
node poc_meteo.js --sofia http://127.0.0.1:8897 --meteo http://127.0.0.1:8897 \
                  --ref 2026-08-28T10:00:00Z \
                  --vol 2026-08-28T09:30Z,2026-08-28T13:30Z --pdf
```

**Contre les vrais services — depuis votre Mac** :

```bash
node poc_meteo.js                                    # les trois produits, maintenant
node poc_meteo.js --produit temsi-euroc
node poc_meteo.js --vol 2026-08-28T09:00Z,2026-08-28T13:00Z --pdf --dossier ~/cartes
```

Sortie attendue :

```
══ TEMSI France ══   source : SOFIA
  EN VIGUEUR  2026-08-28 09:00Z → 2026-08-28 12:00Z   FL20-150
  à venir     2026-08-28 12:00Z   FL20-150
  périmée     2026-08-28 06:00Z
  pour le vol : 2026-08-28 09:00Z  ·  2026-08-28 12:00Z
  PDF  2026-08-28 09:00Z  184320 o  application/pdf  → ~/cartes/temsi-france-…pdf
```

Envoyez-moi cette sortie : elle dira si les champs réels correspondent, et
surtout ce que `level` vaut vraiment sur le WINTEM.

---

## 8. Fichiers

| Fichier | Rôle |
|---|---|
| `meteo_client.js` | le client : catalogue, classification, fenêtre de vol, PDF vérifié |
| `poc_meteo.js` | le POC en ligne de commande |
| `faux_meteo.js` | la doublure SOFIA + Météo-France, stricte sur tous les pièges |
| `test_meteo.js` | 58 assertions — le § 15 au complet, les pièges du § 13, et mes ajouts |

---

## 9. Si vous voulez l'intégrer ensuite

La greffe serait légère, parce que le gros est déjà là. Dans `cartes` :

```
?meteocat=1&produit=temsi-france[&ref=…][&vol=DEBUT,FIN]
   -> { source, courante, futures, perimees, trous, pourVol }
```

en réutilisant `posteSofia`, `recolteSofia` et `viaAeroweb` **tels quels**, et en
n'ajoutant que la classification. Le téléchargement passerait par `?img=1`, déjà
en place, auquel il suffirait d'ajouter la vérification `%PDF-`.

Côté dossier de vol, la sélection par la fenêtre du vol remplacerait le choix
d'une échéance unique — c'est ce qui change le plus pour vous, et c'est le § 14
de la note : *« pour un vol couvrant plusieurs échéances, proposer plusieurs
cartes plutôt qu'une seule »*.

Rien de tout cela n'est fait : **vous avez demandé le POC seul.**
