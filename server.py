#!/usr/bin/env python3
"""Serveur local du dashboard : sert les fichiers statiques (index.html,
script.js, styles.css) et expose POST /open-file pour ouvrir un fichier
Excel dans son application par défaut (Excel), depuis le bouton du dashboard.
"""
import json
import platform
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8080
# Le serveur n'écoute qu'en local, mais /open-file exécute une commande
# système : on vérifie que la requête vient bien du dashboard lui-même,
# pour qu'une page tierce ouverte dans le même navigateur ne puisse pas
# déclencher l'ouverture d'un fichier arbitraire sur la machine.
ALLOWED_ORIGIN = f'http://localhost:{PORT}'


class Handler(SimpleHTTPRequestHandler):
    # Interdiction de mise en cache. Sans ces en-têtes, Chrome garde script.js (environ 1 Mo)
    # dans son cache disque : apres un git pull, la page affiche parfois brievement le nouveau
    # fichier puis revient a l'ancien, et l'utilisatrice croit que la mise a jour a echoue.
    # Le numero affiche sous le nom (APP_VERSION) permet de verifier quelle version est chargee.
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        SimpleHTTPRequestHandler.end_headers(self)

    def _from_dashboard(self):
        origin = self.headers.get('Origin') or self.headers.get('Referer') or ''
        return origin.rstrip('/') == ALLOWED_ORIGIN or origin.startswith(ALLOWED_ORIGIN + '/')

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/open-file':
            self.send_error(404, 'Not found')
            return
        if not self._from_dashboard():
            self._send_json(403, {'error': 'origine non autorisée'})
            return
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length) if length else b''
        try:
            data = json.loads(raw or b'{}')
            path = data.get('path')
            if not path or not isinstance(path, str):
                raise ValueError('chemin manquant')
        except Exception:
            self._send_json(400, {'error': 'JSON invalide : attendu { "path": "..." }'})
            return

        system = platform.system()
        try:
            if system == 'Darwin':
                subprocess.run(['open', path], check=True)
            elif system == 'Windows':
                subprocess.run(['cmd', '/c', 'start', '', path], check=True)
            else:
                self._send_json(400, {'error': f'OS non pris en charge pour l\'ouverture : {system}'})
                return
        except subprocess.CalledProcessError as e:
            self._send_json(500, {'error': f"échec de l'ouverture : {e}"})
            return
        except FileNotFoundError as e:
            self._send_json(500, {'error': f"commande introuvable : {e}"})
            return

        self._send_json(200, {'ok': True})


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Dashboard servi sur http://localhost:{PORT}')
    server.serve_forever()
