# Passage à `lognavak.fr` + dépôt privé — procédure complète

Deux changements, menés **l'un après l'autre** pour savoir lequel casse quoi
si quelque chose casse :

1. le dépôt GitHub passe en **privé** (abonnement Pro) ;
2. le site passe sur **`lognavak.fr`** (domaine acheté chez Hostinger).

Comptez une heure de manipulation, plus une attente de propagation DNS
(quelques minutes à quelques heures) et jusqu'à 24 h pour le certificat
HTTPS.

---

## Ce qu'il faut comprendre avant de commencer

**Le code n'a rien à changer.** Tout est en chemins relatifs : le manifeste
dit `start_url: "./"`, le service worker est enregistré comme `sw.js`, et la
liste de préchargement commence par `./`. Passer de
`alexkilinc.github.io/LogNav/` à `lognavak.fr/` est transparent pour
l'application.

**Mais c'est un changement d'ORIGINE, et c'est le vrai sujet.** Le navigateur
range le `localStorage` et l'`IndexedDB` par origine. `lognavak.fr` est une
autre origine que `alexkilinc.github.io` : la PWA installée aujourd'hui ne
retrouvera RIEN de ce qui n'est pas dans Supabase.

### Ce qui suit tout seul (c'est dans Supabase)

| Donnée | Table |
|---|---|
| Les navigations | `navigations` |
| Le profil, les avions, le carburant | `profiles` |
| Les favoris de la carte | `favorites` |
| Les traces | synchronisées |
| **Les calages de cartes VAC sur la carte** | `vac_cartes` |
| Les favoris de la Recherche aérodrome | `profiles.arx_favs` ⚠️ |
| La position des favoris sur la carte | `profiles.fav_pos` ⚠️ |

⚠️ **Les deux dernières lignes n'existent que si vous avez joué
`supabase/profiles_colonnes.sql`.** C'est maintenant une vraie raison de le
faire : sans ces colonnes, ces deux réglages seront perdus au déménagement.

### Ce qui ne suit pas, et qu'il faudra refaire

| Donnée | Gravité |
|---|---|
| Les planches VAC rangées (`lognav_vac_pdf`) | nulle — elles se retéléchargent seules |
| Les planches gardées, les étoiles (`lognav_vac_favs`) | faible — une minute à refaire |
| Les tuiles de carte en cache (`lognav_tiles_v1`) | faible — elles reviennent à l'usage |
| **Les cartes SIA hors ligne** (`lognav_sia250`, `lognav_sia1000`) | **à vérifier** — si vous en aviez téléchargé, il faudra recommencer |
| Les préférences : fond de carte, langue NOTAM, réglages météo, projection… | faible — quelques clics |

---

## « Et une simple redirection de nom de domaine ? »

Question naturelle, et c'est un piège. **Une redirection ne change pas
l'origine.**

Si Hostinger renvoie `lognavak.fr` vers `alexkilinc.github.io/LogNav/`, le
navigateur suit et se retrouve sur `alexkilinc.github.io`. C'est cette
adresse qui s'affiche, qui porte le `localStorage`, l'`IndexedDB` et le
service worker, et depuis laquelle la PWA s'installe. Vous auriez acheté un
marque-page : toujours aussi soudé à github.io, et la même perte de données
le jour d'un vrai déménagement. C'est exactement ce que le domaine devait
éviter.

### La redirection « masquée » casserait l'application

La variante *masquée* (*cloaking*, *avec cadre*) garde `lognavak.fr` dans la
barre d'adresse en affichant le site dans une `<iframe>`. **À ne pas
prendre.** Dans un cadre tiers :

- **le GPS s'arrête** — la géolocalisation en cadre croisé exige une
  autorisation que vous ne contrôlez pas. Pour une appli de nav, rédhibitoire ;
- **le stockage est cloisonné ou bloqué** par la protection anti-pistage de
  Safari → navigations et planches VAC inaccessibles, silencieusement ;
