/* Base de datos SQLite (mismo método que comisiones-web/database.js).
   - grupos:     catálogo configurable de grupos electores (ej. "colegiados").
   - personas:   padrón; cada persona tiene un solo grupo fijo. Es también la
                 identidad de login (primer acceso establece su contraseña).
   - comites:    cada uno define qué grupo vota en él (grupo_elector_id), su
                 propia ventana de votación (abierto/cierra) y si sus
                 resultados ya son públicos (publicado).
   - candidatos: boleta que arma el admin para cada comité.
   - votos:      un voto por persona por comité (PK compuesta); se puede
                 reemplazar mientras el comité esté abierto.
   - claves/sesiones: contraseña (hash bcrypt) y token→persona, igual que en
                 comisiones-web, pero indexadas por persona_id en vez de un
                 nombre de consejería fijo en código. */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'elecciones.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS personas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    grupo_id INTEGER NOT NULL REFERENCES grupos(id)
  );
  CREATE TABLE IF NOT EXISTS comites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    escanos INTEGER NOT NULL DEFAULT 1,
    grupo_elector_id INTEGER NOT NULL REFERENCES grupos(id),
    abierto INTEGER NOT NULL DEFAULT 1,
    cierra TEXT,
    publicado INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS candidatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comite_id INTEGER NOT NULL REFERENCES comites(id),
    nombre TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS votos (
    persona_id INTEGER NOT NULL REFERENCES personas(id),
    comite_id INTEGER NOT NULL REFERENCES comites(id),
    candidato_id INTEGER NOT NULL REFERENCES candidatos(id),
    actualizado TEXT,
    PRIMARY KEY (persona_id, comite_id)
  );
  CREATE TABLE IF NOT EXISTS claves (
    persona_id INTEGER PRIMARY KEY REFERENCES personas(id),
    hash TEXT NOT NULL,
    creado TEXT
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    persona_id INTEGER NOT NULL,
    creado TEXT
  );
`);

/* ---- grupos ---- */
const insGrupo = db.prepare(`INSERT INTO grupos (nombre) VALUES (?)`);
const updGrupo = db.prepare(`UPDATE grupos SET nombre = ? WHERE id = ?`);
const delGrupoStmt = db.prepare(`DELETE FROM grupos WHERE id = ?`);
const allGrupos = db.prepare(`SELECT * FROM grupos ORDER BY nombre`);
const unGrupo = db.prepare(`SELECT * FROM grupos WHERE id = ?`);
const personasDelGrupo = db.prepare(`SELECT COUNT(*) AS n FROM personas WHERE grupo_id = ?`);
const comitesDelGrupo  = db.prepare(`SELECT COUNT(*) AS n FROM comites WHERE grupo_elector_id = ?`);
function crearGrupo(nombre){ return insGrupo.run(nombre).lastInsertRowid; }
function editarGrupo(id, nombre){ updGrupo.run(nombre, id); }
function borrarGrupo(id){
  if(personasDelGrupo.get(id).n > 0 || comitesDelGrupo.get(id).n > 0)
    throw new Error('No se puede eliminar: hay personas o comités que usan este grupo.');
  delGrupoStmt.run(id);
}
function listarGrupos(){ return allGrupos.all(); }
function getGrupo(id){ return unGrupo.get(id) || null; }

/* ---- personas (padrón) ---- */
const insPersona = db.prepare(`INSERT INTO personas (nombre, grupo_id) VALUES (?, ?)`);
const updPersona = db.prepare(`UPDATE personas SET nombre = ?, grupo_id = ? WHERE id = ?`);
const delPersonaStmt = db.prepare(`DELETE FROM personas WHERE id = ?`);
const allPersonas = db.prepare(`SELECT * FROM personas ORDER BY nombre`);
const unaPersona = db.prepare(`SELECT * FROM personas WHERE id = ?`);
function crearPersona(nombre, grupo_id){ return insPersona.run(nombre, grupo_id).lastInsertRowid; }
function editarPersona(id, nombre, grupo_id){ updPersona.run(nombre, grupo_id, id); }
function borrarPersona(id){
  delSesionesDe(id); delClave(id);
  db.prepare(`DELETE FROM votos WHERE persona_id = ?`).run(id);
  delPersonaStmt.run(id);
}
function listarPersonas(){ return allPersonas.all(); }
function getPersona(id){ return unaPersona.get(id) || null; }

/* ---- comités ---- */
const insComite = db.prepare(`INSERT INTO comites (nombre, escanos, grupo_elector_id) VALUES (?, ?, ?)`);
const updComite = db.prepare(`
  UPDATE comites SET nombre = ?, escanos = ?, grupo_elector_id = ?,
    abierto = ?, cierra = ?, publicado = ? WHERE id = ?
