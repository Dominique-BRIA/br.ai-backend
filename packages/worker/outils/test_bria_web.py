"""Vérifie bria-web sans Internet : un petit serveur local joue le rôle des sites et de SearXNG.

À lancer avec Python 3 :  python test_bria_web.py
"""

import http.server
import json
import os
import pathlib
import subprocess
import sys
import threading

OUTIL = pathlib.Path(__file__).with_name("bria_web.py").resolve()

PAGES = {
    "/article": (
        "text/html; charset=utf-8",
        "<html><head><title>Prix du ciment</title><script>alert(1)</script></head>"
        "<body><nav>Menu</nav><h1>Prix du ciment à Douala</h1><p>Le sac de 50 kg coûte 5 000 FCFA.</p></body></html>",
    ),
    "/notes.txt": ("text/plain", "Notes brutes"),
    "/vers-fichier": None,
}


class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - nom imposé par http.server
        if self.path == "/vers-fichier":
            self.send_response(302)
            self.send_header("Location", "file:///etc/passwd")
            self.end_headers()
            return
        if self.path.startswith("/search"):
            corps = json.dumps(
                {"results": [{"title": "Ciment <b>Douala</b>", "url": "https://exemple.org/ciment", "content": "5 000 FCFA"}]}
            )
            genre = "application/json"
        elif self.path in PAGES and PAGES[self.path]:
            genre, corps = PAGES[self.path]
        else:
            self.send_error(404)
            return
        donnees = corps.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", genre)
        self.send_header("Content-Length", str(len(donnees)))
        self.end_headers()
        self.wfile.write(donnees)

    def log_message(self, *_):
        pass


def lancer(*arguments, base, attendu=0):
    resultat = subprocess.run(
        [sys.executable, "-I", "-B", str(OUTIL), *arguments],
        capture_output=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "BRIA_SEARXNG_URL": base},
        check=False,
    )
    assert resultat.returncode == attendu, resultat.stderr + resultat.stdout
    return resultat.stdout + resultat.stderr


def main():
    serveur = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=serveur.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{serveur.server_address[1]}"
    try:
        trouve = json.loads(lancer("chercher", "prix ciment", base=base))
        assert trouve["moteur"] == "searxng"
        assert trouve["resultats"] == [
            {"titre": "Ciment Douala", "lien": "https://exemple.org/ciment", "extrait": "5 000 FCFA"}
        ]

        article = lancer("lire", f"{base}/article", base=base)
        assert article.startswith("# Prix du ciment\n\nSource : "), article
        assert "Le sac de 50 kg coûte 5 000 FCFA." in article
        assert "alert(1)" not in article

        assert "Notes brutes" in lancer("lire", f"{base}/notes.txt", base=base)
        assert "http et https" in lancer("lire", "file:///etc/passwd", base=base, attendu=1)
        assert "Redirection" in lancer("lire", f"{base}/vers-fichier", base=base, attendu=1)
        assert "inaccessible" in lancer("lire", f"{base}/absente", base=base, attendu=1)
    finally:
        serveur.shutdown()
    print("bria-web : tout est bon")


if __name__ == "__main__":
    main()
