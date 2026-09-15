/* Base de datos SQLite (mismo método que comisiones-web/database.js).
   - grupos:     catálogo configurable de grupos electores (ej. "Consejerías").
   - personas:   padrón; cada persona tiene un solo grupo fijo. Es también la
                 identidad de login (primer acceso establece su contraseña).
   - comites:    cada uno define qué grupo vota en él (grupo_elector_id),
                 cuántos integrantes se eligen (escanos — también es el número
                 de votos que emite cada elector), su ventana de votación
                 (abierto/cierra), si sus resultados ya son públicos
                 (publicado) o se revelan solos al completarse la votación
                 (revelar_al_completar), y si es una ronda de desempate de
                 otro comité (comite_padre_id).
   - candidatos: boleta que arma el admin para cada comité — nombre,
                 institución, especialidad y CV en PDF (cv_filename es el
                 nombre en disco dentro de uploads/cv/).
   - votos:      un renglón por persona+comité+candidatura marcada (voto
                 múltiple: cada persona marca hasta `escanos` candidaturas).
   - confirmaciones: existencia de la fila = esa persona ya cerró su boleta
                 para ese comité; a partir de ahí no se admiten más cambios.
   - claves/sesiones: contraseña (hash bcrypt) y token→persona, igual que en
                 comisiones-web, indexadas por persona_id. */
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
    publicado INTEGER NOT NULL DEFAULT 0,
    revelar_al_completar INTEGER NOT NULL DEFAULT 0,
    comite_padre_id INTEGER REFERENCES comites(id)
  );
  CREATE TABLE IF NOT EXISTS candidatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comite_id INTEGER NOT NULL REFERENCES comites(id),
    nombre TEXT NOT NULL,
    institucion TEXT,
    especialidad TEXT,
    cv_texto TEXT,
    cv_filename TEXT,
    cv_nombre_original TEXT
  );
  CREATE TABLE IF NOT EXISTS votos (
    persona_id INTEGER NOT NULL REFERENCES personas(id),
    comite_id INTEGER NOT NULL REFERENCES comites(id),
    candidato_id INTEGER NOT NULL REFERENCES candidatos(id),
    actualizado TEXT,
    PRIMARY KEY (persona_id, comite_id, candidato_id)
  );
  CREATE TABLE IF NOT EXISTS confirmaciones (
    persona_id INTEGER NOT NULL,
    comite_id INTEGER NOT NULL,
    confirmado_en TEXT,
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
  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cuando TEXT NOT NULL,
    actor TEXT NOT NULL,
    accion TEXT NOT NULL,
    comite_id INTEGER,
    detalle TEXT
  );
`);

/* Migraciones: estas columnas se agregaron después de que ya había datos
   reales en producción local (los 11 consejeros), así que no basta con el
   CREATE TABLE IF NOT EXISTS de arriba — hay que alterar la tabla existente
   si falta la columna. */
const columnasCandidatos = db.prepare(`PRAGMA table_info(candidatos)`).all().map(c => c.name);
if(!columnasCandidatos.includes('cv_texto')){
  db.exec(`ALTER TABLE candidatos ADD COLUMN cv_texto TEXT`);
}
const columnasComites = db.prepare(`PRAGMA table_info(comites)`).all().map(c => c.name);
if(!columnasComites.includes('abre')){
  db.exec(`ALTER TABLE comites ADD COLUMN abre TEXT`);
}

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
const personasDeGrupoStmt = db.prepare(`SELECT * FROM personas WHERE grupo_id = ? ORDER BY nombre`);
function crearPersona(nombre, grupo_id){ return insPersona.run(nombre, grupo_id).lastInsertRowid; }
function editarPersona(id, nombre, grupo_id){ updPersona.run(nombre, grupo_id, id); }
function borrarPersona(id){
  delSesionesDe(id); delClave(id);
  db.prepare(`DELETE FROM votos WHERE persona_id = ?`).run(id);
  db.prepare(`DELETE FROM confirmaciones WHERE persona_id = ?`).run(id);
  delPersonaStmt.run(id);
}
function listarPersonas(){ return allPersonas.all(); }
function getPersona(id){ return unaPersona.get(id) || null; }
function personasDeGrupo(grupo_id){ return personasDeGrupoStmt.all(grupo_id); }

/* ---- comités ---- */
const insComite = db.prepare(`
  INSERT INTO comites (nombre, escanos, grupo_elector_id, comite_padre_id)
  VALUES (?, ?, ?, ?)
`);
const updComite = db.prepare(`
  UPDATE comites SET nombre = ?, escanos = ?, grupo_elector_id = ?,
    abierto = ?, abre = ?, cierra = ?, publicado = ?, revelar_al_completar = ? WHERE id = ?
