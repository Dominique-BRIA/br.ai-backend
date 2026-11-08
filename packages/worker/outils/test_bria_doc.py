"""Vérifie bria-doc sur une présentation créée pour l'occasion.

À lancer avec un Python qui a python-pptx :  python test_bria_doc.py
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

OUTIL = pathlib.Path(__file__).with_name("bria_doc.py").resolve()


def creer(chemin):
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    vide = presentation.slide_layouts[6]
    slide = presentation.slides.add_slide(vide)
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = RGBColor(0x0F, 0x17, 0x2A)
    barre = slide.shapes.add_shape(1, Inches(1), Inches(2), Inches(0.2), Inches(3))
    barre.name = "Barre"
    titre = slide.shapes.add_textbox(Inches(2), Inches(2), Inches(10), Inches(1.2))
    titre.name = "Titre"
    paragraphe = titre.text_frame.paragraphs[0]
    debut = paragraphe.add_run()
    debut.text = "Plateforme "
    debut.font.size = Pt(40)
    debut.font.bold = True
    debut.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    fin = paragraphe.add_run()
    fin.text = "NéoProjet 2025"
    fin.font.size = Pt(40)
    fin.font.bold = True
    fin.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    presentation.slides.add_slide(vide)
    presentation.save(chemin)


def commande(*arguments, attendu=0):
    resultat = subprocess.run(
        [sys.executable, "-I", "-B", str(OUTIL), *arguments],
        capture_output=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        check=False,
    )
    assert resultat.returncode == attendu, resultat.stderr + resultat.stdout
    return resultat.stdout + resultat.stderr


def verifier_archive(chemin):
    with zipfile.ZipFile(chemin) as archive:
        assert archive.testzip() is None
        noms = archive.namelist()
        assert len(noms) == len(set(noms)), "entrées en double"


def main():
    depart = os.getcwd()
    with tempfile.TemporaryDirectory() as dossier:
        os.chdir(dossier)
        try:
            scenario()
        finally:
            os.chdir(depart)
    print("bria-doc : tout est bon")


def scenario():
    creer("p.pptx")

    # Un titre coupé en deux morceaux est remplacé, avec son style, sans rien ajouter.
    sortie = commande("remplacer", "p.pptx", "Plateforme NéoProjet 2025", "Projet Avenger", "--diapo", "1")
    assert "1 remplacement" in sortie
    presentation = Presentation("p.pptx")
    slide = presentation.slides[0]
    assert len(slide.shapes) == 2
    titre = slide.shapes[1]
    assert titre.text_frame.text == "Projet Avenger"
    morceau = next(r for r in titre.text_frame.paragraphs[0].runs if r.text)
    assert morceau.font.size == Pt(40) and morceau.font.bold
    assert morceau.font.color.rgb == RGBColor(0xFF, 0xFF, 0xFF)
    assert "#0F172A" in commande("inspecter", "p.pptx", "--diapo", "1")

    # Texte introuvable : erreur claire, fichier intact.
    assert "introuvable" in commande("remplacer", "p.pptx", "absent", "x", attendu=1)

    # Une zone qui coupe la barre est signalée, comme l'erreur vue en production.
    sortie = commande(
        "copier-forme", "p.pptx", "1", "2", "1", "Mal placé", "--gauche", "3", "--haut", "35"
    )
    assert "coupe la forme [1]" in sortie, sortie
    assert "Forme [3]" in sortie
    assert "restaurée" in commande("restaurer", "p.pptx")
    assert len(Presentation("p.pptx").slides[0].shapes) == 2

    # Une nouvelle diapositive reprend le fond et le style, à la position voulue.
    commande("dupliquer-diapo", "p.pptx", "1", "--position", "3")
    presentation = Presentation("p.pptx")
    assert len(presentation.slides) == 3
    copie = presentation.slides[2]
    assert copie.shapes[1].text_frame.text == "Projet Avenger"
    assert "#0F172A" in commande("inspecter", "p.pptx", "--diapo", "3")
    commande("remplacer", "p.pptx", "Projet Avenger", "Merci, c'était BRIA", "--diapo", "3")
    presentation = Presentation("p.pptx")
    assert presentation.slides[0].shapes[1].text_frame.text == "Projet Avenger"
    assert presentation.slides[2].shapes[1].text_frame.text == "Merci, c'était BRIA"

    # Ajouter, réécrire, déplacer, supprimer.
    commande("ajouter-paragraphe", "p.pptx", "3", "2", "Deuxième ligne")
    assert len(Presentation("p.pptx").slides[2].shapes[1].text_frame.paragraphs) == 2
    commande("modifier-texte", "p.pptx", "3", "2", "Fin")
    zone = Presentation("p.pptx").slides[2].shapes[1].text_frame
    assert zone.text == "Fin" and zone.paragraphs[0].runs[0].font.size == Pt(40)
    commande("deplacer-forme", "p.pptx", "3", "2", "--gauche", "120")
    assert "déborde" in commande("inspecter", "p.pptx", "--diapo", "3")
    commande("deplacer-forme", "p.pptx", "3", "2", "--gauche", "20")
    commande("supprimer-forme", "p.pptx", "3", "1")
    assert len(Presentation("p.pptx").slides[2].shapes) == 1

    # Déplacer puis supprimer des diapositives.
    commande("deplacer-diapo", "p.pptx", "3", "1")
    assert Presentation("p.pptx").slides[0].shapes[0].text_frame.text == "Fin"
    commande("supprimer-diapo", "p.pptx", "1")
    assert len(Presentation("p.pptx").slides) == 2
    verifier_archive("p.pptx")

    assert "inexistante" in commande("inspecter", "p.pptx", "--diapo", "9", attendu=1)
    assert len(list(pathlib.Path(".travail/sauvegardes").glob("p.*.pptx"))) >= 5


if __name__ == "__main__":
    main()
