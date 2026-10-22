"""Index de căutare (BM25) peste legile din folderul legi/.

Fiecare lege e împărțită pe articole ("Articolul 12. ..."), iar actele fără
articole (ex. regulamente pe puncte) sunt împărțite în bucăți de ~1500 caractere.
Căutarea ignoră diacriticele și folosește o „rădăcină” simplă (primele 6 litere),
ca „contravenție”, „contravenţional”, „contravenției” să se potrivească între ele.
"""
import math
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

LEGI = Path(__file__).parent / "legi"
MAX_BUCATA = 3500

RE_ARTICOL = re.compile(r"^\s*Art(?:icolul|\.)\s*(\d+(?:[\^/]\d+)?)\s*[.\-–]?\s*(.*)$", re.M)
CUVINTE_GOALE = set(
    "si sau de la in din pe cu care ce se sa nu a al ai ale este sunt fi fost pentru prin "
    "catre dupa mai cel cea cei cele lui unui unei un o ca daca acest aceasta acestei "
    "acestui sale sau iar ori lor le il ii isi poate pot".split()
)


@dataclass
class Bucata:
    lege: str        # titlul legii
    sursa: str       # link legis.md
    articol: str     # "Articolul 228" sau "fragment 3"
    text: str


def fara_diacritice(s: str) -> str:
    s = s.replace("ş", "ș").replace("ţ", "ț").replace("Ş", "Ș").replace("Ţ", "Ț")
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def cuvinte(s: str) -> list[str]:
    s = fara_diacritice(s.lower())
    return [w[:6] for w in re.findall(r"[a-z0-9]+", s) if w not in CUVINTE_GOALE and len(w) > 1]


def _imparte_lung(antet: str, text: str) -> list[str]:
    if len(text) <= MAX_BUCATA:
        return [text]
    parti, curent = [], ""
    for par in text.split("\n"):
        if len(curent) + len(par) > MAX_BUCATA and curent:
            parti.append(curent)
            curent = antet + " (continuare)\n"
        curent += par + "\n"
    if curent.strip():
        parti.append(curent)
    return parti


def citeste_lege(cale: Path) -> list[Bucata]:
    brut = cale.read_text(encoding="utf-8")
    antet, _, corp = brut.partition("\n\n")
    titlu = re.search(r"TITLU: (.*)", antet).group(1)
    sursa = re.search(r"SURSA: (.*)", antet).group(1)

    potriviri = list(RE_ARTICOL.finditer(corp))
    bucati = []
    if len(potriviri) >= 5:
        for i, m in enumerate(potriviri):
            sfarsit = potriviri[i + 1].start() if i + 1 < len(potriviri) else len(corp)
            text = corp[m.start():sfarsit].strip()
            nume = f"Articolul {m.group(1)}"
            for parte in _imparte_lung(nume, text):
                bucati.append(Bucata(titlu, sursa, nume, parte))
    else:
        # fără articole: bucăți de paragrafe consecutive
        curent, n = "", 1
        for par in corp.split("\n"):
            if len(curent) + len(par) > 1500 and curent:
                bucati.append(Bucata(titlu, sursa, f"fragment {n}", curent.strip()))
                curent, n = "", n + 1
            curent += par + "\n"
        if curent.strip():
            bucati.append(Bucata(titlu, sursa, f"fragment {n}", curent.strip()))
    return bucati


class Index:
    def __init__(self):
        self.incarca()

    def incarca(self):
        self.bucati: list[Bucata] = []
        for cale in sorted(LEGI.glob("*.txt")):
            self.bucati.extend(citeste_lege(cale))
        self.tf = []
        df = Counter()
        for b in self.bucati:
            c = Counter(cuvinte(b.lege + " " + b.text))
            self.tf.append(c)
            df.update(c.keys())
        n = len(self.bucati)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}
        self.lung = [sum(c.values()) for c in self.tf]
        self.lung_medie = sum(self.lung) / max(n, 1)
        self.legi = sorted({b.lege for b in self.bucati})

    def cauta(self, intrebare: str, k: int = 8) -> list[tuple[float, int]]:
        termeni = set(cuvinte(intrebare))
        scoruri = defaultdict(float)
        k1, bb = 1.5, 0.75
        for i, tf in enumerate(self.tf):
            s = 0.0
            for t in termeni:
                f = tf.get(t)
                if f:
                    s += self.idf[t] * f * (k1 + 1) / (f + k1 * (1 - bb + bb * self.lung[i] / self.lung_medie))
            if s:
                scoruri[i] = s
        return sorted(((s, i) for i, s in scoruri.items()), reverse=True)[:k]

    def articol(self, lege_fragment: str, nr: str) -> list[int]:
        """Caută direct „art. 228 din Codul contravențional”."""
        lf = fara_diacritice(lege_fragment.lower())
        return [
            i for i, b in enumerate(self.bucati)
            if b.articol == f"Articolul {nr}" and lf in fara_diacritice(b.lege.lower())
        ]

    def cauta_multiplu(self, interogari: list[str], k: int = 10) -> list[Bucata]:
        """Combină rezultatele mai multor căutări (reciprocal rank fusion)."""
        scor = defaultdict(float)
        for q in interogari:
            for rang, (_, i) in enumerate(self.cauta(q, k=k)):
                scor[i] += 1 / (60 + rang)
        alese = sorted(scor, key=scor.get, reverse=True)[:k]
        return [self.bucati[i] for i in alese]


if __name__ == "__main__":
    import sys
    idx = Index()
    print(f"{len(idx.bucati)} bucăți din {len(idx.legi)} acte")
    for b in idx.cauta_multiplu([" ".join(sys.argv[1:]) or "poliția cere actul de identitate"], k=5):
        print(f"\n--- {b.lege} — {b.articol}\n{b.text[:400]}")
