"""bria-doc : modifier une présentation PowerPoint sans casser sa mise en forme.

Le cuisinier s'en sert sur la machine cloud, par run_command, depuis le dossier du projet. Chaque
modification garde une copie dans .travail/sauvegardes et signale ce qui semble mal placé.
"""

import argparse
import copy
import math
import os
import pathlib
import shutil
import subprocess
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn

SAUVEGARDES = pathlib.Path(".travail/sauvegardes")
APERCU = pathlib.Path(".travail/apercu")
LARGEUR_APERCU = 800
QUALITE_APERCU = 55
ESPACE_RELATIONS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
BALISES_FORMES = {qn(tag) for tag in ("p:sp", "p:pic", "p:graphicFrame", "p:grpSp", "p:cxnSp")}


class Erreur(Exception):
    """Une erreur à montrer telle quelle au cuisinier."""


def ouvrir(chemin):
    fichier = pathlib.Path(chemin)
    if fichier.suffix.lower() != ".pptx":
        raise Erreur(f"{chemin} n'est pas un fichier .pptx.")
    if not fichier.is_file():
        raise Erreur(f"{chemin} est introuvable.")
    return Presentation(str(fichier))


def enregistrer(presentation, chemin):
    """Garde une copie du fichier actuel, puis le remplace d'un seul coup."""
    fichier = pathlib.Path(chemin)
    SAUVEGARDES.mkdir(parents=True, exist_ok=True)
    rang = len(list(SAUVEGARDES.glob(f"{fichier.stem}.*.pptx"))) + 1
    shutil.copy2(fichier, SAUVEGARDES / f"{fichier.stem}.{rang:03d}.pptx")
    temporaire = fichier.with_name(f".{fichier.name}.tmp")
    presentation.save(str(temporaire))
    os.replace(temporaire, fichier)


def diapositive(presentation, numero):
    if not 1 <= numero <= len(presentation.slides):
        raise Erreur(f"Diapositive {numero} inexistante : la présentation en a {len(presentation.slides)}.")
    return presentation.slides[numero - 1]


def forme(slide, numero):
    formes = list(slide.shapes)
    if not 1 <= numero <= len(formes):
        raise Erreur(f"Forme {numero} inexistante : la diapositive en a {len(formes)}.")
    return formes[numero - 1]


def zones_de_texte(formes):
    """Toutes les zones de texte, y compris dans les groupes et les tableaux."""
    for shape in formes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from zones_de_texte(shape.shapes)
        elif getattr(shape, "has_table", False) and shape.has_table:
            for ligne in shape.table.rows:
                for cellule in ligne.cells:
                    yield cellule.text_frame
        elif shape.has_text_frame:
            yield shape.text_frame


def texte_de(shape):
    return shape.text_frame.text if shape.has_text_frame else ""


def taille_police(shape):
    if not shape.has_text_frame:
        return None
    for paragraphe in shape.text_frame.paragraphs:
        for morceau in paragraphe.runs:
            if morceau.font.size:
                return morceau.font.size.pt
    return None


def fond(slide):
    element = slide._element.find(qn("p:cSld")).find(qn("p:bg"))
    if element is None:
        return "hérité du modèle"
    couleur = element.find(".//" + qn("a:srgbClr"))
    return f"personnalisé #{couleur.get('val')}" if couleur is not None else "personnalisé"


def cadre(shape):
    valeurs = (shape.left, shape.top, shape.width, shape.height)
    return None if any(valeur is None for valeur in valeurs) else valeurs


def intersection(a, b):
    largeur = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    hauteur = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return largeur * hauteur if largeur > 0 and hauteur > 0 else 0


def contenu_dans(a, b, marge):
    return (
        a[0] >= b[0] - marge
        and a[1] >= b[1] - marge
        and a[0] + a[2] <= b[0] + b[2] + marge
        and a[1] + a[3] <= b[1] + b[3] + marge
    )


def trop_long(shape, zone):
    """Estimation : le texte tient-il dans la hauteur de sa zone ?"""
    taille = taille_police(shape)
    if not taille or zone[2] <= 0:
        return False
    par_ligne = max(1, int(zone[2] / 12700 / (taille * 0.5)))
    lignes = sum(max(1, math.ceil(len(p.text) / par_ligne)) for p in shape.text_frame.paragraphs)
    return lignes * taille * 1.2 > zone[3] / 12700 * 1.15


