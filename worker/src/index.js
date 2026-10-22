// Bot Telegram care răspunde la întrebări juridice pe baza legilor Republicii Moldova.
// Legile stau în Cloudflare D1 (tabelul `bucati` + indexul full-text `fts`),
// răspunsul îl scrie Gemini doar pe baza articolelor găsite.

const CUVINTE_GOALE = new Set(
  ("si sau de la in din pe cu care ce se sa nu a al ai ale este sunt fi fost pentru prin catre dupa " +
   "mai cel cea cei cele lui unui unei un o ca daca acest aceasta acestei acestui sale iar ori lor le il " +
   "ii isi poate pot eu mie mi ma tu te el ea ei noi voi am ai are au avea face fac cum cand unde cine " +
   "ce ceva tot toate toti foarte doar dar asa spune spus zis vreau vrea poti pot trebuie mea meu mele")
    .split(" "),
);

// Cuvinte din vorbirea de zi cu zi -> termenii folosiți în lege.
const SINONIME = {
  // Orele -> termenii din lege (CPP art. 6 pct. 49-50: noaptea = 22:00-6:00).
  diminea: "noptii zilei",
  noapt: "noptii",
  seara: "noptii",
  buletin: "identitate legitimare",
  pasaport: "identitate legitimare",
  acte: "identitate legitimare",
  perchez: "perchezitie control",
  portbagaj: "control vehicul",
  politist: "politie",
  politai: "politie",
  amenda: "amenda contraventie",
  permis: "permis conducere",
  beat: "ebrietate alcool",
  alcool: "ebrietate",
  masina: "vehicul autovehicul",
  sofer: "conducator vehicul",
  retinut: "retinere",
  arestat: "arest retinere",
  avocat: "aparator avocat",
  filmez: "inregistrare video",
  filma: "inregistrare video",
  salariu: "salariu remunerare",
  concediat: "concediere desfacere contract",
};

const SISTEM = `Ești un asistent juridic pentru Republica Moldova. Răspunzi DOAR pe baza fragmentelor de lege primite în mesaj (Constituția, coduri, legi).
Reguli comune:
- Răspunde în limba în care a fost pusă întrebarea (română sau rusă), simplu și practic.
- Citează sursa ca „art. X alin. (Y) din <act scurt>” (ex. „art. 25 alin. (2) din Legea 320/2012”).
- Pentru fragmentele marcate „fragment N” (acte fără articole, ex. Regulamentul circulației rutiere) citează numărul punctului din text („pct. 12 din Regulamentul circulației rutiere”), niciodată „fragment N”.
- Fiecare afirmație trebuie să rezulte direct din textul articolului citat. Citează doar articole care chiar susțin afirmația; nu adăuga articole doar pentru că apar în fragmente.
- Dacă legea nu spune explicit ceva (de ex. nu prevede nici dreptul, nici interdicția), spune „legea nu prevede expres” în loc să deduci.
- Dacă fragmentele nu acoperă întrebarea, spune asta într-o propoziție. NU inventa articole, numere sau sume.
- Fără formatare Markdown (fără **, #, tabele); doar text simplu.`;

const SISTEM_SCURT = `${SISTEM}
FORMAT SCURT (obligatoriu, maxim 600 de caractere în total):
Prima linie: răspunsul direct (Da / Nu / Depinde) + o propoziție de explicație.
Apoi „Temei:” cu 1-2 articole, fără citate lungi.
Apoi „Ce faci:” cu 1-2 pași concreți, pe câte o linie.
Fără introduceri, fără repetări, fără avertismente.`;

