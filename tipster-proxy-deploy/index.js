const express = require("express");
const fetch = require("node-fetch");

const app = express();
const API_KEY = "931a681baa0d020688d7d87d040e667a";
const API_BASE = "https://v3.football.api-sports.io";

// Allow requests from anywhere (the Android app)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Proxy every request: /api/fixtures?live=all → API-Football
app.get("/api/*", async (req, res) => {
  const endpoint = req.path.replace("/api", "") + (req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "");
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: { "x-apisports-key": API_KEY },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
