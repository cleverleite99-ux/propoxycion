const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const SCRAPER_URL        = process.env.SCRAPER_URL;
const JSON_URL           = process.env.JSON_URL;
const BRAIN_URL          = process.env.BRAIN_URL;
const FIREBASE_PROJECT   = process.env.FIREBASE_PROJECT_ID;       // ej: tipsterai-xxxxx
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;  // del JSON de cuenta de servicio
const FIREBASE_PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// Tokens FCM registrados
const fcmTokens = new Set();

// Brain cache
let brainCache = null, brainCacheTs = 0;
const BRAIN_TTL = 5 * 60 * 1000;

// ── OAuth2 token para FCM V1 ──────────────────────────────────────────────────
let _oauthToken = null, _oauthExpiry = 0;

async function getFCMToken() {
  if (_oauthToken && Date.now() < _oauthExpiry - 60000) return _oauthToken;

  // JWT manual sin librerías externas
  const { createSign } = require("crypto");

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(FIREBASE_PRIVATE_KEY, "base64url");
  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth error: ${JSON.stringify(data)}`);
  _oauthToken = data.access_token;
  _oauthExpiry = Date.now() + (data.expires_in * 1000);
  console.log("[fcm] Token OAuth2 renovado");
  return _oauthToken;
}

// ── Enviar notificación FCM V1 ────────────────────────────────────────────────
async function sendFCMNotification(token, title, body, data = {}) {
  const accessToken = await getFCMToken();
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT}/messages:send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          android: {
            priority: "high",
            notification: { channel_id: "tipster_tips", sound: "default" },
          },
        },
      }),
    }
  );
  return res.json();
}

const DEFAULT_PREMATCH = `Eres un tipster profesional de fútbol. Recibirás datos prepartido (Poisson, value, medias históricas) y estadísticas en vivo. Cruza ambos bloques para emitir recomendaciones.

CRITERIOS:
- VALUE positivo = hay valor real frente a la cuota de casa
- GOLES_TOTAL prepartido + xG en vivo = imagen completa de goles esperados
- ARBITRO_AMARILLAS >4.5 = árbitro muy tarjetero
- TEN HOME/AWAY refleja forma reciente
- Si el live contradice la predicción base, avisa y baja la confianza

REGLAS:
- Máximo 3 recomendaciones
- Solo cuando hay valor claro

FORMATO:
🟢 [MERCADO] — [SELECCIÓN]
📌 [dato prepartido + confirmación live]
Confianza: ⭐⭐⭐⭐☆

🔴 EVITAR: [MERCADO] — [motivo]

⚪ Sin apuesta recomendada.
📌 [motivo breve]`;

const DEFAULT_LIVE = `Eres un tipster profesional de fútbol especializado en análisis en vivo.
Emite recomendación SOLO si AL MENOS 2-3 indicadores apuntan en la misma dirección.

CRITERIOS:
- xG >1.0 sin gol = presión muy alta
- Remates a puerta >5 = dominio real
- Ataques peligrosos >65% = dominio claro
- Faltas >12 antes del 70' = ritmo agresivo
- 3 amarillas antes del 60' = partido caliente
- xG combinado <0.5 tras 45min = partido cerrado
- xG combinado >2.0 antes del 70' = over

Si no hay señal: SIN_SEÑAL

Si hay señal:
🟢 [MERCADO] — [SELECCIÓN] | Min. X'
📌 [2-3 indicadores concretos]
Confianza: ⭐⭐⭐☆☆`;

async function getBrain() {
  if (!BRAIN_URL) return { prematch_prompt: DEFAULT_PREMATCH, live_prompt: DEFAULT_LIVE };
  if (brainCache && Date.now() - brainCacheTs < BRAIN_TTL) return brainCache;
  try {
    const res = await fetch(`${BRAIN_URL}?nc=${Date.now()}`);
    brainCache = await res.json();
    brainCacheTs = Date.now();
    return brainCache;
  } catch { return { prematch_prompt: DEFAULT_PREMATCH, live_prompt: DEFAULT_LIVE }; }
}

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── POST /register-token ──────────────────────────────────────────────────────
app.post("/register-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Falta token" });
  fcmTokens.add(token);
  console.log(`[fcm] Token registrado. Total: ${fcmTokens.size}`);
  res.json({ ok: true });
});

// ── POST /notify ──────────────────────────────────────────────────────────────
app.post("/notify", async (req, res) => {
  const { title, body, data } = req.body;
  if (!FIREBASE_PROJECT || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return res.status(503).json({ error: "Firebase no configurado en variables de entorno" });
  }
  if (fcmTokens.size === 0) return res.json({ ok: true, sent: 0, msg: "Sin tokens" });

  const tokens = Array.from(fcmTokens);
  let sent = 0, failed = 0;

  for (const token of tokens) {
    try {
      const result = await sendFCMNotification(token, title, body, data || {});
      if (result.name) {
        sent++;
      } else if (result.error?.code === 404 || result.error?.status === "UNREGISTERED") {
        fcmTokens.delete(token);
        failed++;
      } else {
        failed++;
        console.warn("[fcm] Error token:", result.error?.message);
      }
    } catch (e) {
      failed++;
      console.error("[fcm] Error:", e.message);
    }
  }

  console.log(`[fcm] Enviado: ${sent} ok / ${failed} fail`);
  res.json({ ok: true, sent, failed });
});

// ── GET /matches ──────────────────────────────────────────────────────────────
app.get("/matches", async (req, res) => {
  if (!JSON_URL) return res.status(503).json({ error: "JSON_URL no configurado" });
  try {
    const r = await fetch(`${JSON_URL}?nc=${Date.now()}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /live?url= ────────────────────────────────────────────────────────────
app.get("/live", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta ?url=" });
  if (!SCRAPER_URL) return res.status(503).json({ error: "SCRAPER_URL no configurado" });
  try {
    const r = await fetch(`${SCRAPER_URL}/scrape?url=${encodeURIComponent(url)}`, {
      timeout: 25000,
      headers: { "ngrok-skip-browser-warning": "true" }
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: `Scraper no disponible: ${e.message}` }); }
});

