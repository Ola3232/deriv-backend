import express from "express";
import cors from "cors";
import axios from "axios";
import WebSocket from "ws";
import {
  initDB,
  addAlert,
  getAlerts,
  deleteAlert,
  markAlertFired,
  saveToken,
  getTokens,
} from "./database.js";

/* ============================================================
   SETUP EXPRESS
============================================================ */
const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

/* ============================================================
   ÉTAT EN MÉMOIRE
============================================================ */
const subscribedSymbols = new Set();
const lastPrices        = {};
let   activeSymbols     = [];
let   ws                = null;
let   symbolsLoaded     = false;

/* ============================================================
   PUSH EXPO — avec channelId Android + priorité max
============================================================ */
async function sendPush(title, body, data = {}) {
  const tokens = await getTokens();
  if (!tokens.length) {
    console.warn("⚠️  Aucun token enregistré — push ignoré");
    return;
  }

  // Envoyer un par un pour éviter les erreurs de format tableau
  for (const t of tokens) {
    try {
      const message = {
        to:        t.token,
        sound:     "default",
        title,
        body,
        data,
        priority:  "high",
        channelId: "deriv-alerts",
        badge:     1,
      };

      console.log(`📤 Envoi push à : ${t.token.slice(0, 30)}...`);

      const res = await axios.post(
        "https://exp.host/--/api/v2/push/send",
        message,
        {
          headers: {
            "Content-Type": "application/json",
            "Accept":       "application/json",
          },
        }
      );

      // Expo retourne soit { status, id } soit { data: { status, id } }
      const ticket = res.data?.data ?? res.data;
      console.log(`📬 Réponse Expo complète:`, JSON.stringify(res.data));
      if (ticket.status === "error") {
        console.error(`❌ Push ticket error:`, ticket.message, ticket.details);
      } else {
        console.log(`✅ Push envoyé ! status: ${ticket.status} id: ${ticket.id}`);
      }
    } catch (err) {
      console.error(`❌ Push HTTP error pour ${t.token.slice(0, 20)}: ${err.message}`);
      if (err.response) {
        console.error(`   Response: ${JSON.stringify(err.response.data)}`);
      }
    }
  }
}

/* ============================================================
   CHARGEMENT active_symbols
============================================================ */
function loadActiveSymbols() {
  console.log("📋 Chargement active_symbols...");

  const wsSymbols = new WebSocket(
    "wss://ws.derivws.com/websockets/v3?app_id=1089"
  );

  const timeout = setTimeout(() => {
    console.warn("⏱ Timeout active_symbols — retry dans 30s");
    try { wsSymbols.terminate(); } catch {}
    setTimeout(loadActiveSymbols, 30000);
  }, 15000);

  wsSymbols.on("open", () => {
    wsSymbols.send(
      JSON.stringify({ active_symbols: "brief", product_type: "basic" })
    );
  });

  wsSymbols.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.active_symbols) return;

    clearTimeout(timeout);

    activeSymbols = msg.active_symbols
      .filter((s) => s.symbol && s.display_name)
      .map((s) => ({
        symbol:         s.symbol,
        display_name:   s.display_name,
        market:         s.market        || "",
        market_name:    s.market_display_name    || s.market || "Other",
        submarket:      s.submarket     || "",
        submarket_name: s.submarket_display_name || "",
        is_open:        s.exchange_is_open === 1,
      }));

    symbolsLoaded = true;
    console.log(`✅ ${activeSymbols.length} actifs chargés`);

    try { wsSymbols.close(); } catch {}
    setTimeout(loadActiveSymbols, 5 * 60 * 1000);
  });

  wsSymbols.on("error", (err) => {
    clearTimeout(timeout);
    console.error("❌ WS symbols error:", err.message);
    setTimeout(loadActiveSymbols, 15000);
  });

  wsSymbols.on("close", () => {
    clearTimeout(timeout);
  });
}

/* ============================================================
   CONNEXION DERIV WS — ticks + déclenchement alertes
============================================================ */
function connectDeriv() {
  console.log("🔌 Connexion Deriv WS ticks...");
  ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  ws.on("open", () => {
    console.log("✅ Connecté Deriv ticks");
    for (const symbol of subscribedSymbols) {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    }
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.tick) return;

    const { quote: price, symbol } = msg.tick;
    lastPrices[symbol] = price;

    let alerts;
    try { alerts = await getAlerts("%"); } catch { return; }

    for (const alert of alerts) {
      if (alert.asset !== symbol) continue;
      if (alert.fired === 1)      continue;

      const triggered =
        (alert.condition === "over"  && price >= alert.price) ||
        (alert.condition === "under" && price <= alert.price);

      if (!triggered) continue;

      // Marquer fired AVANT d'envoyer pour éviter les doublons
      try { await markAlertFired(alert.id); } catch { continue; }

      const dir  = alert.condition === "over" ? "au-dessus ↑" : "en-dessous ↓";
      const body = `${symbol} passé ${dir} de ${alert.price}\nPrix actuel : ${price.toFixed(4)}`;
      const title = "📈 Alerte Deriv déclenchée !";

      console.log(`🔔 [ALERT #${alert.id}] ${body}`);

      await sendPush(title, body, {
        alertId:   alert.id,
        symbol,
        price,
        threshold: alert.price,
        condition: alert.condition,
      });
    }
  });

  ws.on("close", (code) => {
    console.log(`🔄 WS ticks fermé (${code}) — reconnexion dans 5s`);
    ws = null;
    setTimeout(connectDeriv, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ WS ticks error:", err.message);
  });
}