const SISTEM_DETALIAT = `${SISTEM}
FORMAT DETALIAT: 1) Pe scurt, 2) Ce spune legea (articolele relevante, cu citate scurte), 3) Ce poți face concret (pași), 4) Sancțiuni / termene, dacă există.
Încheie cu: informația nu înlocuiește consultația unui avocat.`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("interzis", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(proceseaza(update, env).catch((e) => console.error("eroare", e?.stack || e)));
      return new Response("ok");
    }
    if (url.pathname === "/setup" && url.searchParams.get("cheie") === env.WEBHOOK_SECRET) {
      const r = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
      });
      return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/cauta" && url.searchParams.get("cheie") === env.WEBHOOK_SECRET) {
      // Verificare rapidă a căutării, fără Telegram și fără Gemini.
      const rez = await cautaLegi(env, url.searchParams.get("q") || "", "");
      return new Response(rez.map((b) => `${b.lege} — ${b.articol}\n${b.text.slice(0, 300)}`).join("\n\n"));
    }
    if (url.pathname === "/intreaba" && url.searchParams.get("cheie") === env.WEBHOOK_SECRET) {
      // Test complet (căutare + Gemini) fără Telegram.
      const q = url.searchParams.get("q") || "";
      const detaliat = url.searchParams.has("detaliat");
      const fragmente = await cautaLegi(env, q, "");
      const context = fragmente.map((b, i) => `[${i + 1}] ${b.lege} — ${b.articol}\n${b.text}`).join("\n\n");
      const raspuns = await gemini(env, [{ role: "user", parts: [{ text: `FRAGMENTE DE LEGE GĂSITE:\n\n${context}\n\nÎNTREBAREA MEA:\n${q}` }] }],
        detaliat ? SISTEM_DETALIAT : SISTEM_SCURT, detaliat ? 3072 : 1024);
      return new Response(raspuns);
    }
    if (request.method === "POST" && url.pathname === "/pv" && url.searchParams.get("cheie") === env.WEBHOOK_SECRET) {
      // Test pentru poze cu proces-verbal, fără Telegram: corpul cererii e imaginea.
      const extras = await extrageDinPoza(env, new Uint8Array(await request.arrayBuffer()), request.headers.get("content-type") || "image/jpeg");
      const raspuns = await analizeazaPV(env, extras, url.searchParams.get("relatare") || "", url.searchParams.has("detaliat"));
      return new Response(`${JSON.stringify(extras, null, 1)}\n\n=====\n\n${raspuns}`);
    }
    return new Response("Bot legi Moldova — activ.");
  },
};