`);
const delComiteStmt = db.prepare(`DELETE FROM comites WHERE id = ?`);
const allComites = db.prepare(`SELECT * FROM comites ORDER BY nombre`);
const unComite = db.prepare(`SELECT * FROM comites WHERE id = ?`);
const comitesDeGrupo = db.prepare(`SELECT * FROM comites WHERE grupo_elector_id = ?`);
function crearComite(nombre, escanos, grupo_elector_id){
  return insComite.run(nombre, escanos, grupo_elector_id).lastInsertRowid;
}
function editarComite(id, datos){
  const actual = getComite(id);
  if(!actual) return;
  updComite.run(
    datos.nombre ?? actual.nombre,
    datos.escanos ?? actual.escanos,
    datos.grupo_elector_id ?? actual.grupo_elector_id,
    datos.abierto !== undefined ? (datos.abierto ? 1 : 0) : actual.abierto,
    datos.cierra !== undefined ? datos.cierra : actual.cierra,
    datos.publicado !== undefined ? (datos.publicado ? 1 : 0) : actual.publicado,
    id
  );
}
function borrarComite(id){
  db.prepare(`DELETE FROM votos WHERE comite_id = ?`).run(id);
  db.prepare(`DELETE FROM candidatos WHERE comite_id = ?`).run(id);
  delComiteStmt.run(id);
}
function listarComites(){ return allComites.all(); }
function getComite(id){ return unComite.get(id) || null; }
function comitesPorGrupo(grupo_id){ return comitesDeGrupo.all(grupo_id); }

/* ---- candidatos ---- */
const insCandidato = db.prepare(`INSERT INTO candidatos (comite_id, nombre) VALUES (?, ?)`);
const updCandidato = db.prepare(`UPDATE candidatos SET nombre = ? WHERE id = ?`);
const delCandidatoStmt = db.prepare(`DELETE FROM candidatos WHERE id = ?`);
const candidatosDeComite = db.prepare(`SELECT * FROM candidatos WHERE comite_id = ? ORDER BY nombre`);
const unCandidato = db.prepare(`SELECT * FROM candidatos WHERE id = ?`);
function crearCandidato(comite_id, nombre){ return insCandidato.run(comite_id, nombre).lastInsertRowid; }
function editarCandidato(id, nombre){ updCandidato.run(nombre, id); }
function borrarCandidato(id){
  db.prepare(`DELETE FROM votos WHERE candidato_id = ?`).run(id);
  delCandidatoStmt.run(id);
}
function listarCandidatos(comite_id){ return candidatosDeComite.all(comite_id); }
function getCandidato(id){ return unCandidato.get(id) || null; }

/* ---- votos ---- */
const upVoto = db.prepare(`
  INSERT INTO votos (persona_id, comite_id, candidato_id, actualizado)
  VALUES (?, ?, ?, datetime('now','localtime'))
  ON CONFLICT(persona_id, comite_id) DO UPDATE SET
    candidato_id = excluded.candidato_id, actualizado = excluded.actualizado
`);
const selVoto = db.prepare(`SELECT candidato_id FROM votos WHERE persona_id = ? AND comite_id = ?`);
const conteoVotos = db.prepare(`
  SELECT candidato_id, COUNT(*) AS votos FROM votos WHERE comite_id = ? GROUP BY candidato_id
`);
const totalVotantes = db.prepare(`SELECT COUNT(*) AS n FROM votos WHERE comite_id = ?`);
function votar(persona_id, comite_id, candidato_id){ upVoto.run(persona_id, comite_id, candidato_id); }
function votoDe(persona_id, comite_id){ const r = selVoto.get(persona_id, comite_id); return r ? r.candidato_id : null; }
function resultadosDe(comite_id){ return conteoVotos.all(comite_id); }
function votantesDe(comite_id){ return totalVotantes.get(comite_id).n; }

/* ---- contraseñas (primer acceso) ---- */
const selClave = db.prepare('SELECT hash FROM claves WHERE persona_id = ?');
const upClave  = db.prepare(`
  INSERT INTO claves (persona_id, hash, creado)
  VALUES (?, ?, datetime('now','localtime'))
  ON CONFLICT(persona_id) DO UPDATE SET hash = excluded.hash, creado = excluded.creado
`);
const delClaveStmt = db.prepare('DELETE FROM claves WHERE persona_id = ?');
const allClaves    = db.prepare('SELECT persona_id FROM claves');
function getClave(id){ const r = selClave.get(id); return r ? r.hash : null; }
function setClave(id, hash){ upClave.run(id, hash); }
function delClave(id){ delClaveStmt.run(id); }
function listClaves(){ return allClaves.all().map(r => r.persona_id); }

/* ---- sesiones (token → persona_id) ---- */
const selSesion   = db.prepare('SELECT persona_id FROM sesiones WHERE token = ?');
const upSesion    = db.prepare(`INSERT OR REPLACE INTO sesiones (token, persona_id, creado) VALUES (?, ?, datetime('now','localtime'))`);
const delSesionesDeStmt = db.prepare('DELETE FROM sesiones WHERE persona_id = ?');
function getSesion(t){ const r = selSesion.get(t); return r ? r.persona_id : null; }
function setSesion(t, id){ upSesion.run(t, id); }
function delSesionesDe(id){ delSesionesDeStmt.run(id); }

module.exports = {
  db,
  crearGrupo, editarGrupo, borrarGrupo, listarGrupos, getGrupo,
  crearPersona, editarPersona, borrarPersona, listarPersonas, getPersona,
  crearComite, editarComite, borrarComite, listarComites, getComite, comitesPorGrupo,
  crearCandidato, editarCandidato, borrarCandidato, listarCandidatos, getCandidato,
  votar, votoDe, resultadosDe, votantesDe,
  getClave, setClave, delClave, listClaves,
  getSesion, setSesion, delSesionesDe
};
