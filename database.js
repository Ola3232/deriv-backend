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
      id           SERIAL PRIMARY KEY,
      "user"       TEXT    NOT NULL DEFAULT 'default',
      asset        TEXT    NOT NULL,
      condition    TEXT    NOT NULL,
      price        REAL    NOT NULL,
      fired        INTEGER NOT NULL DEFAULT 0,
      fired_at     TIMESTAMPTZ,
      fire_count   INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sound        TEXT    NOT NULL DEFAULT 'trading',
      alert_type   TEXT    NOT NULL DEFAULT 'alert'
    )
  `);

  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS fired_at     TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS sound        TEXT NOT NULL DEFAULT 'trading'`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_type   TEXT NOT NULL DEFAULT 'alert'`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS fire_count   INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id        SERIAL PRIMARY KEY,
      "user"    TEXT NOT NULL DEFAULT 'default',
      token     TEXT NOT NULL UNIQUE,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id         SERIAL PRIMARY KEY,
      code       TEXT    NOT NULL UNIQUE,
      role       TEXT    NOT NULL DEFAULT 'user',
      used       INTEGER NOT NULL DEFAULT 0,
      used_by    TEXT,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO invite_codes (code, role)
    VALUES ('ADMIN-SADATH2024', 'admin')
    ON CONFLICT (code) DO NOTHING
  `);

  console.log("✅ Base de données PostgreSQL initialisée");
}

export async function addAlert(alert) {
  const result = await pool.query(
    `INSERT INTO alerts ("user", asset, condition, price, sound, alert_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [alert.user ?? "default", alert.asset, alert.condition, alert.price, alert.sound ?? "trading", alert.alertType ?? "alert"]
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
  return pool.query(
    `UPDATE alerts
     SET fired        = 1,
         fired_at     = COALESCE(fired_at, NOW()),
         fire_count   = fire_count + 1,
         last_sent_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

export async function resetAlertForCooldown(id) {
  return pool.query(`UPDATE alerts SET fired = 0 WHERE id = $1`, [id]);
}

export async function deleteOldFiredAlerts() {
  const result = await pool.query(
    `DELETE FROM alerts
     WHERE fired_at IS NOT NULL
       AND fired_at < NOW() - INTERVAL '3 days'
     RETURNING id, "user", asset`
  );
  return result.rows;
}

export async function saveToken(user, token) {
  return pool.query(
    `INSERT INTO tokens ("user", token, last_seen) VALUES ($1, $2, NOW())
     ON CONFLICT (token) DO UPDATE SET "user" = EXCLUDED."user", last_seen = NOW()`,
    [user ?? "default", token]
  );
}

export async function getTokens() {
  const result = await pool.query("SELECT * FROM tokens");
  return result.rows;
}

/* ============================================================
   INVITE CODES
============================================================ */
export async function validateCode(code) {
  const result = await pool.query(
    `SELECT * FROM invite_codes WHERE code = $1`,
    [code.toUpperCase().trim()]
  );
  if (!result.rows.length) return { valid: false, reason: "Code invalide" };
  const row = result.rows[0];
  if (row.used === 1 && row.role !== 'admin')
    return { valid: false, reason: "Code déjà utilisé" };
  return { valid: true, role: row.role, code: row.code };
}

export async function markCodeUsed(code, userId) {
  return pool.query(
    `UPDATE invite_codes SET used = 1, used_by = $1, used_at = NOW()
     WHERE code = $2 AND role != 'admin'`,
    [userId, code.toUpperCase().trim()]
  );
}

export async function generateCode(role = 'user') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = Array.from({length: 6}, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  const prefix = role === 'admin' ? 'ADMIN' : 'USER';
  const code = `${prefix}-${random}`;
  await pool.query(
    `INSERT INTO invite_codes (code, role) VALUES ($1, $2)`,
    [code, role]
  );
  return code;
}

export async function getCodes() {
  const result = await pool.query(
    `SELECT * FROM invite_codes ORDER BY created_at DESC`
  );
  return result.rows;
}