async function proceseaza(update, env) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  const permisi = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (permisi.length && !permisi.includes(String(msg.from?.id))) {
    await trimite(env, chatId, `Acces restricționat. ID-ul tău Telegram: ${msg.from?.id}`);
    return;
  }

  // Poză (sau PDF / imagine trimisă ca fișier) cu procesul-verbal.
  const fisier = msg.photo?.at(-1)
    || (/^(image\/|application\/pdf)/.test(msg.document?.mime_type || "") ? msg.document : null);
  if (fisier) {
    await primestePoza(env, chatId, fisier, msg.document?.mime_type || "image/jpeg", (msg.caption || "").trim());
    return;
  }
  if (!msg.text) return;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await trimite(env, chatId,
      "Salut! Descrie situația ta (ex: „Polițistul îmi cere să deschid portbagajul fără motiv, sunt obligat?”) " +
      "și îți răspund scurt, pe baza Constituției și legilor Republicii Moldova, cu articolele exacte.\n\n" +
      "Comenzi:\n/detalii – explicația completă pentru ultima întrebare\n/nou – începe o conversație nouă\n" +
      "/legi – lista actelor din bază\n/art 228 contraventional – textul unui articol\n\n" +
      "Proces-verbal: trimite o poză clară (sau PDF) cu procesul-verbal, iar în descrierea pozei scrie " +
      "ce s-a întâmplat de fapt. Îți spun ce ți se impută și ce nu e completat corect.\n" +
      "Atenție: poza ajunge la Google Gemini (planul gratuit), care o poate folosi pentru antrenare. " +
      "Dacă nu vrei asta, acoperă numele, IDNP-ul și adresa înainte de a o trimite.\n\n" +
      "Informația nu înlocuiește consultația unui avocat.");
    return;
  }
  if (text === "/nou") {
    await env.DB.prepare("DELETE FROM istoric WHERE chat_id = ?").bind(chatId).run();
    await trimite(env, chatId, "Am început o conversație nouă.");
    return;
  }
  if (text === "/legi") {
    const { results } = await env.DB.prepare("SELECT lege, sursa, COUNT(*) n FROM bucati GROUP BY lege ORDER BY lege").all();
    await trimite(env, chatId, results.map((r) => `• ${r.lege}\n  ${r.sursa}`).join("\n"));
    return;
  }
  const cmdArt = normSup(text).match(/^\/art\s+(\d+[¹²³⁴⁵⁶⁷⁸⁹]*)\s*(.*)$/i);
  if (cmdArt) {
    const rez = await articoleDirecte(env, [{ nr: cmdArt[1], act: cmdArt[2] }]);
    await trimite(env, chatId, rez.length
      ? rez.slice(0, 3).map((b) => `${b.lege} — ${b.articol}\n\n${b.text}`).join("\n\n———\n\n")
      : "Nu am găsit articolul. Exemplu: /art 228 contraventional");
    return;
  }

  await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  let istoric = await citesteIstoric(env, chatId);
  let intrebare = text;
  const detaliat = text === "/detalii";
  if (detaliat) {
    // Reluăm ultima întrebare, de data asta cu explicația completă.
    const iUltima = istoric.findLastIndex((m) => m.rol === "user");
    if (iUltima < 0) {
      await trimite(env, chatId, "Pune întâi o întrebare, apoi scrie /detalii.");
      return;
    }
    intrebare = istoric[iUltima].text;
    istoric = istoric.slice(0, iUltima);
    if (intrebare.startsWith(MARCAJ_PV)) {
      const { extras, relatare } = JSON.parse(intrebare.slice(MARCAJ_PV.length));
      await trimite(env, chatId, await analizeazaPV(env, extras, relatare, true));
      return;
    }
  }
  // Căutăm și după ultima întrebare, ca întrebările de tip „și dacă refuz?” să păstreze contextul.
  const ultimaIntrebare = istoric.filter((m) => m.rol === "user").at(-1)?.text || "";
  const fragmente = await cautaLegi(env, intrebare, ultimaIntrebare);

  const context = fragmente
    .map((b, i) => `[${i + 1}] ${b.lege} — ${b.articol}\n${b.text}`)
    .join("\n\n");
  const continut = [
    ...istoric.map((m) => ({ role: m.rol === "user" ? "user" : "model", parts: [{ text: m.text }] })),
    {
      role: "user",
      parts: [{ text: `FRAGMENTE DE LEGE GĂSITE:\n\n${context || "(niciun fragment găsit)"}\n\nÎNTREBAREA MEA:\n${intrebare}` }],
    },
  ];

  let raspuns;
  try {
    raspuns = await gemini(env, continut, detaliat ? SISTEM_DETALIAT : SISTEM_SCURT, detaliat ? 3072 : 1024);
  } catch (e) {
    console.error(e);
    await trimite(env, chatId, "Serviciul AI nu răspunde acum (posibil limita gratuită zilnică Gemini a fost atinsă). Încearcă mai târziu.");
    return;
  }

  await trimite(env, chatId, detaliat ? raspuns : `${raspuns}\n\nMai multe: /detalii`);
  if (detaliat) return; // istoricul are deja întrebarea și răspunsul scurt

  const acum = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO istoric VALUES (?, 'user', ?, ?)").bind(chatId, text, acum),
    env.DB.prepare("INSERT INTO istoric VALUES (?, 'model', ?, ?)").bind(chatId, raspuns, acum + 1),
    env.DB.prepare(
      "DELETE FROM istoric WHERE chat_id = ? AND ts NOT IN (SELECT ts FROM istoric WHERE chat_id = ? ORDER BY ts DESC LIMIT 6)",
    ).bind(chatId, chatId),
  ]);
}

// ---------- Proces-verbal din poză ----------

const MARCAJ_PV = "[PROCES-VERBAL]";

