'use strict';
// Garante que um banco criado pela primeira versão é atualizado sem perder dados.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-mig-'));
const file = path.join(dir, 'arvore.db');
const old = new Database(file);
old.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, nick TEXT DEFAULT '', sex TEXT DEFAULT '', birth TEXT DEFAULT '', birth_place TEXT DEFAULT '', death TEXT DEFAULT '', death_place TEXT DEFAULT '', father_id TEXT DEFAULT '', mother_id TEXT DEFAULT '', spouse_id TEXT DEFAULT '', notes TEXT DEFAULT '', sources TEXT DEFAULT '', created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER);
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, text TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL);
INSERT INTO people(id,name,created_at,updated_at) VALUES('p1','Pessoa Antiga','x','x');
INSERT INTO notes(person_id,text,created_at) VALUES('p1','nota antiga','x');`);
old.close();
const { openDb } = require('../src/db');
const db = openDb(file);
assert.equal(db.prepare('SELECT name FROM people WHERE id=?').get('p1').name, 'Pessoa Antiga');
assert.equal(db.prepare('SELECT kind FROM notes').get().kind, 'info');
assert.equal(db.prepare('SELECT photo_file_id FROM people').get().photo_file_id, '');
db.prepare("INSERT INTO media_links(person_id,url,created_at) VALUES('p1','https://a.b','x')").run();
openDb(file); // rodar de novo não pode dar erro
console.log('OK: migração do banco antigo');
fs.rmSync(dir, { recursive: true, force: true });
