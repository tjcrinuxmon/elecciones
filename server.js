/* Servidor de Elecciones por comités (Express + SQLite), mismo método que
   comisiones-web: se despliega con PM2 detrás de nginx.

   Modelo: grupos configurables de personas (padrón) votan por candidatos en
   los comités que les corresponden según su grupo. Voto simple (un candidato
   por comité), resultados ocultos hasta que el admin cierra y publica cada
   comité. Acceso: cada persona ELIGE su nombre y ESTABLECE su contraseña la
   primera vez; después la usa para entrar. Un token (X-Token) identifica la
   sesión: cada quien sólo puede votar por sí mismo. El administrador (clave
   en .env) gestiona grupos/personas/comités/candidatos y publica resultados. */
require('dotenv').config();
process.env.TZ = 'America/Mexico_City';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const db = require('./database');

const app  = express();
const PORT = process.env.PORT || 3007;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASS = process.env.ADMIN_PASS || 'cambia-esta-clave';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const esAdmin    = req => (req.header('X-Admin') || '') === ADMIN_PASS;
const nuevoToken = () => crypto.randomBytes(24).toString('hex');
const miPersona  = req => db.getSesion(req.header('X-Token') || '');

/* ---- Ventana de disponibilidad, por comité ----
   La hora de cierre se teclea como hora de pared de la CDMX
   ("2026-08-02T23:59"). Se ancla EXPLÍCITAMENTE a UTC-6 (CDMX es fijo, sin
   horario de verano desde 2022), de modo que la comparación NO depende de la
   zona horaria del servidor. */