def problemes(presentation, slide):
    largeur, hauteur = presentation.slide_width, presentation.slide_height
    marge = int(largeur * 0.005)
    formes = [(rang, shape, cadre(shape)) for rang, shape in enumerate(slide.shapes, 1)]
    formes = [element for element in formes if element[2] is not None]
    constats = []
    for rang, shape, zone in formes:
        if (
            zone[0] < -marge
            or zone[1] < -marge
            or zone[0] + zone[2] > largeur + marge
            or zone[1] + zone[3] > hauteur + marge
        ):
            constats.append(f"[{rang}] déborde de la diapositive")
        if texte_de(shape).strip() and trop_long(shape, zone):
            constats.append(f"[{rang}] texte probablement trop long pour sa zone")
    for rang, shape, zone in formes:
        if not texte_de(shape).strip():
            continue
        for autre_rang, autre, autre_zone in formes:
            if autre_rang == rang:
                continue
            commun = intersection(zone, autre_zone)
            if commun == 0:
                continue
            aire = zone[2] * zone[3]
            if texte_de(autre).strip():
                plus_petite = min(aire, autre_zone[2] * autre_zone[3])
                if rang < autre_rang and plus_petite and commun / plus_petite > 0.15:
                    constats.append(f"[{rang}] et [{autre_rang}] : textes superposés")
            elif (
                aire
                and commun / min(aire, autre_zone[2] * autre_zone[3]) > 0.03
                and not contenu_dans(zone, autre_zone, marge)
            ):
                constats.append(f"[{rang}] coupe la forme [{autre_rang}]")
    return constats


def decrire(presentation, numero):
    slide = diapositive(presentation, numero)
    largeur, hauteur = presentation.slide_width, presentation.slide_height
    print(f"Diapositive {numero}/{len(presentation.slides)} | fond : {fond(slide)}")
    for rang, shape in enumerate(slide.shapes, 1):
        zone = cadre(shape)
        position = (
            f"gauche {zone[0] * 100 / largeur:.0f}% haut {zone[1] * 100 / hauteur:.0f}% "
            f"largeur {zone[2] * 100 / largeur:.0f}% hauteur {zone[3] * 100 / hauteur:.0f}%"
            if zone
            else "position héritée"
        )
        taille = taille_police(shape)
        details = f" | {taille:g} pt" if taille else ""
        texte = " / ".join(p.text for p in shape.text_frame.paragraphs) if shape.has_text_frame else ""
        contenu = f' | "{texte[:160]}"' if texte.strip() else ""
        print(f"  [{rang}] {shape.name} | {position}{details}{contenu}")


def signaler(presentation, numeros):
    """Après une modification : ce qui semble mal placé sur les diapositives touchées."""
    constats = [
        f"Diapositive {numero} : {constat}"
        for numero in sorted(set(numeros))
        if 1 <= numero <= len(presentation.slides)
        for constat in problemes(presentation, presentation.slides[numero - 1])
    ]
    if constats:
        print("À vérifier :")
        for constat in constats:
            print(f"  {constat}")
    else:
        print("Aucun problème de position détecté.")


def remplacer_dans_paragraphe(paragraphe, ancien, nouveau):
    """Remplace en gardant le style de chaque morceau, même si le texte est coupé en plusieurs."""
    remplacements = 0
    debut = 0
    while True:
        morceaux = paragraphe.runs
        complet = "".join(morceau.text for morceau in morceaux)
        trouve = complet.find(ancien, debut)
        if trouve < 0:
            return remplacements
        fin = trouve + len(ancien)
        position = 0
        premier = True
        for morceau in morceaux:
            texte = morceau.text
            bas, haut = position, position + len(texte)
            position = haut
            if haut <= trouve or bas >= fin:
                continue
            gauche = max(trouve, bas) - bas
            droite = min(fin, haut) - bas
            morceau.text = texte[:gauche] + (nouveau if premier else "") + texte[droite:]
            premier = False
        remplacements += 1
        debut = trouve + len(nouveau)


