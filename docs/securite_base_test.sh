#!/bin/sh
# =====================================================================
#  LogNavAK — que peut obtenir un inconnu de votre base ?
#  A lancer dans le Terminal, avant ET apres avoir applique
#  docs/securite_base.sql. Lecture seule : rien n'est modifie.
#
#     sh docs/securite_base_test.sh
#
#  La cle ci-dessous est la cle PUBLIABLE, celle qui figure deja dans le
#  code de l'application : la copier ici n'expose rien de plus. Ne mettez
#  JAMAIS la cle service_role (sb_secret_…) dans ce fichier ni ailleurs
#  dans le depot — elle, contourne toutes les protections.
# =====================================================================

BASE="https://fshhzsvpyabtylwnxroz.supabase.co/rest/v1"
CLE="sb_publishable_y2p80uoUejj-PFvhCV1hNA_kjb3AXxk"

echo "Ce qu'un inconnu obtient avec la seule cle publique, sans compte :"
echo

for TABLE in profiles navigations traces favorites; do
  REP=$(curl -s -m 20 -w '\n%{http_code}' \
        "$BASE/$TABLE?select=*&limit=3" \
        -H "apikey: $CLE" -H "Authorization: Bearer $CLE")
  CODE=$(printf '%s' "$REP" | tail -n1)
  CORPS=$(printf '%s' "$REP" | sed '$d' | cut -c1-160)

  printf '%-12s HTTP %s  ' "$TABLE" "$CODE"
  case "$CORPS" in
    '[]'*)  echo "VERROUILLE — aucune ligne rendue" ;;
    '['*)   echo "OUVERT — des donnees sortent !" ; echo "             $CORPS" ;;
    *)      echo "refus — $CORPS" ;;
  esac
done

echo
echo "Lecture :"
echo "  « OUVERT »      = la table est lisible par n'importe qui : appliquez le SQL."
echo "  « VERROUILLE »  = la RLS filtre : un inconnu ne voit rien. C'est le but."
echo "  « refus »       = la table refuse la requete (RLS sans politique, ou droits retires)."
echo
echo "Apres avoir applique le SQL, relancez ce test : les quatre lignes doivent"
echo "dire VERROUILLE ou refus. Puis ouvrez l'application et verifiez qu'un"
echo "utilisateur normal retrouve bien SES vols — la RLS mal posee se voit la."
