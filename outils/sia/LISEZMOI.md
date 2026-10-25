# Mise à jour du texte des espaces aériens, à chaque cycle AIRAC

`ASP_TXT.js` porte, pour chaque espace aérien, ses **horaires**, son
**activité** et ses **conditions** (gestionnaire, téléphone, CAG/CAM…).
C'est ce que la fiche d'espace affiche quand on clique une zone dans la
pile de la carte. Le fichier est **fabriqué**, jamais écrit à la main.

## La marche à suivre

1. Récupérer l'archive du cycle sur le site du SIA : *export_xml_bd_sia
   `<cycle>`*. Elle contient `XML_SIA_<cycle>.xml` (≈ 27 Mo).

2. Fabriquer le fichier :

   ```
   python3 -I outils/sia/gen_asp_txt.py \
       XML_SIA_2026-12-24.xml index.html ASP_TXT.js 2026-12-24
   ```

   Le script affiche ce qu'il a trouvé : nombre d'espaces décrits, dont
   les zones réglementées, la liste de ceux que le SIA ne décrit pas, et
   le poids du fichier. **Lire ce relevé** : une chute brutale de la
   couverture veut dire que le SIA a changé sa structure ou sa manière
   de nommer, pas que les zones ont disparu.

3. Reporter le cycle à **deux** endroits, qui servent de clé de cache :

   - `index.html` → `window.__AIRAC_DATE='<cycle>'`, juste au-dessus des
     chargements tardifs. C'est lui que `tardif('ASPT', …)` concatène, et
     la **seule** ligne à changer côté application ;
   - `sw.js` → la même adresse dans `PRECACHE`.

   Les deux doivent être identiques, sinon le service worker précharge
   une adresse que l'application ne demande jamais. Le banc `test_v656`
   le vérifie.

4. Changer, juste au-dessus, le **libellé du cycle** :

   ```js
   window.__AIRAC_CYCLE='11/26';
   ```

   Les **deux** badges s'en servent : celui du bandeau du log et celui du
   bandeau de la carte. Ils étaient écrits chacun de leur côté, et la
   carte a annoncé pendant un cycle entier une base qu'elle n'avait plus
   (`XML AIRAC 10/26` sur une base 11/26). Il n'y a plus qu'une source ;
   `test_v661` vérifie que les deux badges disent la même chose.

5. Relancer le banc :

   ```
   node test_v656.js && node test_v661.js
   ```

6. Téléverser sur `main` : `index.html`, `ASP_TXT.js`, `sw.js`.

## Ce que ce script NE fait PAS

Il ne touche qu'au **texte**. Le tracé des espaces, leurs limites et
leur classe vivent dans `window.__ASP` (index.html) ; la base des
aérodromes et des fréquences vit dans `AERO`. Ces deux-là se mettent à
jour séparément. La même archive du SIA contient de quoi les fabriquer
aussi — ce n'est pas encore outillé.

## Conventions du SIA

Relevées sur le cycle 2026-10-01, à revérifier si la couverture chute :

- `#` sépare les lignes ;
- `\\` sépare le français de sa traduction anglaise — seule la version
  française est gardée. Quelques fiches gardent leur anglais parce que
  le SIA ne l'a pas marqué ainsi ; mieux vaut cela que de couper du
  français au jugé ;
- un même espace a souvent plusieurs volumes portant le même texte : il
  n'est gardé qu'une fois ;
- le nom d'un espace est reconstruit comme l'application le nomme :
  `TypeEspace` + `Nom`, suivi du `NomPartie` quand il n'est pas « . ».
  Au cycle 2026-10-01, 1602 des 1612 entrées de l'application tombaient
  juste de cette façon.