// ── POST /analyze ─────────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { home, away, score, minute, stats, prematch } = req.body;
  const brain = await getBrain();
  const safe = v => (!v || v === "#N/D") ? "N/D" : v;

  const statsText = Object.entries(stats || {})
    .filter(([, v]) => v.home !== null || v.away !== null)
    .map(([k, v]) => `  ${k}: Local=${v.home ?? "N/D"} | Visitante=${v.away ?? "N/D"}`)
    .join("\n");

  let prompt;
  if (prematch) {
    const pre = `--- DATOS PREPARTIDO ---
Liga: ${safe(prematch.liga)} | Árbitro: ${safe(prematch.ARBITRO)}
Goles esperados: Local ${safe(prematch["GOLES HOME"])} | Visitante ${safe(prematch["GOLES AWAY"])} | Total ${safe(prematch["GOLES TOTAL"])}
Tiros: Local ${safe(prematch["TIROS HOME"])} | Visitante ${safe(prematch["TIROS AWAY"])}
Tendencia (TEN): Local ${safe(prematch["TEN HOME"])} | Visitante ${safe(prematch["TEN AWAY"])}
Amarillas: Local ${safe(prematch["AMARILLAS HOME"])} | Visitante ${safe(prematch["AMARILLAS AWAY"])} | Total ${safe(prematch["AMARILLAS TOTAL"])}
Árbitro amarillas/partido: ${safe(prematch["ARBITRO AMARILLAS"])}
Córners esperados: ${safe(prematch["CORNERS"])}
Cuotas → 1: ${safe(prematch["1"])} | X: ${safe(prematch["X"])} | 2: ${safe(prematch["2"])} | Over2.5: ${safe(prematch["+2.5"])} | Under2.5: ${safe(prematch["-2.5"])}
Value → 1: ${safe(prematch["VALUE_1"])} | X: ${safe(prematch["VALUE_X"])} | 2: ${safe(prematch["VALUE_2"])} | Over2.5: ${safe(prematch["VALUE_OVER25"])} | Under2.5: ${safe(prematch["VALUE_UNDER25"])}
Recomendación sistema: ${safe(prematch["RECOMENDACION"])}`;
    prompt = `${brain.prematch_prompt}\n\nPARTIDO: ${home} vs ${away}\n${pre}\n\n--- ESTADÍSTICAS EN VIVO ---\nMarcador: ${score} | Minuto: ${minute}'\n${statsText}\n\nCruza ambos bloques y dame tus recomendaciones.`;
  } else {
    prompt = `${brain.live_prompt}\n\nPARTIDO: ${home} vs ${away}\nMarcador: ${score} | Minuto: ${minute}'\n\nESTADÍSTICAS EN VIVO:\n${statsText}\n\nAnaliza y responde.`;
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  try {
    const r = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
      }),
    });
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "SIN_SEÑAL";
    res.json({ result: text === "SIN_SEÑAL" ? null : text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/brain", async (req, res) => res.json(await getBrain()));
app.get("/health", (_, res) => res.json({ status: "ok", tokens: fcmTokens.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
