const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host    : 'square-cloud-db-ed05a1b79be14136948e16776f06d60c.squareweb.app',
  port    : 7204,
  user    : 'squarecloud',
  password: 'Me9koIOq3QCgNkOJPXTjQhFt',
  database: 'squarecloud',
  ssl: { rejectUnauthorized: false },
  timezone          : 'local',
  waitForConnections: true,
  connectionLimit   : 5,
  queueLimit        : 0
});

const _RETRYABLE = new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','PROTOCOL_CONNECTION_LOST','ER_CON_COUNT_ERROR']);

async function query(sql, params = [], _attempt = 0) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (e) {
    if (_attempt < 2 && _RETRYABLE.has(e.code)) {
      await new Promise(r => setTimeout(r, 400 * (_attempt + 1)));
      return query(sql, params, _attempt + 1);
    }
    throw e;
  }
}

async function initTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      key_code          VARCHAR(64) UNIQUE NOT NULL,
      used              TINYINT(1) DEFAULT 0,
      used_by           INT DEFAULT NULL,
      used_at           TIMESTAMP NULL DEFAULT NULL,
      subscription_days INT DEFAULT NULL,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id                       INT AUTO_INCREMENT PRIMARY KEY,
      username                 VARCHAR(50) UNIQUE NOT NULL,
      password_hash            VARCHAR(255) NOT NULL,
      hwid                     VARCHAR(255) NOT NULL,
      key_id                   INT DEFAULT NULL,
      role                     VARCHAR(20) DEFAULT 'user',
      session_token            VARCHAR(64) DEFAULT NULL,
      subscription_expires_at  TIMESTAMP NULL DEFAULT NULL,
      created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { await query(`ALTER TABLE users ADD COLUMN session_token VARCHAR(64) DEFAULT NULL`); } catch(e) {}
  try { await query(`ALTER TABLE users ADD COLUMN multi_device TINYINT(1) DEFAULT 0`); } catch(e) {}
  await query(`
    CREATE TABLE IF NOT EXISTS rb_accounts (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL UNIQUE,
      data       LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS rb_images (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      pet_uid    VARCHAR(64) NOT NULL,
      image_data LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_pet (user_id, pet_uid)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL UNIQUE,
      data       LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS rb_sales (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      user_id          INT NOT NULL,
      pet_name         VARCHAR(255) NOT NULL,
      mutation         VARCHAR(100),
      ms_label         VARCHAR(50),
      generation       BIGINT,
      offer_title      VARCHAR(500) NOT NULL,
      offer_id         VARCHAR(100),
      conversation_id  VARCHAR(255),
      amount           DECIMAL(10,2) NOT NULL DEFAULT 0,
      account_username VARCHAR(255),
      account_key      VARCHAR(255),
      pet_data         LONGTEXT,
      sold_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_conversation (conversation_id)
    )
  `);
  try { await query(`ALTER TABLE rb_sales ADD COLUMN conversation_id VARCHAR(255)`); } catch(e) {}
  try { await query(`ALTER TABLE rb_sales ADD INDEX idx_conversation (conversation_id)`); } catch(e) {}
  try { await query(`ALTER TABLE rb_sales DROP INDEX uq_conversation`); } catch(e) {}
  // Best-effort ALTERs for pre-existing installs — silently ignore "Duplicate
  // column name" errors (MySQL lacks ADD COLUMN IF NOT EXISTS on older
  // versions). Each ALTER is in its own try so one existing column doesn't
  // block the next.
  const altersSales = [
    "ALTER TABLE rb_sales ADD COLUMN account_username VARCHAR(255)",
    "ALTER TABLE rb_sales ADD COLUMN account_key      VARCHAR(255)",
    "ALTER TABLE rb_sales ADD COLUMN pet_data         LONGTEXT",
    "ALTER TABLE rb_sales ADD COLUMN generation       BIGINT"
  ];
  for (const sql of altersSales) {
    try { await query(sql); } catch (e) { /* duplicate column — fine */ }
  }
  try { await query("ALTER TABLE users ADD COLUMN discord_id VARCHAR(32) DEFAULT NULL"); } catch(e) {}
  await query(`
    CREATE TABLE IF NOT EXISTS app_config (
      \`key\`   VARCHAR(50)  PRIMARY KEY,
      \`value\` VARCHAR(100) NOT NULL
    )
  `);
  await query("INSERT IGNORE INTO app_config (`key`, `value`) VALUES ('min_version', '1.0.0')");
  await query(`
    CREATE TABLE IF NOT EXISTS offer_accounts (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      user_id          INT NOT NULL,
      offer_id         VARCHAR(100) NOT NULL,
      account_username VARCHAR(255) NOT NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_lookup (user_id, offer_id)
    )
  `);
  // Stacking uses a FIFO queue: one row per listed unit. Drop the old UNIQUE
  // constraint that prevented multiple accounts per offer_id.
  try { await query("ALTER TABLE offer_accounts DROP INDEX uq_user_offer"); } catch(e) {}
  try { await query("ALTER TABLE offer_accounts ADD INDEX idx_lookup (user_id, offer_id)"); } catch(e) {}
  try { await query("ALTER TABLE offer_accounts ADD COLUMN pet_uuid VARCHAR(255)"); } catch(e) {}
  try { await query("ALTER TABLE offer_accounts ADD COLUMN order_id VARCHAR(255)"); } catch(e) {}
  try { await query("ALTER TABLE offer_accounts ADD INDEX idx_order (order_id)"); } catch(e) {}

  await query(`
    CREATE TABLE IF NOT EXISTS adlv_licenses (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      code       VARCHAR(32) NOT NULL UNIQUE,
      label      VARCHAR(100),
      active     TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_at    TIMESTAMP NULL,
      duration_days INT DEFAULT NULL,
      expires_at TIMESTAMP NULL
    )
  `);
  try { await query("ALTER TABLE adlv_licenses ADD COLUMN duration_days INT DEFAULT NULL"); } catch(e) {}
  try { await query("ALTER TABLE adlv_licenses ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL"); } catch(e) {}

  await query(`
    CREATE TABLE IF NOT EXISTS adlv_delivery_logs (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      user_id         INT NOT NULL,
      offer_id        VARCHAR(100) NOT NULL,
      pet_name        VARCHAR(255),
      buyer_nick      VARCHAR(100),
      status          VARCHAR(20) NOT NULL,
      failure_reason  VARCHAR(100),
      failure_label   VARCHAR(255),
      account_username VARCHAR(255),
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_created (created_at)
    )
  `);
}

module.exports = { query, initTables };
