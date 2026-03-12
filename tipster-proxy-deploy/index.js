const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

const LIVE_PROMPT = `Eres un tipster profesional de fútbol especializado en análisis en vivo.
Emite recomendación SOLO si AL MENOS 2-3 indicadores apuntan en la misma dirección.

CRITERIOS:
- xG >1.0 sin gol = presión muy alta
- Remates a puerta >5 = dominio real
- Ataques peligrosos >65% = dominio claro
- Faltas >12 antes del 70' = ritmo agresivo
- 3 amarillas antes del 60' = partido caliente
- xG combinado <0.5 tras 45min = partido cerrado
- xG combinado >2.0 antes del 70' = over

Si no hay señal clara responde EXACTAMENTE: SIN_SEÑAL

Si hay señal usa este formato:
🟢 [MERCADO] — [SELECCIÓN] | Min. X'
📌 [2-3 indicadores concretos]
Confianza: ⭐⭐⭐☆☆

Máximo 2 recomendaciones. También puedes usar:
🔴 EVITAR: [MERCADO] — [motivo breve]`;

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── API-Football proxy ────────────────────────────────────────────────────────
app.get("/api/*", async (req, res) => {
  const path = req.path.replace("/api", "");
  const query = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
  try {
    const response = await fetch(`${API_FOOTBALL_BASE}${path}${query}`, {
      headers: { "x-apisports-key": FOOTBALL_API_KEY },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gemini AI analysis ────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { home, away, score, minute, stats } = req.body;

  const statsText = Object.entries(stats)
    .filter(([, v]) => v.home !== null || v.away !== null)
    .map(([k, v]) => `  ${k}: Local=${v.home ?? "N/D"} | Visitante=${v.away ?? "N/D"}`)
    .join("\n");

  const prompt = `${LIVE_PROMPT}

PARTIDO: ${home} vs ${away}
Marcador: ${score} | Minuto: ${minute}'

ESTADÍSTICAS EN VIVO:
${statsText}

Analiza y responde.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
      }),
    });
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "SIN_SEÑAL";
    res.json({ result: text === "SIN_SEÑAL" ? null : text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
