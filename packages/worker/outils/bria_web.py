"""bria-web : chercher sur le web et lire une page, pour les IA de <br/>.

  bria-web chercher "requête"   résultats en JSON : SearXNG installé sur la machine, sinon DuckDuckGo
  bria-web lire URL             le texte principal de la page, en Markdown

La lecture est lancée sous le compte des commandes de l'IA : son pare-feu interdit le réseau interne
et les métadonnées de l'hébergeur, une adresse piégée ne peut donc rien atteindre d'autre qu'Internet.
"""

import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

SEARXNG = os.environ.get("BRIA_SEARXNG_URL", "http://127.0.0.1:8888")
RESULTATS = 8
DELAI = 20
MAX_OCTETS = 8 * 1024 * 1024
MAX_CARACTERES = 60_000
AGENT = "Mozilla/5.0 (X11; Linux x86_64) br-ia/1.0"


class Erreur(Exception):
    """Une erreur à montrer telle quelle à l'IA."""


def chercher(requete):
    resultats, moteur, erreurs = [], None, []
    try:
        resultats, moteur = searxng(requete), "searxng"
    except Exception as erreur:  # noqa: BLE001 - toute panne fait passer au moteur de secours
        erreurs.append(f"SearXNG : {erreur}")
    if not resultats:
        try:
            resultats, moteur = duckduckgo(requete), "duckduckgo"
        except Exception as erreur:  # noqa: BLE001
            erreurs.append(f"DuckDuckGo : {erreur}")
    if not resultats:
        raise Erreur("Aucun résultat. " + " ; ".join(erreurs) if erreurs else "Aucun résultat.")
    return {"moteur": moteur, "resultats": resultats[:RESULTATS]}


def searxng(requete):
    adresse = f"{SEARXNG}/search?" + urllib.parse.urlencode({"q": requete, "format": "json"})
    with urllib.request.urlopen(urllib.request.Request(adresse, headers={"User-Agent": AGENT}), timeout=DELAI) as reponse:
        donnees = json.load(reponse)
    return [
        {
            "titre": nettoyer(r.get("title", "")),
            "lien": r.get("url", ""),
            "extrait": nettoyer(r.get("content", ""))[:400],
        }
        for r in donnees.get("results", [])
        if str(r.get("url", "")).startswith(("http://", "https://"))
    ]


def duckduckgo(requete):
    from ddgs import DDGS  # noqa: PLC0415 - facultatif : seulement en secours

    return [
        {"titre": nettoyer(r.get("title", "")), "lien": r.get("href", ""), "extrait": nettoyer(r.get("body", ""))[:400]}
        for r in DDGS().text(requete, max_results=RESULTATS)
        if str(r.get("href", "")).startswith(("http://", "https://"))
    ]


def nettoyer(texte):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", str(texte)))).strip()


class RedirectionWeb(urllib.request.HTTPRedirectHandler):
    """Une redirection ne peut mener qu'à une autre page web."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme not in ("http", "https"):
            raise Erreur("Redirection vers une adresse qui n'est pas une page web.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def telecharger(url):
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise Erreur("Seules les adresses http et https peuvent être lues.")
    ouvreur = urllib.request.build_opener(RedirectionWeb)
    requete = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept-Language": "fr,en;q=0.8"})
    try:
        with ouvreur.open(requete, timeout=DELAI) as reponse:
            contenu = reponse.read(MAX_OCTETS + 1)
            return contenu[:MAX_OCTETS], reponse.headers.get_content_type(), reponse.geturl(), reponse.headers.get_content_charset()
    except Erreur:
        raise
    except Exception as erreur:  # noqa: BLE001
        raise Erreur(f"Page inaccessible : {erreur}") from erreur


def lire(url):
    contenu, genre, finale, encodage = telecharger(url)
    if genre == "application/pdf" or contenu[:5] == b"%PDF-":
        return entete("", finale) + pdf(contenu)
    texte = contenu.decode(encodage or "utf-8", errors="replace")
    if genre in ("text/plain", "text/markdown", "text/csv", "application/json"):
        return entete("", finale) + texte
    titre = nettoyer((re.search(r"<title[^>]*>(.*?)</title>", texte, re.S | re.I) or [None, ""])[1])
    return entete(titre, finale) + page(texte, finale)


def entete(titre, url):
    return (f"# {titre}\n\n" if titre else "") + f"Source : {url}\n\n"


def page(texte, url):
    try:
        import trafilatura  # noqa: PLC0415 - installé sur la machine cloud

        extrait = trafilatura.extract(
            texte, url=url, output_format="markdown", include_tables=True, include_links=False, favor_recall=True
        )
        if extrait:
            return extrait
    except ImportError:
        pass
    # Sans Trafilatura, ou s'il ne trouve rien : le texte brut de la page.
    brut = re.sub(r"<(script|style|nav|header|footer|noscript)[\s\S]*?</\1>", "", texte, flags=re.I)
    brut = re.sub(r"</(p|div|h[1-6]|li|tr)>|<br\s*/?>", "\n", brut, flags=re.I)
    lignes = (nettoyer(ligne) for ligne in re.sub(r"<[^>]+>", " ", brut).splitlines())
    return "\n".join(ligne for ligne in lignes if ligne)


def pdf(contenu):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as fichier:
        fichier.write(contenu)
        fichier.flush()
        try:
            resultat = subprocess.run(
                ["pdftotext", "-enc", "UTF-8", fichier.name, "-"], capture_output=True, timeout=60, check=False
            )
        except FileNotFoundError as erreur:
            raise Erreur("Lecture des PDF indisponible sur cette machine.") from erreur
    texte = resultat.stdout.decode("utf-8", errors="replace").strip()
    if not texte:
        raise Erreur("PDF sans texte lisible : c'est sans doute une image scannée.")
    return texte


def principal():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 3 or sys.argv[1] not in ("chercher", "lire"):
        print('Usage : bria-web chercher "requête" | bria-web lire URL', file=sys.stderr)
        return 2
    action, valeur = sys.argv[1], sys.argv[2].strip()
    try:
        if action == "chercher":
            print(json.dumps(chercher(valeur), ensure_ascii=False))
        else:
            texte = lire(valeur)
            if len(texte) > MAX_CARACTERES:
                texte = texte[:MAX_CARACTERES] + f"\n\n[… page coupée : {MAX_CARACTERES} premiers caractères]"
            print(texte)
    except Erreur as erreur:
        print(f"Erreur : {erreur}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(principal())
