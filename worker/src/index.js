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
Reguli:
- Răspunde în limba în care a fost pusă întrebarea (română sau rusă), simplu și practic.
- Pentru fiecare afirmație citează exact sursa: „art. X din <actul>” (de ex. „art. 25 alin. (2) din Legea nr. 320/2012”).
- Structura: 1) Pe scurt (2-3 propoziții), 2) Ce spune legea (articolele relevante, cu citate scurte), 3) Ce poți face concret (pași), 4) Sancțiuni / termene, dacă există.
- Dacă fragmentele nu acoperă întrebarea, spune clar ce lipsește și ce act normativ ar trebui verificat. NU inventa articole, numere sau sume.
- Fără formatare Markdown (fără **, #, tabele); folosește doar text simplu, liniuțe și numerotare.
- Încheie cu o propoziție scurtă: informația nu înlocuiește consultația unui avocat.`;

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
    return new Response("Bot legi Moldova — activ.");
  },
};

async function proceseaza(update, env) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const permisi = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (permisi.length && !permisi.includes(String(msg.from?.id))) {
    await trimite(env, chatId, `Acces restricționat. ID-ul tău Telegram: ${msg.from?.id}`);
    return;
  }

  if (text === "/start" || text === "/help") {
    await trimite(env, chatId,
      "Salut! Descrie situația ta (ex: „Polițistul îmi cere să deschid portbagajul fără motiv, sunt obligat?”) " +
      "și îți răspund pe baza Constituției și legilor Republicii Moldova, cu articolele exacte.\n\n" +
      "Comenzi:\n/nou – începe o conversație nouă\n/legi – lista actelor din bază\n/art 228 contraventional – textul unui articol");
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
  const cmdArt = text.match(/^\/art\s+(\d+)\s*(.*)$/i);
  if (cmdArt) {
    const rez = await articoleDirecte(env, [{ nr: cmdArt[1], act: cmdArt[2] }]);
    await trimite(env, chatId, rez.length
      ? rez.slice(0, 3).map((b) => `${b.lege} — ${b.articol}\n\n${b.text}`).join("\n\n———\n\n")
      : "Nu am găsit articolul. Exemplu: /art 228 contraventional");
    return;
  }

  await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  const istoric = await citesteIstoric(env, chatId);
  // Căutăm și după ultima întrebare, ca întrebările de tip „și dacă refuz?” să păstreze contextul.
  const ultimaIntrebare = istoric.filter((m) => m.rol === "user").at(-1)?.text || "";
  const fragmente = await cautaLegi(env, text, ultimaIntrebare);

  const context = fragmente
    .map((b, i) => `[${i + 1}] ${b.lege} — ${b.articol}\n${b.text}`)
    .join("\n\n");
  const continut = [
    ...istoric.map((m) => ({ role: m.rol === "user" ? "user" : "model", parts: [{ text: m.text }] })),
    {
      role: "user",
      parts: [{ text: `FRAGMENTE DE LEGE GĂSITE:\n\n${context || "(niciun fragment găsit)"}\n\nÎNTREBAREA MEA:\n${text}` }],
    },
  ];

  let raspuns;
  try {
    raspuns = await gemini(env, continut);
  } catch (e) {
    console.error(e);
    await trimite(env, chatId, "Serviciul AI nu răspunde acum (posibil limita gratuită zilnică Gemini a fost atinsă). Încearcă mai târziu.");
    return;
  }

  const surse = [...new Map(fragmente.slice(0, 6).map((b) => [b.lege + b.articol, b])).values()]
    .map((b) => `• ${b.articol}, ${b.lege}`)
    .join("\n");
  await trimite(env, chatId, `${raspuns}\n\nArticole consultate:\n${surse}`);

  const acum = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO istoric VALUES (?, 'user', ?, ?)").bind(chatId, text, acum),
    env.DB.prepare("INSERT INTO istoric VALUES (?, 'model', ?, ?)").bind(chatId, raspuns, acum + 1),
    env.DB.prepare(
      "DELETE FROM istoric WHERE chat_id = ? AND ts NOT IN (SELECT ts FROM istoric WHERE chat_id = ? ORDER BY ts DESC LIMIT 6)",
    ).bind(chatId, chatId),
  ]);
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
function referinte(text) {
  const t = faraDiacritice(text);
  const ref = [];
  for (const m of t.matchAll(/art(?:icolul|\.)?\s*(\d+)(?:\s*(?:alin[^\s]*\s*\(?\d+\)?)?)?\s*(?:din\s+)?([a-z ]{0,40})/g)) {
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

  const t = termeni(intrebare);
  const tAnterior = termeni(intrebareAnterioara).filter((x) => !t.includes(x)).slice(0, 4);
  const interogari = [t, t.length < 4 ? [...t, ...tAnterior] : null].filter((x) => x?.length);

  // Actele pomenite în întrebare („polițist”, „contravenție”) primesc un mic bonus.
  const intrebareFd = faraDiacritice(intrebare);
  const acteVizate = ACTE.filter(([cheie]) => intrebareFd.includes(cheie)).map(([, nume]) => faraDiacritice(nume));

  const scor = new Map();
  const bucati = new Map();
  for (const termeniQ of interogari) {
    const fts = termeniQ.map((x) => `${x}*`).join(" OR ");
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.lege, b.sursa, b.articol, b.text FROM fts JOIN bucati b ON b.id = fts.rowid
       WHERE fts MATCH ? ORDER BY bm25(fts, 2.0, 1.0, 1.0) LIMIT 80`,
    ).bind(fts).all();
    // BM25 cu OR favorizează articolele lungi care repetă un singur cuvânt; re-ordonăm
    // după câți termeni diferiți din întrebare apar în articol (mai ales în titlul lui).
    results.forEach((b, rang) => {
      const corp = " " + faraDiacritice(b.text).replace(/[^a-z0-9]+/g, " ");
      const titlu = corp.slice(0, 200);
      let acoperire = 0;
      for (const x of termeniQ) {
        if (titlu.includes(" " + x)) acoperire += 2;
        else if (corp.includes(" " + x)) acoperire += 1;
      }
      const bonusAct = acteVizate.some((a) => faraDiacritice(b.lege).includes(a)) ? 1.5 : 0;
      bucati.set(b.id, b);
      scor.set(b.id, Math.max(scor.get(b.id) || 0, acoperire + bonusAct + 3 / (rang + 3)));
    });
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

async function gemini(env, contents) {
  const modele = (env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite").split(",").map((s) => s.trim());
  let ultimaEroare;
  for (const model of modele) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SISTEM }] },
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
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