- **la PWA ne s'installe pas** depuis une page encadrée ;
- plein écran, orientation, zones sûres de l'encoche : tout se dégrade.

### La variante légitime, si les quatre A records rebutent

Domaine personnalisé = **`www.lognavak.fr`**, donc **un seul enregistrement** :

```
www   CNAME   alexkilinc.github.io.
```

Et là une **redirection simple** (non masquée) de l'apex `lognavak.fr` vers
`https://www.lognavak.fr` a tout son sens : la vraie origine devient
`www.lognavak.fr`, la PWA s'installe depuis elle, et la redirection ne sert
qu'à celui qui tape l'adresse sans `www`. Tout le bénéfice est conservé. Prix :
le `www.` dans l'adresse, et une dépendance au redirecteur d'Hostinger.

### Pourquoi la procédure garde quand même l'apex

Parce qu'elle ajoute déjà le `CNAME` sur `www` : dans cette configuration,
**GitHub fait lui-même la redirection** entre l'apex et `www`. Les deux
adresses fonctionnent, sans dépendre du redirecteur d'Hostinger, pour quatre
lignes à coller au lieu d'une.

### Et faut-il le faire maintenant ?

Honnêtement : **le domaine n'apporte rien aujourd'hui.** C'est une assurance
contre un déménagement futur. Si le site reste sur GitHub Pages pour
toujours, il n'aura servi à rien. S'il bouge un jour, il épargne exactement
la perte de données listée plus haut. **Passer en privé sans toucher au
domaine est parfaitement cohérent** si l'on préfère ne gérer qu'un seul
changement : sautez les phases 3 à 6, elles restent valables plus tard.

---

## Phase 0 — Préparer (avant d'acheter quoi que ce soit)

- [ ] **0.1** Jouer `supabase/profiles_colonnes.sql` dans Supabase > SQL
  Editor. Sans lui, les favoris de la Recherche et la position des favoris
  sur la carte ne passeront pas le déménagement.

- [ ] **0.2** Sur l'iPhone, **ouvrir l'application, se connecter, et laisser
  la synchronisation se faire** (connexion correcte, application au premier
  plan une minute). C'est elle qui met tout à l'abri.

- [ ] **0.3** Ouvrir l'application sur le **Mac**, se connecter, et vérifier
  que vous y retrouvez vos navigations, vos favoris et vos calages VAC. Si
  tout est là sur une deuxième machine, c'est que tout est bien dans
  Supabase — et la preuve vaut mieux que la confiance.

- [ ] **0.4** Noter ce qui est local : fond de carte choisi, réglages NOTAM
  et météo, et surtout **si vous aviez téléchargé des cartes SIA hors
  ligne**.

- [ ] **0.5** Téléverser la **v.663** sur `main` si ce n'est pas déjà fait,
  pour partir d'une version connue.

---

## Phase 1 — L'abonnement GitHub

- [ ] **1.1** github.com > votre photo > **Settings** > **Billing and plans**
  > **Plans and usage** > *Upgrade* > **GitHub Pro**.

- [ ] **1.2** Vérifier sur la page des offres que **Pages depuis un dépôt
  privé** y est bien inclus. Les conditions changent ; si ce n'est plus le
  cas, arrêtez-vous ici et dites-le-moi — on bascule sur Cloudflare Pages,
  qui est gratuit, et la phase 3 ci-dessous rend ce choix indolore.

> **L'ordre compte.** Si vous passez le dépôt en privé AVANT d'avoir
> l'abonnement, GitHub coupe Pages et le site tombe.

---

## Phase 2 — Le dépôt en privé

- [ ] **2.1** github.com/AlexKilinc/LogNav > **Settings** > onglet
  **General** > tout en bas, *Danger Zone* > **Change repository visibility**
  > **Make private** > confirmer en tapant le nom du dépôt.