const SISTEM_EXTRAGERE = `Primești poza (sau PDF-ul) unui document din Republica Moldova, de regulă un proces-verbal cu privire la contravenție.
Transcrie-l fidel și returnează DOAR JSON cu forma:
{
  "este_proces_verbal": true/false,
  "tip_document": "...",
  "data_ora_loc_intocmire": "...",
  "agent_constatator": "nume, funcție, subdiviziune",
  "persoana": "doar dacă e completat: DA/NU (nu copia numele, IDNP-ul sau adresa)",
  "fapta_descrisa": "fapta exact cum e scrisă",
  "data_ora_loc_fapta": "...",
  "articole_invocate": [{"nr": "236", "alin": "3", "act": "Codul contravențional"}],
  "sanctiune": "amenda / puncte de penalizare / altele, exact cum e scris",
  "probe_martori": "...",
  "explicatiile_contravenientului": "...",
  "mentiune_drepturi_explicate": "...",
  "mentiune_cale_de_atac": "...",
  "semnaturi": "agent: da/nu; contravenient: da/nu/refuz consemnat",
  "campuri_goale": ["câmpurile vizibile în formular care sunt necompletate"],
  "ilizibil_sau_lipsa_din_poza": ["părți care nu se văd sau nu se pot citi"]
}
Scrie "" pentru ce nu există. Nu ghici: ce nu se poate citi trece la "ilizibil_sau_lipsa_din_poza", nu la "campuri_goale".`;

const SISTEM_PV = `${SISTEM}
Analizezi un proces-verbal cu privire la contravenție (datele extrase din poză sunt în JSON) față de articolele de lege primite.
Reguli speciale:
- Semnalează un câmp ca lipsă doar dacă apare în "campuri_goale". Ce e în "ilizibil_sau_lipsa_din_poza" spui că nu se vede în poză, nu că lipsește.
- Compară fapta descrisă cu textul articolului invocat: se potrivește alineatul? sancțiunea e în limitele articolului?
- Dacă utilizatorul a povestit ce s-a întâmplat, spune unde relatarea lui diferă de procesul-verbal și dacă asta contează juridic.
- Nu spune că procesul-verbal „sigur e nul”; spune ce elemente lipsesc și ce prevede art. 445 pentru ele.`;

const FORMAT_PV_SCURT = `
FORMAT SCURT — STRICT, maxim 900 de caractere, fără explicații lungi:
Ce ți se impută: articolul + sancțiunea, o singură propoziție. Dacă încadrarea nu se potrivește cu fapta, spune-o într-o propoziție.
Probleme: maxim 4 liniuțe, cele mai grave primele (întâi cele care atrag nulitatea absolută, art. 445 alin. (1)); fiecare liniuță = câmpul + articolul, fără citate.
Relatarea ta: o propoziție despre ce diferă și dacă contează (doar dacă utilizatorul a povestit ceva).
Ce faci: o propoziție cu unde și în cât timp contești.`;

const FORMAT_PV_DETALIAT = `
FORMAT DETALIAT: 1) Ce ți se impută (articol, citat scurt, sancțiunea prevăzută), 2) Verificarea elementelor obligatorii (art. 443), câmp cu câmp, 3) Diferențe față de relatarea ta, 4) Ce poți face (contestație: unde, termen, ce anexezi), 5) Ce nu am putut verifica din poză.
Încheie cu: informația nu înlocuiește consultația unui avocat.`;

