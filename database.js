import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;

export async function initDB() {
  db = await open({
    filename: "./alerts.db",
    driver: sqlite3.Database
  });

  await db.run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    user TEXT,
    asset TEXT,
    condition TEXT,
    price REAL
  )`);

  await db.run(`CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    user TEXT,
    token TEXT
  )`);
}

export async function addAlert(alert) {
  return db.run(
    "INSERT INTO alerts (user, asset, condition, price) VALUES (?,?,?,?)",
    alert.user, alert.asset, alert.condition, alert.price
  );
}

export async function getAlerts(user) {
  return db.all("SELECT * FROM alerts WHERE user = ?", user);
}

export async function deleteAlert(id) {
  return db.run("DELETE FROM alerts WHERE id = ?", id);
}

export async function saveToken(user, token) {
  return db.run("INSERT INTO tokens (user, token) VALUES (?,?)", user, token);
}

export async function getTokens() {
  return db.all("SELECT * FROM tokens");
}