def ecrire_paragraphe(paragraphe, texte):
    """Remplace tout le texte d'un paragraphe en gardant le style de son premier morceau."""
    morceaux = paragraphe.runs
    if not morceaux:
        paragraphe.add_run().text = texte
        return
    morceaux[0].text = texte
    for morceau in morceaux[1:]:
        morceau._r.getparent().remove(morceau._r)


def zone_de(shape):
    if not shape.has_text_frame:
        raise Erreur(f"La forme « {shape.name} » ne contient pas de texte.")
    return shape.text_frame


def pourcentages(shape, presentation, gauche=None, haut=None, largeur=None, hauteur=None):
    if gauche is not None:
        shape.left = int(presentation.slide_width * gauche / 100)
    if haut is not None:
        shape.top = int(presentation.slide_height * haut / 100)
    if largeur is not None:
        shape.width = int(presentation.slide_width * largeur / 100)
    if hauteur is not None:
        shape.height = int(presentation.slide_height * hauteur / 100)


def inspecter(arguments):
    presentation = ouvrir(arguments.fichier)
    numeros = [arguments.diapo] if arguments.diapo else range(1, len(presentation.slides) + 1)
    for numero in numeros:
        decrire(presentation, numero)
    signaler(presentation, numeros)


def remplacer(arguments):
    presentation = ouvrir(arguments.fichier)
    numeros = [arguments.diapo] if arguments.diapo else list(range(1, len(presentation.slides) + 1))
    total = 0
    touchees = []
    for numero in numeros:
        compte = sum(
            remplacer_dans_paragraphe(paragraphe, arguments.ancien, arguments.nouveau)
            for zone in zones_de_texte(diapositive(presentation, numero).shapes)
            for paragraphe in zone.paragraphs
        )
        total += compte
        if compte:
            touchees.append(numero)
    if total == 0:
        raise Erreur(f"Texte introuvable : « {arguments.ancien} ». Utilise inspecter pour voir le texte exact.")
    enregistrer(presentation, arguments.fichier)
    print(f"{total} remplacement(s) sur la ou les diapositives {touchees}.")
    signaler(presentation, touchees)


def modifier_texte(arguments):
    presentation = ouvrir(arguments.fichier)
    zone = zone_de(forme(diapositive(presentation, arguments.diapo), arguments.forme))
    paragraphes = zone.paragraphs
    ecrire_paragraphe(paragraphes[0], arguments.texte)
    for paragraphe in paragraphes[1:]:
        paragraphe._p.getparent().remove(paragraphe._p)
    enregistrer(presentation, arguments.fichier)
    print(f"Texte de la forme {arguments.forme} remplacé.")
    signaler(presentation, [arguments.diapo])


def ajouter_paragraphe(arguments):
    presentation = ouvrir(arguments.fichier)
    zone = zone_de(forme(diapositive(presentation, arguments.diapo), arguments.forme))
    dernier = zone.paragraphs[-1]._p
    copie = copy.deepcopy(dernier)
    dernier.addnext(copie)
    ecrire_paragraphe(zone.paragraphs[-1], arguments.texte)
    enregistrer(presentation, arguments.fichier)
    print(f"Paragraphe ajouté à la forme {arguments.forme}.")
    signaler(presentation, [arguments.diapo])


def copier_forme(arguments):
    presentation = ouvrir(arguments.fichier)
    source = forme(diapositive(presentation, arguments.diapo), arguments.forme)
    zone_de(source)
    cible = diapositive(presentation, arguments.vers_diapo)
    element = copy.deepcopy(source._element)
    identifiants = [int(node.get("id")) for node in cible.shapes._spTree.iter(qn("p:cNvPr"))]
    element.find(".//" + qn("p:cNvPr")).set("id", str(max(identifiants, default=1) + 1))
    cible.shapes._spTree.append(element)
    nouvelle = list(cible.shapes)[-1]
    paragraphes = nouvelle.text_frame.paragraphs
    ecrire_paragraphe(paragraphes[0], arguments.texte)
    for paragraphe in paragraphes[1:]:
        paragraphe._p.getparent().remove(paragraphe._p)
    pourcentages(nouvelle, presentation, arguments.gauche, arguments.haut)
    enregistrer(presentation, arguments.fichier)
    print(f"Forme [{len(list(cible.shapes))}] créée sur la diapositive {arguments.vers_diapo}, avec le même style.")
    signaler(presentation, [arguments.vers_diapo])


