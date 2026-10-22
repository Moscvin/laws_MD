"""Transformă legile din legi/ în worker/legi.sql pentru Cloudflare D1.

    python genereaza_sql.py
    cd worker && npx wrangler d1 execute legi-md --remote --file=legi.sql
"""
import re
from pathlib import Path

from index_legi import LEGI, citeste_lege

IESIRE = Path(__file__).parent / "worker" / "legi.sql"


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def curata(s: str) -> str:
    s = re.sub(r"[ \t ]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


linii = [
    "DROP TABLE IF EXISTS fts;",
    "DROP TABLE IF EXISTS bucati;",
    "CREATE TABLE bucati (id INTEGER PRIMARY KEY, lege TEXT, sursa TEXT, articol TEXT, text TEXT);",
    "CREATE TABLE IF NOT EXISTS istoric (chat_id INTEGER, rol TEXT, text TEXT, ts INTEGER);",
    "CREATE INDEX IF NOT EXISTS istoric_chat ON istoric(chat_id, ts);",
]
n = 0
for cale in sorted(LEGI.glob("*.txt")):
    for b in citeste_lege(cale):
        n += 1
        linii.append(
            f"INSERT INTO bucati VALUES ({n},{q(b.lege)},{q(b.sursa)},{q(b.articol)},{q(curata(b.text))});"
        )
linii += [
    "CREATE VIRTUAL TABLE fts USING fts5(lege, articol, text, content='bucati', content_rowid='id',"
    " tokenize='unicode61 remove_diacritics 2', prefix='4 5 6');",
    "INSERT INTO fts(fts) VALUES('rebuild');",
]
IESIRE.parent.mkdir(exist_ok=True)
IESIRE.write_text("\n".join(linii) + "\n", encoding="utf-8")
print(f"{n} bucăți -> {IESIRE} ({IESIRE.stat().st_size // 1024} KB)")