`);
const delComiteStmt = db.prepare(`DELETE FROM comites WHERE id = ?`);
const allComites = db.prepare(`SELECT * FROM comites ORDER BY nombre`);
const unComite = db.prepare(`SELECT * FROM comites WHERE id = ?`);
const comitesDeGrupo = db.prepare(`SELECT * FROM comites WHERE grupo_elector_id = ?`);
const comitesHijosStmt = db.prepare(`SELECT * FROM comites WHERE comite_padre_id = ?`);
function crearComite(nombre, escanos, grupo_elector_id, comite_padre_id){
  return insComite.run(nombre, escanos, grupo_elector_id, comite_padre_id || null).lastInsertRowid;
}
function editarComite(id, datos){
  const actual = getComite(id);
  if(!actual) return;
  updComite.run(
    datos.nombre ?? actual.nombre,
    datos.escanos ?? actual.escanos,
    datos.grupo_elector_id ?? actual.grupo_elector_id,
    datos.abierto !== undefined ? (datos.abierto ? 1 : 0) : actual.abierto,
    datos.abre !== undefined ? datos.abre : actual.abre,
    datos.cierra !== undefined ? datos.cierra : actual.cierra,
    datos.publicado !== undefined ? (datos.publicado ? 1 : 0) : actual.publicado,
    datos.revelar_al_completar !== undefined ? (datos.revelar_al_completar ? 1 : 0) : actual.revelar_al_completar,
    id
  );
}
function borrarComite(id){
  if(comitesHijosStmt.all(id).length > 0)
    throw new Error('No se puede eliminar: tiene una ronda de desempate. Elimínala primero.');
  db.prepare(`DELETE FROM votos WHERE comite_id = ?`).run(id);
  db.prepare(`DELETE FROM confirmaciones WHERE comite_id = ?`).run(id);
  db.prepare(`DELETE FROM candidatos WHERE comite_id = ?`).run(id);
  delComiteStmt.run(id);
}
function listarComites(){ return allComites.all(); }
function getComite(id){ return unComite.get(id) || null; }
function comitesPorGrupo(grupo_id){ return comitesDeGrupo.all(grupo_id); }
function comitesHijosDe(id){ return comitesHijosStmt.all(id); }

/* ---- candidatos ---- */
const insCandidato = db.prepare(`
  INSERT INTO candidatos (comite_id, nombre, institucion, especialidad, cv_texto, cv_filename, cv_nombre_original)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updCandidato = db.prepare(`
  UPDATE candidatos SET nombre = ?, institucion = ?, especialidad = ?, cv_texto = ? WHERE id = ?
`);
const updCandidatoCv = db.prepare(`
  UPDATE candidatos SET cv_filename = ?, cv_nombre_original = ? WHERE id = ?
`);
const delCandidatoStmt = db.prepare(`DELETE FROM candidatos WHERE id = ?`);
const candidatosDeComite = db.prepare(`SELECT * FROM candidatos WHERE comite_id = ? ORDER BY nombre`);
const unCandidato = db.prepare(`SELECT * FROM candidatos WHERE id = ?`);
const candidatosConArchivoStmt = db.prepare(`SELECT COUNT(*) AS n FROM candidatos WHERE cv_filename = ?`);
function candidatosConArchivo(cv_filename){ return candidatosConArchivoStmt.get(cv_filename).n; }
function crearCandidato(comite_id, nombre, institucion, especialidad, cv_texto, cv_filename, cv_nombre_original){
  return insCandidato.run(comite_id, nombre, institucion || null, especialidad || null,
    cv_texto || null, cv_filename || null, cv_nombre_original || null).lastInsertRowid;
}
function editarCandidato(id, nombre, institucion, especialidad, cv_texto){
  updCandidato.run(nombre, institucion || null, especialidad || null, cv_texto || null, id);
}
function actualizarCvCandidato(id, cv_filename, cv_nombre_original){
  updCandidatoCv.run(cv_filename, cv_nombre_original, id);
}
function borrarCandidato(id){
  db.prepare(`DELETE FROM votos WHERE candidato_id = ?`).run(id);
  delCandidatoStmt.run(id);
}
function listarCandidatos(comite_id){ return candidatosDeComite.all(comite_id); }
function getCandidato(id){ return unCandidato.get(id) || null; }

