# -*- coding: utf-8 -*-
"""Fabrique ASP_TXT.js — le texte reglementaire des espaces aeriens.

A chaque cycle AIRAC, le SIA publie une archive « export_xml_bd_sia ».
Elle contient XML_SIA_<cycle>.xml, d'ou ce script tire, pour chaque
espace que l'application connait :

    h   HorTxt    les horaires d'activation
    a   Activite  ce qui s'y passe
    r   Remarque  les conditions : gestionnaire, telephone, CAG/CAM...

Conventions du SIA, relevees sur le cycle 2026-10-01 :
  - « # » separe les lignes ;
  - « \\ » separe la version francaise de sa traduction anglaise : seule
    la francaise est gardee, l'application etant en francais. Quelques
    fiches gardent leur anglais quand le SIA ne l'a pas marque ainsi —
    mieux vaut cela que de couper du francais au jugé ;
  - un meme espace a souvent plusieurs volumes portant le meme texte :
    il n'est garde qu'une fois.

Le nom d'un espace est reconstruit comme l'application le nomme :
TypeEspace + ' ' + Nom, suivi du NomPartie quand il n'est pas « . ».
Seuls les espaces presents dans window.__ASP (index.html) sont gardes :
inutile d'emporter l'outre-mer et les espaces non traces.

Usage :
    python3 -I gen_asp_txt.py <XML_SIA.xml> <index.html> <ASP_TXT.js> <cycle>

    python3 -I outils/sia/gen_asp_txt.py \\
        /chemin/XML_SIA_2026-10-01.xml index.html ASP_TXT.js 2026-10-01

Voir outils/sia/LISEZMOI.md pour la marche a suivre complete.
"""
import sys, io, os, json, xml.etree.ElementTree as ET

if len(sys.argv) != 5:
    print(__doc__)
    sys.exit(2)
src, app, out, cycle = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]


def T(e, b):
    """le texte d'une balise fille, ou '' si elle manque"""
    x = e.find(b)
    return (x.text or '').strip() if x is not None else ''


def propre(s):
    """ne garde que le francais, remet les retours a la ligne, nettoie"""
    if not s:
        return ''
    s = s.split('\\\\')[0].split('\\')[0]      # la traduction anglaise saute
    s = s.replace('#', '\n')
    lignes = [l.strip() for l in s.split('\n')]
    return '\n'.join(l for l in lignes if l).strip()


sit = ET.parse(src).getroot().find('Situation')
esp = {e.get('pk'): e for e in sit.find('EspaceS')}

# pk de partie -> nom tel que l'application l'ecrit
partie = {}
for p in sit.find('PartieS'):
    pe = p.find('Espace')
    e = esp.get(pe.get('pk')) if pe is not None else None
    if e is None:
        continue
    base = (T(e, 'TypeEspace') + ' ' + T(e, 'Nom')).strip()
    np = T(p, 'NomPartie')
    partie[p.get('pk')] = base if np in ('', '.') else base + ' ' + np

brut = {}
for v in sit.find('VolumeS'):
    pp = v.find('Partie')
    nom = partie.get(pp.get('pk')) if pp is not None else None
    if not nom:
        continue
    d = brut.setdefault(nom, {'h': [], 'a': [], 'r': []})
    for cle, bal in (('h', 'HorTxt'), ('a', 'Activite'), ('r', 'Remarque')):
        t = propre(T(v, bal))
        if t and t not in d[cle]:
            d[cle].append(t)

table = {}
for nom, d in brut.items():
    o = {cle: '\n'.join(d[cle]) for cle in 'har' if d[cle]}
    if o:
        table[nom] = o

# on ne garde que les espaces traces par l'application
s = io.open(app, encoding='utf-8').read()
i = s.find('window.__ASP=[')
if i < 0:
    sys.exit("window.__ASP introuvable dans " + app)
arr = json.loads(s[i + len('window.__ASP='):s.find('\n', i)].rstrip(';'))
connus = {a['n'] for a in arr}
garde = {k: v for k, v in table.items() if k in connus}

corps = json.dumps(garde, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
tete = ("/* Texte reglementaire des espaces aeriens — extrait du XML-SIA %s\n"
        "   par outils/sia/gen_asp_txt.py. Ne pas modifier a la main.\n"
        "   h = horaires, a = activite, r = conditions ; version francaise.\n"
        "   Charge a la demande : voir __ASP_CHARGE dans index.html. */\n" % cycle)
io.open(out, 'w', encoding='utf-8').write(
    tete + "window.__ASP_TXT_CYCLE='" + cycle + "';\n"
    + 'window.__ASP_TXT=' + corps + ';\n')

sans = sorted(connus - set(garde))
REG = ('R', 'P', 'D', 'TRA', 'CBA', 'ZRT')
reg = {a['n'] for a in arr if a['t'] in REG}
print('cycle                       : %s' % cycle)
print('espaces decrits             : %d / %d connus de l\'application' % (len(garde), len(connus)))
print('zones reglementees decrites : %d / %d' % (len(reg & set(garde)), len(reg)))
print('sans aucun texte (%d)        : %s' % (len(sans), ' · '.join(sans) or '—'))
print('poids                       : %.0f ko' % (os.path.getsize(out) / 1024.0))
print('\nA FAIRE ENSUITE : reporter le cycle dans index.html (ASP_TXT.js?v=…)')
print('et dans sw.js (meme adresse), puis relancer test_v656.')