def deplacer_forme(arguments):
    presentation = ouvrir(arguments.fichier)
    shape = forme(diapositive(presentation, arguments.diapo), arguments.forme)
    pourcentages(shape, presentation, arguments.gauche, arguments.haut, arguments.largeur, arguments.hauteur)
    enregistrer(presentation, arguments.fichier)
    print(f"Forme {arguments.forme} déplacée.")
    signaler(presentation, [arguments.diapo])


def supprimer_forme(arguments):
    presentation = ouvrir(arguments.fichier)
    shape = forme(diapositive(presentation, arguments.diapo), arguments.forme)
    nom = shape.name
    shape._element.getparent().remove(shape._element)
    enregistrer(presentation, arguments.fichier)
    print(f"Forme « {nom} » supprimée. Les numéros des formes suivantes ont changé.")
    signaler(presentation, [arguments.diapo])


def changer_relations(element, correspondances):
    for noeud in element.iter():
        for attribut, valeur in list(noeud.attrib.items()):
            if attribut.startswith(ESPACE_RELATIONS) and valeur in correspondances:
                noeud.set(attribut, correspondances[valeur])


def placer_diapositive(presentation, depuis, vers):
    liste = presentation.slides._sldIdLst
    elements = list(liste)
    element = elements[depuis - 1]
    liste.remove(element)
    liste.insert(vers - 1, element)


def dupliquer_diapo(arguments):
    presentation = ouvrir(arguments.fichier)
    source = diapositive(presentation, arguments.diapo)
    total = len(presentation.slides) + 1
    position = arguments.position or arguments.diapo + 1
    if not 1 <= position <= total:
        raise Erreur(f"Position {position} impossible : choisis entre 1 et {total}.")
    nouvelle = presentation.slides.add_slide(source.slide_layout)
    arbre = nouvelle.shapes._spTree
    for element in list(arbre):
        if element.tag in BALISES_FORMES:
            arbre.remove(element)
    correspondances = {}
    for relation in source.part.rels.values():
        if relation.reltype.endswith(("/notesSlide", "/slideLayout")):
            continue
        correspondances[relation.rId] = (
            nouvelle.part.relate_to(relation.target_ref, relation.reltype, is_external=True)
            if relation.is_external
            else nouvelle.part.relate_to(relation.target_part, relation.reltype)
        )
    for element in source.shapes._spTree:
        if element.tag in BALISES_FORMES:
            copie = copy.deepcopy(element)
            changer_relations(copie, correspondances)
            arbre.append(copie)
    fond_source = source._element.find(qn("p:cSld")).find(qn("p:bg"))
    if fond_source is not None:
        copie = copy.deepcopy(fond_source)
        changer_relations(copie, correspondances)
        nouvelle._element.find(qn("p:cSld")).insert(0, copie)
    placer_diapositive(presentation, total, position)
    enregistrer(presentation, arguments.fichier)
    print(f"Diapositive {arguments.diapo} dupliquée en position {position}, avec le même fond et le même style.")
    signaler(presentation, [position])


def supprimer_diapo(arguments):
    presentation = ouvrir(arguments.fichier)
    diapositive(presentation, arguments.diapo)
    if len(presentation.slides) == 1:
        raise Erreur("Impossible de supprimer la seule diapositive.")
    liste = presentation.slides._sldIdLst
    element = list(liste)[arguments.diapo - 1]
    presentation.part.drop_rel(element.rId)
    liste.remove(element)
    enregistrer(presentation, arguments.fichier)
    print(f"Diapositive {arguments.diapo} supprimée. Il en reste {len(presentation.slides)}.")


def deplacer_diapo(arguments):
    presentation = ouvrir(arguments.fichier)
    diapositive(presentation, arguments.diapo)
    diapositive(presentation, arguments.position)
    placer_diapositive(presentation, arguments.diapo, arguments.position)
    enregistrer(presentation, arguments.fichier)
    print(f"Diapositive {arguments.diapo} placée en position {arguments.position}.")


def restaurer(arguments):
    fichier = pathlib.Path(arguments.fichier)
    copies = sorted(SAUVEGARDES.glob(f"{fichier.stem}.*.pptx"))
    if not copies:
        raise Erreur("Aucune sauvegarde pour ce fichier.")
    os.replace(copies[-1], fichier)
    print("Dernière sauvegarde restaurée.")


