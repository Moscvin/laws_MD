# Bot Telegram — legile Republicii Moldova (Gemini + Cloudflare)

Pui o întrebare pe Telegram („Polițistul îmi cere să deschid portbagajul, sunt obligat?”), iar botul
caută articolele relevante din Constituție și coduri și îți răspunde cu Gemini, citând articolele exacte.

Rulează 100% pe Cloudflare Workers (gratuit) — calculatorul poate fi stins.

## Cum funcționează

```
Telegram ──webhook──▶ Cloudflare Worker (worker/src/index.js)
                         │ 1. caută articolele în D1 (full-text FTS5, fără diacritice)
                         │ 2. trimite întrebarea + ~12 articole la Gemini (1 apel / întrebare)
                         ▼
                      răspuns cu articolele citate ──▶ Telegram
```

Acte incluse (descărcate de pe legis.md, versiunea din 22.10.2026):

| Act | doc_id legis.md |
|---|---|
| Constituția Republicii Moldova | 145723 |
| Codul contravențional nr. 218/2008 | 156883 |
| Codul penal nr. 985/2002 | 156270 |
| Codul de procedură penală nr. 122/2003 | 156277 |
| Legea nr. 320/2012 privind activitatea Poliției | 156610 |
| Codul civil nr. 1107/2002 | 150561 |
| Codul muncii nr. 154/2003 | 156681 |
| Regulamentul circulației rutiere (HG 357/2009) | 153581 |
| Legea nr. 131/2007 privind siguranța traficului rutier | 156143 |
| Codul de procedură civilă nr. 225/2003 | 156839 |
| Codul administrativ nr. 116/2018 | 150447 |

## Structura

```
legi/                 textele legilor (un .txt per act)
index_legi.py         împarte legile pe articole; poate fi rulat local pentru test de căutare
genereaza_sql.py      legi/*.txt  ──▶ worker/legi.sql (pentru D1)
receptor.py           server local care primește legile exportate din browser (vezi mai jos)
worker/               botul (Cloudflare Worker)
  src/index.js
  wrangler.toml
```

## Instalare (o singură dată)

Worker-ul și baza D1 `legi-md` sunt deja create și publicate la
`https://bot-legi-md.moscvin-2002.workers.dev`. Mai trebuie doar cheile:

1. **Token Telegram**: în Telegram scrie la [@BotFather](https://t.me/BotFather) → `/newbot` → copiază tokenul.
2. **Cheie Gemini gratuită**: <https://aistudio.google.com/apikey> → *Create API key*.
3. Pune-le în Cloudflare (îți cere să lipești valoarea):

   ```bash
   cd worker && npx wrangler secret put TELEGRAM_TOKEN
   ```

   ```bash
   cd worker && npx wrangler secret put GEMINI_API_KEY
   ```

4. Leagă botul de Worker (deschide în browser, `CHEIE` = valoarea `WEBHOOK_SECRET` din `worker/.dev.vars`):

   ```
   https://bot-legi-md.moscvin-2002.workers.dev/setup?cheie=CHEIE
   ```

   Trebuie să vezi `"ok": true`. Gata — scrie-i botului în Telegram.

### De la zero, pe alt cont Cloudflare

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create legi-md          # copiază database_id în wrangler.toml
npx wrangler d1 execute legi-md --remote --file=legi.sql
openssl rand -hex 24                    # asta e WEBHOOK_SECRET
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
# apoi deschide https://<worker>.workers.dev/setup?cheie=<WEBHOOK_SECRET>
```

## Comenzi în bot

- orice întrebare în text liber — răspuns scurt (~400 caractere: Da/Nu/Depinde, temeiul, ce faci)
- `/detalii` — explicația completă pentru ultima întrebare
- **poză sau PDF cu un proces-verbal**, cu descrierea pozei = ce s-a întâmplat de fapt → botul citește
  procesul-verbal, verifică încadrarea și sancțiunea față de articolul invocat, câmpurile obligatorii
  (art. 443, nulitate art. 445 C.contr.), compară cu relatarea ta și spune termenul de contestare (art. 448).
  O singură poză per mesaj. Poza ajunge la Google Gemini (plan gratuit) — acoperă datele personale.
- `/art 228 contraventional` — textul exact al unui articol
- `/legi` — lista actelor din bază
- `/nou` — uită conversația anterioară (botul ține minte ultimele 3 întrebări)

## Setări (`worker/wrangler.toml`)

- `GEMINI_MODELS` — modelele încercate în ordine; al doilea e rezervă când primul și-a epuizat limita
  gratuită zilnică. Dacă Google redenumește modelele, schimbă aici numele (lista în AI Studio).
- `ALLOWED_USERS` — ID-urile Telegram permise, separate prin virgulă (botul îți spune ID-ul dacă
  nu ești pe listă). Recomandat: limita gratuită Gemini e mică și poate fi consumată de străini.

Endpointuri de test (protejate cu `WEBHOOK_SECRET`):
- `GET /cauta?cheie=CHEIE&q=...` — ce articole găsește căutarea (fără Gemini)
- `GET /intreaba?cheie=CHEIE&q=...[&detaliat]` — răspunsul complet, ca în Telegram
- `POST /pv?cheie=CHEIE&relatare=...` cu imaginea în corp — analiza unui proces-verbal

## Adăugarea / actualizarea legilor

legis.md e protejat de Cloudflare și nu poate fi descărcat automat din scripturi, așa că exportul
se face din Chrome-ul tău:

1. `python3 receptor.py` (ascultă pe `127.0.0.1:8765`)
2. Deschide în Chrome `https://www.legis.md/cautare/getResults?doc_id=<ID>&lang=ro`, apoi în
   consolă (F12):

   ```js
   const id = 156610, nume = "Legea_politiei_320_2012", titlu = "Legea nr. 320/2012 cu privire la activitatea Poliției";
   const html = new DOMParser().parseFromString(await (await fetch('/cautare/showdetails/' + id)).text(), 'text/html').querySelector('.docx').innerHTML;
   const text = new DOMParser().parseFromString(html.replace(/<\/(p|div|h\d|li|tr|table)>|<br\s*\/?>/gi, '\n'), 'text/html').body.textContent.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
   await (await fetch('http://127.0.0.1:8765/', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({doc_id: id, nume, titlu, text})})).text();
   ```

   ID-ul (`doc_id`) se vede în adresa paginii legii pe legis.md.
3. Regenerează și încarcă baza:

   ```bash
   python3 genereaza_sql.py && cd worker && npx wrangler d1 execute legi-md --remote --file=legi.sql
   ```

## Limitări

- Răspunsurile sunt informative, nu consultație juridică.
- Indicii superiori din numerele articolelor s-au pierdut la export: art. 213¹ apare ca „Articolul 2131”.
- Legile sunt o copie din 22.10.2026 — modificările ulterioare nu apar până nu refaci exportul.
