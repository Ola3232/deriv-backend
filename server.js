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
  resetAlertForCooldown,
  deleteOldFiredAlerts,
  saveToken,
  getTokens,
} from "./database.js";

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

// Cooldown 2h en mémoire : alertId → timestamp dernier envoi
const cooldownMap = new Map();
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 heures

/* ============================================================
   PUSH EXPO
============================================================ */
async function sendPush(title, body, data = {}, targetUser = null) {
  const allTokens = await getTokens();
  const tokens = targetUser
    ? allTokens.filter(t => t.user === targetUser)
    : allTokens;

  if (!tokens.length) {
    console.warn(`⚠️  Aucun token pour user=${targetUser || "tous"}`);
    return;
  }

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
      const res = await axios.post(
        "https://exp.host/--/api/v2/push/send",
        message,
        { headers: { "Content-Type": "application/json", "Accept": "application/json" } }
      );
      const ticket = res.data?.data ?? res.data;
      if (ticket.status === "error") {
        console.error(`❌ Push error:`, ticket.message, ticket.details);
      } else {
        console.log(`✅ Push envoyé à user=${targetUser} status=${ticket.status}`);
      }
    } catch (err) {
      console.error(`❌ Push HTTP error:`, err.message);
      if (err.response) console.error(`   Response:`, JSON.stringify(err.response.data));
    }
  }
}

/* ============================================================
   ACTIVE SYMBOLS
============================================================ */
function loadActiveSymbols() {
  console.log("📋 Chargement active_symbols...");
  const wsSymbols = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  const timeout = setTimeout(() => {
    console.warn("⏱ Timeout active_symbols — retry dans 30s");
    try { wsSymbols.terminate(); } catch {}
    setTimeout(loadActiveSymbols, 30000);
  }, 15000);

  wsSymbols.on("open", () => {
    wsSymbols.send(JSON.stringify({ active_symbols: "brief", product_type: "basic" }));
  });

  wsSymbols.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.active_symbols) return;
    clearTimeout(timeout);
    activeSymbols = msg.active_symbols
      .filter(s => s.symbol && s.display_name)
      .map(s => ({
        symbol:         s.symbol,
        display_name:   s.display_name,
        market:         s.market || "",
        market_name:    s.market_display_name || s.market || "Other",
        submarket:      s.submarket || "",
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

  wsSymbols.on("close", () => { clearTimeout(timeout); });
}

/* ============================================================
   DERIV WS — ticks + alertes avec cooldown 2h
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

      const triggered =
        (alert.condition === "over"  && price >= alert.price) ||
        (alert.condition === "under" && price <= alert.price);

      if (!triggered) {
        // Prix revenu hors zone → réarmer si en cooldown
        if (alert.fired === 1) {
          const lastSent = cooldownMap.get(alert.id) || 0;
          const elapsed  = Date.now() - lastSent;
          if (elapsed >= COOLDOWN_MS) {
            cooldownMap.delete(alert.id);
            await resetAlertForCooldown(alert.id).catch(() => {});
            console.log(`🔄 Alerte #${alert.id} réarmée`);
          }
        }
        continue;
      }

      // Vérifier cooldown 2h
      const lastSent = cooldownMap.get(alert.id) || 0;
      const elapsed  = Date.now() - lastSent;
      if (elapsed < COOLDOWN_MS) continue;

      // Déclencher
      cooldownMap.set(alert.id, Date.now());
      try { await markAlertFired(alert.id); } catch { continue; }

      const dir   = alert.condition === "over" ? "au-dessus ↑" : "en-dessous ↓";
      const body  = `${symbol} passé ${dir} de ${alert.price}\nPrix actuel : ${price.toFixed(4)}`;
      const title = "📈 Alerte Devises déclenchée !";

      console.log(`🔔 [ALERT #${alert.id} user=${alert.user} count=${(alert.fire_count || 0) + 1}] ${body}`);

      await sendPush(title, body, {
        alertId:   alert.id,
        symbol,
        price,
        threshold: alert.price,
        condition: alert.condition,
        fireCount: (alert.fire_count || 0) + 1,
      }, alert.user);
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
  const q = (req.query.q || "").toLowerCase().trim();
  const symbols = q
    ? activeSymbols.filter(s =>
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
    const user = req.query.user || "%";
    res.json(await getAlerts(user));
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

app.post("/alerts", async (req, res) => {
  const { asset, condition, price, user } = req.body;

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
    const newAlert = await addAlert({ user: user || "default", asset, condition, price: numPrice });
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
    cooldownMap.delete(id);
    res.json({ deleted: true, id });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

// CORRIGÉ : utilise le user envoyé par l'app
app.post("/save-token", async (req, res) => {
  const { token, user } = req.body;
  if (!token || typeof token !== "string")
    return res.status(400).json({ error: "Token invalide" });
  try {
    await saveToken(user || "default", token);
    console.log(`📲 Token sauvegardé pour user=${user || "default"}`);
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

app.get("/tokens", async (req, res) => {
  try {
    const tokens = await getTokens();
    res.json({ count: tokens.length, tokens: tokens.map(t => ({ id: t.id, user: t.user, token: t.token.slice(0, 20) + "..." })) });
  } catch {
    res.status(500).json({ error: "Erreur base de données" });
  }
});

app.get("/test-push", async (req, res) => {
  await sendPush("🧪 Test Devises Alert", "Son, vibration et barre de notif OK !", { test: true });
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
   TÂCHES PÉRIODIQUES
============================================================ */
async function runPeriodicTasks() {
  // 1. Réarmer les alertes dont le cooldown 2h est écoulé
  try {
    const alerts = await getAlerts("%");
    for (const alert of alerts) {
      if (alert.fired !== 1) continue;
      const lastSent = cooldownMap.get(alert.id);
      if (!lastSent) {
        // Cooldown pas en mémoire (redémarrage serveur) → vérifier fired_at en DB
        if (alert.last_sent_at) {
          const elapsed = Date.now() - new Date(alert.last_sent_at).getTime();
          if (elapsed >= COOLDOWN_MS) {
            await resetAlertForCooldown(alert.id).catch(() => {});
            console.log(`🔄 Alerte #${alert.id} réarmée après redémarrage`);
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Erreur tâche cooldown:", err.message);
  }

  // 2. Supprimer alertes déclenchées depuis > 3 jours
  try {
    const deleted = await deleteOldFiredAlerts();
    if (deleted.length > 0) {
      console.log(`🗑️  ${deleted.length} alerte(s) supprimée(s) après 3 jours:`, deleted.map(a => `#${a.id}`).join(", "));
    }
  } catch (err) {
    console.error("❌ Erreur suppression auto:", err.message);
  }
}

/* ============================================================
   DÉMARRAGE
============================================================ */
async function start() {
  await initDB();

  const existing = await getAlerts("%");
  for (const a of existing) {
    if (a.fired !== 1) subscribedSymbols.add(a.asset);
    else if (a.asset) subscribedSymbols.add(a.asset); // garder abonnement pour réarmement
  }
  console.log(`📋 ${existing.length} alerte(s) en DB`);

  connectDeriv();
  loadActiveSymbols();

  // Keep-alive toutes les 5 min
  setInterval(() => {
    console.log(`💓 Keep-alive — uptime: ${Math.floor(process.uptime())}s`);
  }, 5 * 60 * 1000);

  // Tâches périodiques toutes les 10 min
  setInterval(runPeriodicTasks, 10 * 60 * 1000);
  runPeriodicTasks(); // exécuter au démarrage

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
}

start().catch(err => {
  console.error("❌ Erreur démarrage:", err);
  process.exit(1);
});
