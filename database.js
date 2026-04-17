import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;

export async function initDB() {
  db = await open({
    filename: "./alerts.db",
    driver: sqlite3.Database,
  });

  // Table alertes — colonne fired pour marquer si déjà déclenchée
  await db.run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user      TEXT    NOT NULL DEFAULT 'default',
      asset     TEXT    NOT NULL,
      condition TEXT    NOT NULL,
      price     REAL    NOT NULL,
      fired     INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Table tokens push Expo
  await db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      user  TEXT NOT NULL DEFAULT 'default',
      token TEXT NOT NULL UNIQUE
    )
  `);

  console.log("✅ Base de données initialisée");
}

export async function addAlert(alert) {
  const result = await db.run(
    "INSERT INTO alerts (user, asset, condition, price) VALUES (?,?,?,?)",
    alert.user ?? "default",
    alert.asset,
    alert.condition,
    alert.price
  );
  return db.get("SELECT * FROM alerts WHERE id = ?", result.lastID);
}

export async function getAlerts(user) {
  if (user === "%") return db.all("SELECT * FROM alerts ORDER BY id DESC");
  return db.all("SELECT * FROM alerts WHERE user = ? ORDER BY id DESC", user);
}

export async function deleteAlert(id) {
  return db.run("DELETE FROM alerts WHERE id = ?", id);
}

export async function markAlertFired(id) {
  return db.run("UPDATE alerts SET fired = 1 WHERE id = ?", id);
}

// Upsert token : si le token existe déjà on ne le duplique pas
export async function saveToken(user, token) {
  return db.run(
    `INSERT INTO tokens (user, token) VALUES (?,?)
     ON CONFLICT(token) DO UPDATE SET user = excluded.user`,
    user ?? "default",
    token
  );
}

export async function getTokens() {
  return db.all("SELECT * FROM tokens");
}
