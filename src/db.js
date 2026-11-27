'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',   -- admin | member | viewer
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      label TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      expires INTEGER NOT NULL,
      used_by INTEGER,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nick TEXT DEFAULT '',
      sex TEXT DEFAULT '',
      birth TEXT DEFAULT '',
      birth_place TEXT DEFAULT '',
      death TEXT DEFAULT '',
      death_place TEXT DEFAULT '',
      father_id TEXT DEFAULT '',
      mother_id TEXT DEFAULT '',
      spouse_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      sources TEXT DEFAULT '',
      created_by INTEGER,                    -- NULL = registro inicial (só o admin altera)
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      role TEXT NOT NULL,                    -- father | mother
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      caption TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      relation TEXT,
      message TEXT,
      ip TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | joined
      created_at TEXT NOT NULL,
      decided_by INTEGER,
      decided_at TEXT,
      invite_token TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, person_id TEXT, text TEXT NOT NULL,
      by_user INTEGER, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at);
    CREATE TABLE IF NOT EXISTS removed_users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, removed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resets (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      at TEXT NOT NULL
    );
    -- Relatos de entrevista importados (pasta com ficha.md, relato.md, lote.csv, material/)
    CREATE TABLE IF NOT EXISTS relatos (
      id TEXT PRIMARY KEY,
      fonte TEXT, data TEXT, ficha TEXT, relato TEXT,
      imported_at TEXT, imported_by INTEGER, applied INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS relato_rows (
      relato_id TEXT NOT NULL, row_key TEXT NOT NULL, status TEXT NOT NULL, at TEXT,
      PRIMARY KEY (relato_id, row_key)
    );
    CREATE TABLE IF NOT EXISTS relato_people (
      relato_id TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (relato_id, person_id)
    );
    CREATE TABLE IF NOT EXISTS relato_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, relato_id TEXT NOT NULL, name TEXT NOT NULL,
      stored TEXT NOT NULL, mime TEXT, size INTEGER, created_at TEXT
    );
    -- Nomes alternativos confirmados pelo administrador ("Donaldo" = pessoa X)
    CREATE TABLE IF NOT EXISTS person_aliases (
      alias TEXT PRIMARY KEY, person_id TEXT NOT NULL, created_at TEXT
    );
    -- Alertas pulados e possíveis duplicados ainda abertos
    CREATE TABLE IF NOT EXISTS pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, relato_id TEXT, title TEXT, data TEXT,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT
    );
    -- Pares que o administrador disse que NÃO são a mesma pessoa
    CREATE TABLE IF NOT EXISTS not_duplicates (
      a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS relato_people_person ON relato_people(person_id);
    CREATE INDEX IF NOT EXISTS notes_person ON notes(person_id);
    CREATE INDEX IF NOT EXISTS files_person ON files(person_id);
    CREATE INDEX IF NOT EXISTS media_person ON media_links(person_id);
  `);
  // Migrações para bancos criados por versões anteriores.
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols('notes').includes('kind')) db.exec(`ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'info'`);
  if (!cols('invites').includes('email')) db.exec(`ALTER TABLE invites ADD COLUMN email TEXT`);
  for (const c of ['color', 'origin']) if (!cols('people').includes(c)) db.exec(`ALTER TABLE people ADD COLUMN ${c} TEXT DEFAULT ''`);
  if (!cols('people').includes('given')) db.exec(`ALTER TABLE people ADD COLUMN given TEXT DEFAULT ''`);
  for (const c of ['marriage', 'marriage_place', 'descendants']) if (!cols('people').includes(c)) db.exec(`ALTER TABLE people ADD COLUMN ${c} TEXT DEFAULT ''`);
  if (!cols('invites').includes('person_id')) db.exec(`ALTER TABLE invites ADD COLUMN person_id TEXT NOT NULL DEFAULT ''`);
  if (!cols('access_requests').includes('claim')) db.exec(`ALTER TABLE access_requests ADD COLUMN claim TEXT`);
  if (!cols('users').includes('person_id')) db.exec(`ALTER TABLE users ADD COLUMN person_id TEXT NOT NULL DEFAULT ''`);
  // relato_people.hidden: 0 = aparece, 1 = oculto (só o administrador vê), 2 = apagado (não volta ao reimportar)
  if (!cols('relato_people').includes('hidden')) db.exec(`ALTER TABLE relato_people ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  // files.doc: 1 = documento (certidão, identidade...), visível só para a família próxima da pessoa, quem enviou e o administrador.
  // Na primeira vez, por segurança, tudo o que já existe vira documento, menos as fotos de perfil.
  if (!cols('files').includes('doc')) {
    db.exec(`ALTER TABLE files ADD COLUMN doc INTEGER NOT NULL DEFAULT 1`);
    if (cols('people').includes('photo_file_id')) db.exec(`UPDATE files SET doc=0 WHERE id IN (SELECT photo_file_id FROM people WHERE photo_file_id<>'')`);
  }
  // users.person_ok: 1 = a ligação conta-ficha foi confirmada (pelo convite ou pelo administrador). Só aí a pessoa
  // passa a administrar a própria ficha e quem a cadastrou perde o direito de alterá-la.
  if (!cols('users').includes('person_ok')) db.exec(`ALTER TABLE users ADD COLUMN person_ok INTEGER NOT NULL DEFAULT 0`);
  if (!cols('people').includes('photo_file_id')) db.exec(`ALTER TABLE people ADD COLUMN photo_file_id TEXT DEFAULT ''`);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  return db;
}

module.exports = { openDb };