def lancer(commande, delai):
    try:
        resultat = subprocess.run(commande, capture_output=True, text=True, timeout=delai, check=False)
    except subprocess.TimeoutExpired as erreur:
        raise Erreur(f"{commande[0]} a mis trop de temps.") from erreur
    if resultat.returncode != 0:
        raise Erreur(f"{commande[0]} a échoué : {(resultat.stderr or resultat.stdout)[:300]}")


def apercu(arguments):
    """Produit .travail/apercu/diapo-N.jpg pour les diapositives demandées."""
    presentation = ouvrir(arguments.fichier)
    numeros = [int(numero) for numero in arguments.diapos.split(",")]
    for numero in numeros:
        diapositive(presentation, numero)
    soffice = shutil.which("soffice")
    pdftoppm = shutil.which("pdftoppm")
    if not soffice or not pdftoppm:
        raise Erreur("LibreOffice ou Poppler n'est pas installé sur cette machine.")
    shutil.rmtree(APERCU, ignore_errors=True)
    APERCU.mkdir(parents=True)
    profil = pathlib.Path(os.environ.get("HOME", ".")).resolve() / ".libreoffice-bria"
    lancer(
        [
            soffice,
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation={profil.as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(APERCU),
            arguments.fichier,
        ],
        210,
    )
    pdf = APERCU / f"{pathlib.Path(arguments.fichier).stem}.pdf"
    if not pdf.is_file():
        raise Erreur("LibreOffice n'a pas produit de PDF.")
    for numero in numeros:
        lancer(
            [
                pdftoppm,
                "-jpeg",
                "-jpegopt",
                f"quality={QUALITE_APERCU}",
                "-f",
                str(numero),
                "-l",
                str(numero),
                "-scale-to-x",
                str(LARGEUR_APERCU),
                "-scale-to-y",
                "-1",
                "-singlefile",
                str(pdf),
                str(APERCU / f"diapo-{numero}"),
            ],
            30,
        )
    print(f"total={len(presentation.slides)}")


def interface():
    analyseur = argparse.ArgumentParser(prog="bria-doc", description="Modifier une présentation .pptx.")
    commandes = analyseur.add_subparsers(dest="commande", required=True)

    def commande(nom, fonction, *positionnels, options=()):
        sous = commandes.add_parser(nom)
        sous.add_argument("fichier")
        for positionnel, genre in positionnels:
            sous.add_argument(positionnel, type=genre)
        for option, genre, requise in options:
            sous.add_argument(option, type=genre, required=requise)
        sous.set_defaults(fonction=fonction)

    position = [("--gauche", float, False), ("--haut", float, False)]
    commande("inspecter", inspecter, options=[("--diapo", int, False)])
    commande("remplacer", remplacer, ("ancien", str), ("nouveau", str), options=[("--diapo", int, False)])
    commande("modifier-texte", modifier_texte, ("diapo", int), ("forme", int), ("texte", str))
    commande("ajouter-paragraphe", ajouter_paragraphe, ("diapo", int), ("forme", int), ("texte", str))
    commande(
        "copier-forme",
        copier_forme,
        ("diapo", int),
        ("forme", int),
        ("vers_diapo", int),
        ("texte", str),
        options=position,
    )
    commande(
        "deplacer-forme",
        deplacer_forme,
        ("diapo", int),
        ("forme", int),
        options=[*position, ("--largeur", float, False), ("--hauteur", float, False)],
    )
    commande("supprimer-forme", supprimer_forme, ("diapo", int), ("forme", int))
    commande("dupliquer-diapo", dupliquer_diapo, ("diapo", int), options=[("--position", int, False)])
    commande("supprimer-diapo", supprimer_diapo, ("diapo", int))
    commande("deplacer-diapo", deplacer_diapo, ("diapo", int), ("position", int))
    commande("restaurer", restaurer)
    commande("apercu", apercu, options=[("--diapos", str, True)])
    return analyseur


def principal():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    arguments = interface().parse_args()
    try:
        arguments.fonction(arguments)
    except Erreur as erreur:
        print(f"Erreur : {erreur}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(principal())
