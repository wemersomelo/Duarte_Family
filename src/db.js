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
    CREATE INDEX IF NOT EXISTS notes_person ON notes(person_id);
    CREATE INDEX IF NOT EXISTS files_person ON files(person_id);
    CREATE INDEX IF NOT EXISTS media_person ON media_links(person_id);
  `);
  // Migrações para bancos criados por versões anteriores.
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols('notes').includes('kind')) db.exec(`ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'info'`);
  if (!cols('people').includes('photo_file_id')) db.exec(`ALTER TABLE people ADD COLUMN photo_file_id TEXT DEFAULT ''`);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  return db;
}

module.exports = { openDb };