/* ---- votos ---- */
const insVoto = db.prepare(`
  INSERT OR IGNORE INTO votos (persona_id, comite_id, candidato_id, actualizado)
  VALUES (?, ?, ?, datetime('now','localtime'))
`);
const delVoto = db.prepare(`DELETE FROM votos WHERE persona_id = ? AND comite_id = ? AND candidato_id = ?`);
const votosDePersonaStmt = db.prepare(`SELECT candidato_id FROM votos WHERE persona_id = ? AND comite_id = ?`);
const contarVotosPersonaStmt = db.prepare(`SELECT COUNT(*) AS n FROM votos WHERE persona_id = ? AND comite_id = ?`);
const conteoVotos = db.prepare(`
  SELECT candidato_id, COUNT(*) AS votos FROM votos WHERE comite_id = ? GROUP BY candidato_id
`);
const marcasDeComiteStmt = db.prepare(`SELECT persona_id, candidato_id FROM votos WHERE comite_id = ?`);
function marcarVoto(persona_id, comite_id, candidato_id){ insVoto.run(persona_id, comite_id, candidato_id); }
function desmarcarVoto(persona_id, comite_id, candidato_id){ delVoto.run(persona_id, comite_id, candidato_id); }
function votosDePersona(persona_id, comite_id){ return votosDePersonaStmt.all(persona_id, comite_id).map(r => r.candidato_id); }
function contarVotosPersona(persona_id, comite_id){ return contarVotosPersonaStmt.get(persona_id, comite_id).n; }
function resultadosDe(comite_id){ return conteoVotos.all(comite_id); }
function marcasDeComite(comite_id){ return marcasDeComiteStmt.all(comite_id); }

/* ---- confirmaciones ---- */
const insConfirmacion = db.prepare(`
  INSERT OR IGNORE INTO confirmaciones (persona_id, comite_id, confirmado_en)
  VALUES (?, ?, datetime('now','localtime'))
`);
const delConfirmacion = db.prepare(`DELETE FROM confirmaciones WHERE persona_id = ? AND comite_id = ?`);
const yaConfirmoStmt = db.prepare(`SELECT confirmado_en FROM confirmaciones WHERE persona_id = ? AND comite_id = ?`);
const confirmacionesDeComiteStmt = db.prepare(`SELECT * FROM confirmaciones WHERE comite_id = ?`);
function confirmar(persona_id, comite_id){ insConfirmacion.run(persona_id, comite_id); }
function reabrir(persona_id, comite_id){ delConfirmacion.run(persona_id, comite_id); }
function yaConfirmo(persona_id, comite_id){ return !!yaConfirmoStmt.get(persona_id, comite_id); }
function confirmacionesDe(comite_id){ return confirmacionesDeComiteStmt.all(comite_id); }

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
const selSesion   = db.prepare('SELECT persona_id, creado FROM sesiones WHERE token = ?');
const upSesion    = db.prepare(`INSERT OR REPLACE INTO sesiones (token, persona_id, creado) VALUES (?, ?, datetime('now','localtime'))`);
const delSesionStmt     = db.prepare('DELETE FROM sesiones WHERE token = ?');
const delSesionesDeStmt = db.prepare('DELETE FROM sesiones WHERE persona_id = ?');
function getSesionInfo(t){ return selSesion.get(t) || null; }
function getSesion(t){ const r = selSesion.get(t); return r ? r.persona_id : null; }
function setSesion(t, id){ upSesion.run(t, id); }
function delSesion(t){ delSesionStmt.run(t); }
function delSesionesDe(id){ delSesionesDeStmt.run(id); }

/* ---- auditoría ----
   Bitácora de actuaciones relevantes del proceso de votación: quién (actor,
   "persona:<id>" o "admin"), qué (acción), sobre qué comité y con qué
   detalle (texto libre, normalmente JSON), para poder reconstruir la
   secuencia de eventos y verificar la integridad del proceso. */
const insAuditoria = db.prepare(`
  INSERT INTO auditoria (cuando, actor, accion, comite_id, detalle)
  VALUES (datetime('now','localtime'), ?, ?, ?, ?)
`);
const auditoriaDeComiteStmt = db.prepare(`SELECT * FROM auditoria WHERE comite_id = ? ORDER BY id DESC`);
function registrarAuditoria(actor, accion, comite_id, detalle){
  insAuditoria.run(actor, accion, comite_id || null, detalle ? JSON.stringify(detalle) : null);
}
function auditoriaDe(comite_id){ return auditoriaDeComiteStmt.all(comite_id); }

module.exports = {
  db,
  crearGrupo, editarGrupo, borrarGrupo, listarGrupos, getGrupo,
  crearPersona, editarPersona, borrarPersona, listarPersonas, getPersona, personasDeGrupo,
  crearComite, editarComite, borrarComite, listarComites, getComite, comitesPorGrupo, comitesHijosDe,
  crearCandidato, editarCandidato, actualizarCvCandidato, borrarCandidato, listarCandidatos, getCandidato,
  candidatosConArchivo,
  marcarVoto, desmarcarVoto, votosDePersona, contarVotosPersona, resultadosDe, marcasDeComite,
  confirmar, reabrir, yaConfirmo, confirmacionesDe,
  getClave, setClave, delClave, listClaves,
  getSesionInfo, getSesion, setSesion, delSesion, delSesionesDe,
  registrarAuditoria, auditoriaDe
};
