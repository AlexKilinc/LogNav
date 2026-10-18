# -*- coding: utf-8 -*-
"""Met a jour les frequences des espaces aeriens (window.__ASP) depuis le
   XML-SIA du cycle.

POURQUOI. Les frequences portees par la table des espaces servent a trois
endroits : la fiche d'espace (clic sur une zone de la pile), les cartes du
vol virtuel, et le profil vertical. Elles avaient ete figees a une
generation anterieure, et la recanalisation 8,33 kHz les a laissees en
arriere : au cycle 2026-10-01, 118.300 au lieu de 118.305 pour la tour de
Bordeaux Merignac, 119.050 au lieu de 119.055 pour Lourdes, etc. Une
frequence fausse de 5 kHz, sur une radio 8,33, ne passe pas.

CE QUE FAIT CE SCRIPT. Il ne touche QUE le champ « fq ». Le trace, les
limites et les classes ne bougent pas : le tableau est relu, modifie,
puis reecrit avec la meme serialisation (verifie : l'aller-retour JSON
est identique a l'octet pres quand rien ne change).

LA REGLE DE SELECTION. Le SIA rattache des services a un espace : TWR,
APP, FIS, AFIS, mais aussi ACS (controle de centre). Les frequences de
centre ne sont pas celles qu'un pilote affiche en traversant une TMA, et
la table embarquee ne les portait pas : on garde TWR, APP, FIS et AFIS,
on ecarte ACS et CCM. Un service rattache a l'espace « TMA BASTIA » vaut
pour « TMA BASTIA 1 », « 2 » et « 3 » : la recherche retombe sur le nom
sans son numero de partie.

PRUDENCE. Quand le SIA ne donne aucun service pour un espace, les
frequences embarquees sont CONSERVEES — les retirer perdrait une
information reelle a cause d'un simple ecart de nom. Le script dit
combien d'espaces sont dans ce cas : ceux-la restent a verifier a la
main.

Usage :
    python3 -I maj_frequences.py <XML_SIA.xml> <index.html> [--ecrire]

Sans --ecrire, le script ne fait que rendre compte.
"""
import sys, io, json, xml.etree.ElementTree as ET

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(2)
xml, app = sys.argv[1], sys.argv[2]
ecrire = '--ecrire' in sys.argv[3:]
GARDE = ('TWR', 'APP', 'FIS', 'AFIS')


def T(e, b):
    x = e.find(b)
    return (x.text or '').strip() if x is not None else ''


sit = ET.parse(xml).getroot().find('Situation')
esp = {e.get('pk'): (T(e, 'TypeEspace') + ' ' + T(e, 'Nom')).strip()
       for e in sit.find('EspaceS')}

srv = {}
for s_ in sit.find('ServiceS'):
    pe = s_.find('Espace')
    if pe is None:
        continue
    nom = esp.get(pe.get('pk'))
    typ = T(s_, 'Service')
    if not nom or typ not in GARDE:
        continue
    ind = (T(s_, 'IndicLieu') + ' ' + T(s_, 'IndicService')).strip()
    if ind.endswith(' .'):
        ind = ind[:-2]
    srv[s_.get('pk')] = {'esp': nom, 't': typ, 'ind': ind, 'f': []}

for f in sit.find('FrequenceS'):
    ps = f.find('Service')
    if ps is None:
        continue
    o = srv.get(ps.get('pk'))
    if o is None:
        continue
    v = T(f, 'Frequence')
    if v and v not in o['f']:
        o['f'].append(v)

par = {}
for o in srv.values():
    if o['f']:
        par.setdefault(o['esp'], []).append({'t': o['t'], 'ind': o['ind'], 'f': o['f']})
for v in par.values():
    v.sort(key=lambda x: (x['t'], x['ind']))

s = io.open(app, encoding='utf-8').read()
i = s.find('window.__ASP=[')
j = s.find('\n', i)
brut = s[i + len('window.__ASP='):j].rstrip().rstrip(';')
arr = json.loads(brut)

maj = inchange = garde_ancien = sansfq = 0
exemples, orphelins = [], []
for a in arr:
    cl = [a['n']]
    p = a['n'].rsplit(' ', 1)
    if len(p) == 2:
        cl.append(p[0])
    neuf = None
    for c in cl:
        if c in par:
            neuf = par[c]
            break
    if neuf is None:
        if a.get('fq'):
            garde_ancien += 1
            if a['n'] not in orphelins:
                orphelins.append(a['n'])
        else:
            sansfq += 1
        continue
    ancien = a.get('fq')
    if json.dumps(ancien, ensure_ascii=False, sort_keys=True) == \
       json.dumps(neuf, ensure_ascii=False, sort_keys=True):
        inchange += 1
        continue
    maj += 1
    if len(exemples) < 12:
        va = sorted({x for g in (ancien or []) for x in g['f']})
        vn = sorted({x for g in neuf for x in g['f']})
        if va != vn:
            exemples.append((a['n'], va, vn))
    a['fq'] = neuf

print('espaces du tableau            : %d' % len(arr))
print('frequences mises a jour       : %d' % maj)
print('deja conformes au SIA         : %d' % inchange)
print('sans service au SIA, anciennes frequences CONSERVEES : %d espaces' % garde_ancien)
print('sans frequence, ni avant ni apres : %d' % sansfq)
if orphelins:
    print('  a verifier a la main : %s' % ' · '.join(sorted(orphelins)[:12]))
print('\nexemples de changement de valeur :')
for n, va, vn in exemples:
    print('  %-26s %s  ->  %s' % (n, ', '.join(va) or '—', ', '.join(vn)))

if ecrire:
    neuf = json.dumps(arr, ensure_ascii=False, separators=(',', ':'))
    io.open(app, 'w', encoding='utf-8').write(
        s[:i + len('window.__ASP=')] + neuf + s[j - 1:] if s[j - 1] == ';'
        else s[:i + len('window.__ASP=')] + neuf + s[j:])
    print('\nindex.html reecrit (champ « fq » seulement).')
else:
    print('\n(relevé seul — relancer avec --ecrire pour appliquer)')
