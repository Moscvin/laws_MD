"""Receptor local: primește textul legilor trimis din browser (pagina legis.md)
și îl salvează în folderul legi/. Rulează doar pe 127.0.0.1.

    python receptor.py
"""
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

LEGI = Path(__file__).parent / "legi"
LEGI.mkdir(exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ("https://www.legis.md", "https://legis.md"):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        doc_id = re.sub(r"\D", "", str(data["doc_id"]))
        nume = re.sub(r"[^\w\-]+", "_", data["nume"]).strip("_")
        cale = LEGI / f"{nume}__{doc_id}.txt"
        cale.write_text(
            f"TITLU: {data['titlu']}\nSURSA: https://www.legis.md/cautare/getResults?doc_id={doc_id}&lang=ro\n\n{data['text']}",
            encoding="utf-8",
        )
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(f"salvat {cale.name} ({len(data['text'])} caractere)".encode())
        print("salvat", cale.name)


if __name__ == "__main__":
    print("Receptor pe http://127.0.0.1:8765")
    HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