- [ ] **2.2** **Settings** > **Pages** : vérifier que *Source* est toujours
  **Deploy from a branch**, branche `main`, dossier `/ (root)`. Le
  basculement de visibilité remet parfois ce réglage à zéro — le
  re-sélectionner et *Save* si besoin.

- [ ] **2.3** Attendre 2–3 minutes, puis ouvrir
  `https://alexkilinc.github.io/LogNav/` dans un navigateur **en navigation
  privée** (pour ne pas être servi par un cache). Le site doit répondre.

> Si le site est coupé quelques minutes, **votre PWA installée continue de
> fonctionner** : le service worker la sert depuis son cache. Pas de panique.

**Point d'arrêt.** Ne passez à la phase suivante que si le site répond.

---

## Phase 3 — Le domaine chez Hostinger (DNS)

Chez Hostinger : **Domaines** > `lognavak.fr` > **DNS / Serveurs de noms** >
*Gérer les enregistrements DNS*.

- [ ] **3.1 Supprimer** l'enregistrement **A** sur `@` que Hostinger pose par
  défaut vers sa page de parking. Supprimer aussi un éventuel **CNAME** sur
  `www` vers Hostinger.

- [ ] **3.2 Ajouter quatre enregistrements A** sur le nom `@` :

```
@   A   185.199.108.153
@   A   185.199.109.153
@   A   185.199.110.153
@   A   185.199.111.153
```

- [ ] **3.3 Ajouter quatre enregistrements AAAA** (IPv6) sur `@`, si
  Hostinger le permet. Facultatif mais recommandé :

```
@   AAAA   2606:50c0:8000::153
@   AAAA   2606:50c0:8001::153
@   AAAA   2606:50c0:8002::153
@   AAAA   2606:50c0:8003::153
```

- [ ] **3.4 Ajouter un CNAME** pour que `www.lognavak.fr` marche aussi :

```
www   CNAME   alexkilinc.github.io.
```

(avec le point final, si Hostinger le demande)

- [ ] **3.5** Laisser le TTL par défaut. Enregistrer.

> **Ne me croyez pas sur parole pour ces adresses.** Elles sont stables
> depuis des années, mais GitHub vérifie lui-même vos enregistrements à
> l'étape suivante et vous dira s'ils sont faux. C'est cette vérification-là
> qui fait foi, pas cette liste.

---

## Phase 4 — Le domaine côté GitHub

- [ ] **4.1** Attendre 15 à 30 minutes que le DNS se propage. On peut vérifier
  sur `dnschecker.org` en cherchant `lognavak.fr` en type A : les quatre
  adresses `185.199.*` doivent apparaître.

- [ ] **4.2** GitHub > dépôt > **Settings** > **Pages** > *Custom domain* :
  saisir **`lognavak.fr`** (sans `https://`, sans `www`) > **Save**.

- [ ] **4.3** GitHub lance une **vérification DNS** et affiche le résultat.
  - ✅ *DNS check successful* → continuer.
  - ❌ message d'erreur → il dit exactement ce qui manque. Corriger chez
    Hostinger, attendre, puis *Check again*.

- [ ] **4.4** GitHub crée tout seul un fichier **`CNAME`** à la racine du
  dépôt, contenant `lognavak.fr`.
  **⚠️ Ne le supprimez JAMAIS lors de vos téléversements.** S'il disparaît,
  le domaine se détache et le site retombe sur l'ancienne adresse.

- [ ] **4.5** Ouvrir `http://lognavak.fr` — le site doit s'afficher. En HTTP
  pour l'instant, c'est normal.

---

## Phase 5 — HTTPS

- [ ] **5.1** Settings > Pages : la case **Enforce HTTPS** reste grisée tant
  que GitHub n'a pas obtenu le certificat Let's Encrypt. Cela prend de
  quelques minutes à **24 heures**.

- [ ] **5.2** Dès qu'elle est cliquable, **la cocher**.

- [ ] **5.3** Ouvrir `https://lognavak.fr` : cadenas, pas d'avertissement.

