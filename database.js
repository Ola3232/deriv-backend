import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDB() {
  console.log("📂 Connexion PostgreSQL...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id        SERIAL PRIMARY KEY,
      "user"    TEXT    NOT NULL DEFAULT 'default',
      asset     TEXT    NOT NULL,
      condition TEXT    NOT NULL,
      price     REAL    NOT NULL,
      fired     INTEGER NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id    SERIAL PRIMARY KEY,
      "user" TEXT NOT NULL DEFAULT 'default',
      token TEXT NOT NULL UNIQUE
    )
  `);

  console.log("✅ Base de données PostgreSQL initialisée");
}

export async function addAlert(alert) {
  const result = await pool.query(
    `INSERT INTO alerts ("user", asset, condition, price)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [alert.user ?? "default", alert.asset, alert.condition, alert.price]
  );
  return result.rows[0];
}

export async function getAlerts(user) {
  if (user === "%") {
    const result = await pool.query("SELECT * FROM alerts ORDER BY id DESC");
    return result.rows;
  }
  const result = await pool.query(
    `SELECT * FROM alerts WHERE "user" = $1 ORDER BY id DESC`,
    [user]
  );
  return result.rows;
}

export async function deleteAlert(id) {
  return pool.query("DELETE FROM alerts WHERE id = $1", [id]);
}

export async function markAlertFired(id) {
  return pool.query("UPDATE alerts SET fired = 1 WHERE id = $1", [id]);
}

export async function saveToken(user, token) {
  return pool.query(
    `INSERT INTO tokens ("user", token) VALUES ($1, $2)
     ON CONFLICT (token) DO UPDATE SET "user" = EXCLUDED."user"`,
    [user ?? "default", token]
  );
}

export async function getTokens() {
  const result = await pool.query("SELECT * FROM tokens");
  return result.rows;
}
