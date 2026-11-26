const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','pimpinan'))
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('tutor','staf')),
  class_name TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('hadir','izin','sakit','alpa')),
  note TEXT,
  UNIQUE (member_id, date)
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
`);

// ---------- Migrasi fitur absen QR ----------
// Aman dijalankan berulang: kolom hanya ditambah bila belum ada, data lama tidak berubah.
const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

if (!hasColumn('members', 'qr_token')) {
  db.exec('ALTER TABLE members ADD COLUMN qr_token TEXT');
}
if (!hasColumn('attendance', 'check_in_time')) {
  db.exec('ALTER TABLE attendance ADD COLUMN check_in_time TEXT'); // 'HH:MM:SS' WIB
}
if (!hasColumn('attendance', 'source')) {
  db.exec("ALTER TABLE attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"); // 'manual' | 'qr'
}

db.exec(`
-- Anggota baru (termasuk hasil impor Excel) otomatis mendapat token QR acak.
CREATE TRIGGER IF NOT EXISTS trg_members_qr_token
AFTER INSERT ON members
WHEN NEW.qr_token IS NULL
BEGIN
  UPDATE members SET qr_token = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
`);
// Anggota lama yang belum punya token.
db.exec("UPDATE members SET qr_token = lower(hex(randomblob(16))) WHERE qr_token IS NULL");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_qr_token ON members(qr_token)');

if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const ins = db.prepare('INSERT INTO users (username,password_hash,name,role) VALUES (?,?,?,?)');
  ins.run('admin', bcrypt.hashSync('admin123', 10), 'Admin PKBM', 'admin');
  ins.run('pimpinan', bcrypt.hashSync('pimpinan123', 10), 'Pimpinan PKBM', 'pimpinan');
}

module.exports = db;