> **N'installez pas la PWA avant cette étape.** Un service worker exige
> HTTPS : installée en HTTP, l'application ne fonctionnerait pas hors ligne.

---

## Phase 6 — Réinstaller la PWA

- [ ] **6.1** Sur l'iPhone, Safari > `https://lognavak.fr` > Partager >
  **Sur l'écran d'accueil**.

- [ ] **6.2** Ouvrir la nouvelle icône, **se connecter**. Vérifier que les
  navigations, les favoris, les avions et les calages VAC sont revenus.

- [ ] **6.3** Ouvrir la fenêtre **Cartes VAC** : les planches sont absentes,
  c'est normal. Avec l'interrupteur *auto* allumé, celles du vol et des
  favoris reviennent seules. Ré-étoiler les planches à garder.

- [ ] **6.4** Refaire les quelques réglages locaux notés en 0.4.

- [ ] **6.5** **Point d'arrêt : ne supprimez l'ancienne icône qu'une fois
  tout vérifié.** Tant qu'elle est là, ses données restent accessibles.

- [ ] **6.6** Une fois sûr : supprimer l'ancienne icône de l'écran d'accueil.
  Refaire 6.1–6.4 sur l'iPad et le Mac.

> Après la phase 4, `alexkilinc.github.io/LogNav/` **redirige** vers
> `lognavak.fr`. L'ancienne PWA installée suivra cette redirection vers une
> autre origine, ce qui l'ouvrira en navigateur au lieu de son propre cadre.
> D'où la réinstallation.

---

## Phase 7 — Vérifications finales

- [ ] **7.1** Mode avion : la PWA s'ouvre, la carte s'affiche, une planche
  VAC rangée s'ouvre. (C'est le contrôle qui compte vraiment.)
- [ ] **7.2** Météo, NOTAM, AZBA : le relais répond depuis la nouvelle
  origine. Il n'a aucun contrôle d'origine, donc rien ne devrait bouger —
  mais c'est à vérifier plutôt qu'à supposer.
- [ ] **7.3** Téléverser un petit changement sur `main` et vérifier qu'il
  arrive sur `lognavak.fr` : le circuit complet est validé.
- [ ] **7.4** Vérifier que le fichier `CNAME` est toujours à la racine du
  dépôt.

---

## Si ça tourne mal

| Symptôme | Cause probable | Remède |
|---|---|---|
| Le site est en 404 après le passage en privé | Pages désactivé | Settings > Pages, re-sélectionner `main` / `/ (root)` |
| *DNS check* échoue | propagation ou enregistrement fautif | attendre, puis *Check again* ; comparer avec ce que GitHub affiche |
| Le site retombe sur l'ancienne adresse | le fichier `CNAME` a disparu | le recréer à la racine, contenu : `lognavak.fr` |
| *Enforce HTTPS* reste grisée après 24 h | certificat non délivré | retirer le domaine, *Save*, le remettre : cela relance la demande |
| Je veux tout annuler | — | Settings > Pages > vider *Custom domain* > *Save*. Le site revient sur `alexkilinc.github.io/LogNav/` |

---

## Ce qui reste après, et qui compte plus que tout ça

Le déménagement ne sécurise rien par lui-même. Il rend seulement les
décisions suivantes réversibles.

1. **Changer le mot de passe autorouter** → nouveau secret `AUTOROUTER_MDP`
   dans Supabase, redéployer la fonction, vérifier avec `?autorouter=1`.
2. **Vérifier que le mot de passe propriétaire ne sert nulle part ailleurs.**
   Son empreinte est dans `index.html`, en SHA-256 à un tour avec un sel
   connu : elle se casse hors ligne. Le dépôt privé n'y change rien, c'est
   dans la page servie.
3. **Jouer `supabase/audit_rls.sql`** et corriger ce qu'il montre.
4. **Fermer le relais** : il est appelé sans aucune clé, `Enforce JWT
   verification` étant désactivé. N'importe qui peut s'en servir.