const OFFSET_CDMX = '-06:00';
function parseCierreCDMX(s){
  if(!s) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s));
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${OFFSET_CDMX}`) : Date.parse(s);
}
function comiteAbierto(comite){
  if(!comite.abierto) return false;
  if(comite.cierra){
    const t = parseCierreCDMX(comite.cierra);
    if(!isNaN(t) && Date.now() > t) return false;
  }
  return true;
}

/* ---- Catálogos públicos (sin datos sensibles): necesarios para armar la
   pantalla de acceso y el panel de admin sin duplicar listas en el HTML. ---- */
app.get('/api/grupos', (req, res) => res.json(db.listarGrupos()));
app.get('/api/personas', (req, res) => res.json(db.listarPersonas()));
app.get('/api/comites', (req, res) => {
  res.json(db.listarComites().map(c => ({
    id: c.id, nombre: c.nombre, escanos: c.escanos, grupo_elector_id: c.grupo_elector_id,
    abierto: !!comiteAbierto(c), publicado: !!c.publicado
  })));
});

/* ---- Acceso de personas (primer acceso / login / sesión) ---- */
app.post('/api/persona/estado', (req, res) => {
  const { persona_id } = req.body || {};
  res.json({ tienePassword: !!db.getClave(persona_id) });
});
app.post('/api/persona/registrar', (req, res) => {
  const { persona_id, clave } = req.body || {};
  const persona = db.getPersona(persona_id);
  if(!persona) return res.status(400).json({ error: 'Persona no válida.' });
  if(!clave || String(clave).length < 8)
    return res.status(400).json({ error: 'Contraseña inválida (mínimo 8 caracteres).' });
  if(db.getClave(persona_id))
    return res.status(409).json({ error: 'Ya tiene contraseña; inicie sesión.' });
  db.setClave(persona_id, bcrypt.hashSync(String(clave), 10));
  const token = nuevoToken(); db.setSesion(token, persona_id);
  res.json({ ok: true, token });
});
app.post('/api/persona/login', (req, res) => {
  const { persona_id, clave } = req.body || {};
  const h = db.getClave(persona_id);
  if(!h) return res.status(404).json({ error: 'Aún no tiene contraseña; créela.' });
  if(!bcrypt.compareSync(String(clave || ''), h))
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  const token = nuevoToken(); db.setSesion(token, persona_id);
  res.json({ ok: true, token });
});
app.post('/api/persona/sesion', (req, res) => {
  const { token } = req.body || {};
  const id = token ? db.getSesion(token) : null;
  res.json({ ok: !!id, persona: id ? db.getPersona(id) : null });
});

/* ---- Elector: su boleta y su voto ---- */
app.get('/api/estado', (req, res) => {
  const id = miPersona(req);
  if(!id) return res.status(401).json({ error: 'Sesión no válida; vuelva a entrar.' });
  const persona = db.getPersona(id);
  const comites = db.comitesPorGrupo(persona.grupo_id).map(c => ({
    id: c.id, nombre: c.nombre, escanos: c.escanos,
    abierto: comiteAbierto(c),
    candidatos: db.listarCandidatos(c.id),
    miVoto: db.votoDe(id, c.id)
  }));
  res.json({ persona, comites });
});
app.post('/api/voto', (req, res) => {
  const id = miPersona(req);
  if(!id) return res.status(401).json({ error: 'Sesión no válida; vuelva a entrar.' });
  const { comite_id, candidato_id } = req.body || {};
  const persona = db.getPersona(id);
  const comite = db.getComite(comite_id);
  if(!comite || comite.grupo_elector_id !== persona.grupo_id)
    return res.status(403).json({ error: 'Ese comité no le corresponde.' });
  if(!comiteAbierto(comite))
    return res.status(403).json({ error: 'La votación de este comité está cerrada.' });
  const candidato = db.getCandidato(candidato_id);
  if(!candidato || candidato.comite_id !== comite.id)
    return res.status(400).json({ error: 'Candidato no válido para este comité.' });
  db.votar(id, comite.id, candidato.id);
  res.json({ ok: true });
});

/* ---- Resultados públicos (sólo si el comité ya se publicó) ---- */
app.get('/api/resultados/:comite', (req, res) => {
  const comite = db.getComite(req.params.comite);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  if(!comite.publicado && !esAdmin(req))
    return res.status(403).json({ error: 'Resultados aún no publicados.' });
  const conteo = db.resultadosDe(comite.id);
  const candidatos = db.listarCandidatos(comite.id).map(c => ({
    id: c.id, nombre: c.nombre,
    votos: (conteo.find(v => v.candidato_id === c.id) || {}).votos || 0
  })).sort((a, b) => b.votos - a.votos);
  res.json({ comite: { id: comite.id, nombre: comite.nombre, escanos: comite.escanos },
    candidatos, totalVotantes: db.votantesDe(comite.id) });
});

/* ---- Administración ---- */
app.post('/api/admin/login', (req, res) => {
  res.json({ ok: (req.body && req.body.clave) === ADMIN_PASS });
});
app.use('/api/admin', (req, res, next) => {
  if(!esAdmin(req)) return res.status(403).json({ error: 'Sólo administrador.' });
  next();
});

app.post('/api/admin/grupo', (req, res) => {
  const { nombre } = req.body || {};
  if(!nombre) return res.status(400).json({ error: 'Falta nombre.' });
  res.json({ ok: true, id: db.crearGrupo(nombre) });
});
app.put('/api/admin/grupo/:id', (req, res) => {
  db.editarGrupo(req.params.id, (req.body || {}).nombre);
  res.json({ ok: true });
});
app.delete('/api/admin/grupo/:id', (req, res) => {
  db.borrarGrupo(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/persona', (req, res) => {
  const { nombre, grupo_id } = req.body || {};
  if(!nombre || !grupo_id) return res.status(400).json({ error: 'Faltan datos.' });
  res.json({ ok: true, id: db.crearPersona(nombre, grupo_id) });
});
app.put('/api/admin/persona/:id', (req, res) => {
  const { nombre, grupo_id } = req.body || {};
  db.editarPersona(req.params.id, nombre, grupo_id);
  res.json({ ok: true });
});
app.delete('/api/admin/persona/:id', (req, res) => {
  db.borrarPersona(req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/claves', (req, res) => res.json(db.listClaves()));
app.post('/api/admin/persona/:id/reset', (req, res) => {
  db.delClave(req.params.id); db.delSesionesDe(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/comite', (req, res) => {
  const { nombre, escanos, grupo_elector_id } = req.body || {};
  if(!nombre || !grupo_elector_id) return res.status(400).json({ error: 'Faltan datos.' });
  res.json({ ok: true, id: db.crearComite(nombre, escanos || 1, grupo_elector_id) });
});
app.put('/api/admin/comite/:id', (req, res) => {
  db.editarComite(req.params.id, req.body || {});
  res.json({ ok: true });
});
app.delete('/api/admin/comite/:id', (req, res) => {
  db.borrarComite(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/candidato', (req, res) => {
  const { comite_id, nombre } = req.body || {};
  if(!comite_id || !nombre) return res.status(400).json({ error: 'Faltan datos.' });
  res.json({ ok: true, id: db.crearCandidato(comite_id, nombre) });
});
app.put('/api/admin/candidato/:id', (req, res) => {
  db.editarCandidato(req.params.id, (req.body || {}).nombre);
  res.json({ ok: true });
});
app.delete('/api/admin/candidato/:id', (req, res) => {
  db.borrarCandidato(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/resultados/:comite', (req, res) => {
  const comite = db.getComite(req.params.comite);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  const conteo = db.resultadosDe(comite.id);
  const candidatos = db.listarCandidatos(comite.id).map(c => ({
    id: c.id, nombre: c.nombre,
    votos: (conteo.find(v => v.candidato_id === c.id) || {}).votos || 0
  })).sort((a, b) => b.votos - a.votos);
  res.json({ comite, candidatos, totalVotantes: db.votantesDe(comite.id) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Recurso no encontrado.' }));
/* Cualquier error lanzado dentro de una ruta /api (validaciones de la capa de
   datos, restricciones de la base) se responde en JSON con 400 en vez de la
   página HTML por omisión de Express, que expone la ruta del servidor. */
app.use('/api', (err, req, res, next) => res.status(400).json({ error: err.message || 'Error inesperado.' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, HOST, () => console.log(
  `✅ Elecciones por comités en http://localhost:${PORT}` +
  (HOST === '127.0.0.1' ? ' (sólo local; el acceso público entra por nginx)' : '')));