function subscribeSymbol(symbol) {
  if (subscribedSymbols.has(symbol)) return;
  subscribedSymbols.add(symbol);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    console.log(`📡 Abonné à ${symbol}`);
  }
}

/* ============================================================
   ROUTES
============================================================ */
app.get("/", (req, res) => {
  res.json({
    status:         "ok",
    uptime:         Math.floor(process.uptime()),
    symbols_loaded: symbolsLoaded,
    symbols_count:  activeSymbols.length,
    subscriptions:  [...subscribedSymbols],
  });
});

app.get("/symbols", (req, res) => {
  if (!symbolsLoaded || activeSymbols.length === 0) {
    return res.status(503).json({
      error:   "loading",
      message: "Les actifs sont en cours de chargement. Réessaie dans 5 secondes.",
    });
  }

  const q       = (req.query.q || "").toLowerCase().trim();
  const symbols = q
    ? activeSymbols.filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          s.display_name.toLowerCase().includes(q) ||
          s.market_name.toLowerCase().includes(q)
      )
    : activeSymbols;

  const grouped = {};
  for (const s of symbols) {
    const key = s.market_name || "Autres";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s);
  }

  res.json({ total: symbols.length, markets: grouped });
});

app.get("/alerts", async (req, res) => {
  try {
    res.json(await getAlerts("%"));
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

app.post("/alerts", async (req, res) => {
  const { asset, condition, price } = req.body;

  if (!asset || typeof asset !== "string")
    return res.status(400).json({ error: "Actif invalide" });
  if (!["over", "under"].includes(condition))
    return res.status(400).json({ error: "Condition invalide" });
  if (price == null || isNaN(Number(price)) || Number(price) <= 0)
    return res.status(400).json({ error: "Prix invalide" });

  const numPrice = Number(price);
  subscribeSymbol(asset);

  const currentPrice = lastPrices[asset];
  if (currentPrice != null) {
    const already =
      (condition === "over"  && currentPrice >= numPrice) ||
      (condition === "under" && currentPrice <= numPrice);
    if (already) {
      const dir = condition === "over" ? "au-dessus" : "en-dessous";
      return res.status(409).json({
        error:        "already_triggered",
        message:      `Prix actuel de ${asset} (${currentPrice}) déjà ${dir} de ${numPrice}.`,
        currentPrice,
      });
    }
  }

  try {
    const newAlert = await addAlert({ user: "default", asset, condition, price: numPrice });
    res.status(201).json(newAlert);
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

app.delete("/alerts/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });
  try {
    await deleteAlert(id);
    res.json({ deleted: true, id });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

app.post("/save-token", async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string")
    return res.status(400).json({ error: "Token invalide" });
  try {
    await saveToken("default", token);
    console.log(`📲 Token sauvegardé : ${token.slice(0, 30)}...`);
    res.json({ saved: true });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

app.get("/price/:symbol", (req, res) => {
  const price = lastPrices[req.params.symbol];
  if (price == null)
    return res.status(404).json({ error: "Prix non disponible" });
  res.json({ symbol: req.params.symbol, price });
});

// Vider tous les tokens
app.delete("/tokens/all", async (req, res) => {
  try {
    const { Pool } = (await import("pg"));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query("DELETE FROM tokens");
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug : voir les tokens enregistrés
app.get("/tokens", async (req, res) => {
  try {
    const tokens = await getTokens();
    res.json({ count: tokens.length, tokens: tokens.map(t => ({ id: t.id, user: t.user, token: t.token.slice(0, 20) + "..." })) });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// Test push manuel : GET /test-push
app.get("/test-push", async (req, res) => {
  await sendPush(
    "🧪 Test Deriv Alert",
    "Ceci est une notification de test. Le son et la vibration fonctionnent !",
    { test: true }
  );
  res.json({ sent: true });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route inconnue : ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error("❌ Express error:", err);
  res.status(500).json({ error: "Erreur interne du serveur" });
});

/* ============================================================
   DÉMARRAGE
============================================================ */
async function start() {
  await initDB();

  const existing = await getAlerts("%");
  for (const a of existing) {
    if (a.fired !== 1) subscribedSymbols.add(a.asset);
  }
  console.log(`📋 ${existing.length} alerte(s) en DB`);

  connectDeriv();
  loadActiveSymbols();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
}

start().catch((err) => {
  console.error("❌ Erreur démarrage:", err);
  process.exit(1);
});