async function primestePoza(env, chatId, fisier, mime, relatare) {
  await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  if (fisier.file_size > 15 * 1024 * 1024) {
    await trimite(env, chatId, "Fișierul e prea mare (maxim 15 MB). Trimite o poză obișnuită.");
    return;
  }

  let extras;
  try {
    const info = await telegram(env, "getFile", { file_id: fisier.file_id });
    const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${info.result.file_path}`);
    extras = await extrageDinPoza(env, new Uint8Array(await r.arrayBuffer()), mime);
  } catch (e) {
    console.error(e);
    await trimite(env, chatId, "Nu am putut citi poza (sau limita gratuită Gemini a fost atinsă). Încearcă o poză mai clară sau mai târziu.");
    return;
  }

  if (!extras.este_proces_verbal) {
    await trimite(env, chatId, `Nu pare a fi un proces-verbal (am recunoscut: ${extras.tip_document || "alt document"}). ` +
      "Trimite o poză clară cu tot procesul-verbal.");
    return;
  }

  let raspuns;
  try {
    raspuns = await analizeazaPV(env, extras, relatare, false);
  } catch (e) {
    console.error(e);
    await trimite(env, chatId, "Am citit procesul-verbal, dar analiza nu a mers (posibil limita gratuită Gemini). Scrie /detalii mai târziu.");
    raspuns = "(analiza nu a reușit)";
  }
  if (raspuns !== "(analiza nu a reușit)") {
    await trimite(env, chatId, `${raspuns}\n\n${relatare ? "" : "Scrie-mi ce s-a întâmplat de fapt, ca să compar cu procesul-verbal.\n"}Mai multe: /detalii`);
  }

  // Salvăm datele extrase (nu poza), ca /detalii și întrebările următoare să le poată folosi.
  const acum = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO istoric VALUES (?, 'user', ?, ?)")
      .bind(chatId, MARCAJ_PV + JSON.stringify({ extras, relatare }), acum),
    env.DB.prepare("INSERT INTO istoric VALUES (?, 'model', ?, ?)").bind(chatId, raspuns, acum + 1),
  ]);
}

async function extrageDinPoza(env, bytes, mime) {
  const json = await gemini(env, [{
    role: "user",
    parts: [{ inlineData: { mimeType: mime, data: base64(bytes) } }, { text: "Extrage datele din acest document." }],
  }], SISTEM_EXTRAGERE, 4096, { responseMimeType: "application/json" });
  return JSON.parse(json);
}

async function analizeazaPV(env, extras, relatare, detaliat) {
  // Articolele invocate în proces-verbal + regulile despre procesul-verbal din Codul contravențional.
  const refs = (extras.articole_invocate || []).map((a) => ({ nr: String(a.nr).replace(/\D/g, ""), act: a.act || "contraventional" }));
  const invocate = await articoleDirecte(env, refs.filter((r) => r.nr));
  const procedura = await articoleDirecte(env, ["443", "445", "448", "384", "34"].map((nr) => ({ nr, act: "contraventional" })));
  const altele = (await cautaLegi(env, `${extras.fapta_descrisa || ""} ${relatare}`, "")).slice(0, 4);

  const unice = new Map();
  for (const b of [...invocate, ...procedura, ...altele]) unice.set(b.id, b);
  const context = [...unice.values()].map((b) => `${b.lege} — ${b.articol}\n${b.text}`).join("\n\n").slice(0, 60000);

  const text = `ARTICOLE DE LEGE:\n\n${context}\n\nPROCES-VERBAL (extras din poză):\n${JSON.stringify(extras, null, 1)}\n\n` +
    `CE SPUNE UTILIZATORUL CĂ S-A ÎNTÂMPLAT:\n${relatare || "(nu a scris nimic)"}`;
  return gemini(env, [{ role: "user", parts: [{ text }] }],
    SISTEM_PV + (detaliat ? FORMAT_PV_DETALIAT : FORMAT_PV_SCURT), detaliat ? 4096 : 2048);
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function citesteIstoric(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT rol, text FROM istoric WHERE chat_id = ? ORDER BY ts DESC LIMIT 6",
  ).bind(chatId).all();
  return results.reverse();
}

function faraDiacritice(s) {
  return s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}

function termeni(text) {
  const out = new Set();
  for (let w of faraDiacritice(text).match(/[a-z]+/g) || []) {
    if (w.length < 3 || CUVINTE_GOALE.has(w) || ["and", "not", "near"].includes(w)) continue;
    const cheie = Object.keys(SINONIME).find((k) => w.startsWith(k));
    const extra = cheie && SINONIME[cheie];
    for (const x of [w, ...(extra ? extra.split(" ") : [])]) {
      // Rădăcină simplă: primele 6 litere (sau 5 pentru cuvinte scurte) + căutare după prefix.
      out.add(x.length > 6 ? x.slice(0, 6) : x.length > 4 ? x.slice(0, 5) : x);
    }
  }
  return [...out];
}

// Recunoaște „art. 228 din codul contravențional”, „articolul 25 legea politiei” etc.
// „10/1”, „10^1” sau „10 1” devin „10¹”, ca în textul legii.
const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
function normSup(text) {
  return text.replace(/(\d+)\s*[\/^]\s*(\d+)/g, (m, a, b) => a + [...b].map((c) => SUP[c]).join(""));
}

function referinte(text) {
  const t = faraDiacritice(normSup(text));
  const ref = [];
  for (const m of t.matchAll(/art(?:icolul|\.)?\s*(\d+[¹²³⁴⁵⁶⁷⁸⁹]*)(?:\s*(?:alin[^\s]*\s*\(?\d+\)?)?)?\s*(?:din\s+)?([a-z ]{0,40})/g)) {
    ref.push({ nr: m[1], act: m[2] });
  }
  return ref;
}

const ACTE = [
  ["contrav", "contravențional"],
  ["procedura penal", "procedură penală"],
  ["procedura civil", "procedură civilă"],
  ["penal", "Codul penal"],
  ["civil", "Codul civil"],
  ["munc", "muncii"],
  ["constit", "Constituția"],
  ["politi", "Poliției"],
  ["administrativ", "administrativ"],
  ["trafic", "traficului"],
  ["fiscal", "fiscal"],
  ["familie", "familiei"],
  ["avocat", "avocatur"],
  ["consumator", "consumatorilor"],
];

async function articoleDirecte(env, refs) {
  const rez = [];
  for (const { nr, act } of refs.slice(0, 3)) {
    const potrivire = ACTE.find(([cheie]) => faraDiacritice(act || "").includes(cheie));
    const stmt = potrivire
      ? env.DB.prepare("SELECT * FROM bucati WHERE articol = ? AND lege LIKE ? LIMIT 2").bind(`Articolul ${nr}`, `%${potrivire[1]}%`)
      : env.DB.prepare("SELECT * FROM bucati WHERE articol = ? LIMIT 4").bind(`Articolul ${nr}`);
    rez.push(...(await stmt.all()).results);
  }
  return rez;
}

async function cautaLegi(env, intrebare, intrebareAnterioara) {
  const directe = await articoleDirecte(env, referinte(intrebare));
  if (/noapt|nopti|diminea|seara|\bora\b|\d{1,2}[:.]\d{2}/.test(faraDiacritice(intrebare))) {
    // Legea spune „timpul nopții”; definiția (22:00-6:00) e în art. 6 pct. 49) CPP.
    const { results } = await env.DB.prepare(
      "SELECT * FROM bucati WHERE articol = 'Articolul 6' AND lege LIKE '%procedură penală%' AND text LIKE '%timpul nop%'",
    ).all();
    directe.push(...results);
  }

  const t = termeni(intrebare);
  const tAnterior = termeni(intrebareAnterioara).filter((x) => !t.includes(x)).slice(0, 4);
  const interogari = [t, t.length < 4 ? [...t, ...tAnterior] : null].filter((x) => x?.length);

  // Actele pomenite în întrebare („polițist”, „contravenție”) primesc un mic bonus.
  const intrebareFd = faraDiacritice(intrebare);
  const acteVizate = ACTE.filter(([cheie]) => intrebareFd.includes(cheie)).map(([, nume]) => faraDiacritice(nume));

  // Cât de rar e fiecare termen: „percheziție” apare în puține articole, „penal” în mii.
  // Cuvintele rare decid ce articole sunt relevante.
  const totiTermenii = [...new Set(interogari.flat())];
  const numarari = await env.DB.batch(
    totiTermenii.map((x) => env.DB.prepare("SELECT count(*) n FROM fts WHERE fts MATCH ?").bind(`${x}*`)),
  );
  const N = 6417;
  const idf = Object.fromEntries(totiTermenii.map((x, i) => {
    const df = numarari[i].results[0].n;
    return [x, df ? Math.log(1 + N / df) : 0];
  }));

  const scor = new Map();
  const bucati = new Map();
  const ia = async (fts, limita) => (await env.DB.prepare(
    `SELECT b.id, b.lege, b.sursa, b.articol, b.titlu, b.text FROM fts JOIN bucati b ON b.id = fts.rowid
     WHERE fts MATCH ? ORDER BY bm25(fts, 1.0, 8.0, 1.0) LIMIT ${limita}`,
  ).bind(fts).all()).results;

  for (const termeniQ of interogari) {
    const utili = termeniQ.filter((x) => idf[x] > 0);
    if (!utili.length) continue;
    const rari = [...utili].sort((a, b) => idf[b] - idf[a]).slice(0, 3);
    const candidati = [
      ...(await ia(utili.map((x) => `${x}*`).join(" OR "), 60)),
      // Articolele al căror titlu conține cuvintele cele mai rare (ex. „percheziție” -> art. 125-132 CPP).
      ...(await ia(`titlu : (${rari.map((x) => `${x}*`).join(" OR ")})`, 30)),
      // Articolele care conțin împreună cele mai rare două cuvinte.
      ...(rari.length >= 2 ? await ia(rari.slice(0, 2).map((x) => `${x}*`).join(" AND "), 30) : []),
    ];
    const total = utili.reduce((s, x) => s + idf[x], 0);
    for (const b of candidati) {
      if (bucati.has(b.id)) continue;
      const titlu = " " + faraDiacritice(b.titlu || "").replace(/[^a-z0-9]+/g, " ");
      const corp = " " + faraDiacritice(b.text).replace(/[^a-z0-9]+/g, " ");
      let acoperire = 0;
      for (const x of utili) {
        if (titlu.includes(" " + x)) acoperire += 1.5 * idf[x];
        else if (corp.includes(" " + x)) acoperire += idf[x];
      }
      const bonusAct = acteVizate.some((a) => faraDiacritice(b.lege).includes(a)) ? 0.25 : 0;
      bucati.set(b.id, b);
      scor.set(b.id, acoperire / total + bonusAct);
    }
  }
  const gasite = [...scor.keys()].sort((a, b) => scor.get(b) - scor.get(a)).slice(0, 14).map((id) => bucati.get(id));

  const unice = new Map();
  for (const b of [...directe, ...gasite]) unice.set(b.id, b);
  // ~40k caractere de context: suficient pentru ~10-12 articole, încape ușor în Gemini.
  const ales = [];
  let total = 0;
  for (const b of unice.values()) {
    if (total + b.text.length > 40000) break;
    ales.push(b);
    total += b.text.length;
  }
  return ales;
}

async function gemini(env, contents, sistem, maxTokeni, configExtra = {}) {
  const modele = (env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite").split(",").map((s) => s.trim());
  let ultimaEroare;
  for (const model of modele) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistem }] },
        contents,
        // thinkingBudget mic: altfel „gândirea” modelului consumă din maxOutputTokens și răspunsul iese tăiat.
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokeni, thinkingConfig: { thinkingBudget: 512 }, ...configExtra },
      }),
    });
    if (r.ok) {
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (text) return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "");
      ultimaEroare = new Error(`${model}: răspuns gol ${JSON.stringify(j).slice(0, 300)}`);
    } else {
      ultimaEroare = new Error(`${model}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
    console.warn(String(ultimaEroare));
  }
  throw ultimaEroare;
}

async function telegram(env, metoda, date) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${metoda}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(date),
  });
  return r.json();
}

async function trimite(env, chatId, text) {
  // Telegram acceptă maxim 4096 caractere pe mesaj.
  for (let i = 0; i < text.length; i += 4000) {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + 4000),
      link_preview_options: { is_disabled: true },
    });
  }
}
