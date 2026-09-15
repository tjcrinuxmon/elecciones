/* Servidor de Elecciones por comités (Express + SQLite), mismo método que
   comisiones-web: se despliega con PM2 detrás de nginx.

   Caso de uso concreto: integración del Comité Técnico Asesor del Programa
   de Resultados Electorales Preliminares (COTAPREP) — un grupo configurable
   de personas (típicamente las
   consejerías electorales) vota por un número fijo de candidaturas igual a
   los integrantes a elegir (comite.escanos), sin repetir candidatura. El
   voto se puede corregir hasta que la persona CONFIRMA su boleta; a partir
   de ahí queda bloqueada. Los resultados se ocultan hasta que el admin
   publica el comité (a mano, o solos si revelar_al_completar y ya
   confirmaron todas las personas del grupo elector). Si hay empate en la
   frontera de los escaños, el admin puede abrir una ronda de desempate
   (un comité hijo con solo las candidaturas empatadas). Acceso: cada persona
   ELIGE su nombre y ESTABLECE su contraseña la primera vez; un token
   (X-Token) identifica la sesión. El administrador (clave en .env) gestiona
   todo con el header X-Admin. */
require('dotenv').config();
process.env.TZ = 'America/Mexico_City';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const multer  = require('multer');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('./database');

const app  = express();
const PORT = process.env.PORT || 3007;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASS = process.env.ADMIN_PASS || 'cambia-esta-clave';

/* CSP se desactiva porque la interfaz usa onclick="" en línea en todo el HTML
   (ver public/index.html); una CSP estricta con script-src 'self' rompería
   toda la interacción. El resto de cabeceras de helmet (X-Content-Type-Options,
   X-Frame-Options, Strict-Transport-Security, etc.) sí aplican. Migrar a
   addEventListener y habilitar CSP completo queda como mejora futura. */
app.use(helmet({ contentSecurityPolicy: false }));
/* En producción, fija CORS_ORIGIN en .env con el dominio real (o una lista
   separada por comas); sin definirlo, se admite cualquier origen — cómodo
   para desarrollo local, pero debe restringirse antes de exponerse a internet. */
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : true;
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* Comparación en tiempo constante para no filtrar la clave de administración
   por diferencias de tiempo entre intentos (timing attack). */
function compararSeguro(a, b){
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if(bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
const esAdmin    = req => compararSeguro(req.header('X-Admin') || '', ADMIN_PASS);
const nuevoToken = () => crypto.randomBytes(24).toString('hex');

/* Límite de intentos en los endpoints de acceso: sin esto, nada impedía
   probar contraseñas por fuerza bruta contra /api/admin/login o el login de
   cada consejería (confirmado en las pruebas de seguridad: 20 intentos
   seguidos, sin bloqueo). 20 intentos / 15 min por IP es holgado para un uso
   legítimo (alguien tecleando mal su clave) pero corta un ataque automatizado. */
const limitadorAcceso = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espere unos minutos y vuelva a intentar.' }
});

/* Control de sesiones: un token deja de ser válido pasadas SESION_TTL_MS
   horas de creado, aunque nadie haya cerrado sesión explícitamente. */
const SESION_TTL_MS = 12 * 60 * 60 * 1000;
function miPersona(req){
  const token = req.header('X-Token') || '';
  if(!token) return null;
  const info = db.getSesionInfo(token);
  if(!info) return null;
  const creado = Date.parse(info.creado.replace(' ', 'T') + OFFSET_CDMX);
  if(!isNaN(creado) && Date.now() - creado > SESION_TTL_MS){
    db.delSesion(token);
    return null;
  }
  return info.persona_id;
}

/* ---- Almacén de CVs (PDF) ----
   Se sirven por una ruta propia (no express.static) porque el CV es un dato
   de la candidatura reservado a personas usuarias autenticadas — igual que
   el resto de la API, exige X-Token o X-Admin; no es de acceso público. */
const CV_DIR = path.join(__dirname, 'uploads', 'cv');
fs.mkdirSync(CV_DIR, { recursive: true });
/* Sin "/" inicial: relativa a la página actual, para que funcione igual
   montada en la raíz (local) o bajo una subruta en producción (ver API en
   public/index.html para la misma razón). */
const cvUrl = filename => filename ? 'uploads/cv/' + filename : null;
/* Los nombres de archivo siempre los genera el propio servidor
   (crypto.randomBytes(16).toString('hex') + '.pdf', ver uploadCv más abajo),
   así que solo se acepta ese patrón exacto: cierra la puerta a path traversal
   (p. ej. "..%2f..%2fserver.js") sin depender únicamente de path.join/sendFile,
   que por sí solos NO confinan la ruta si el nombre trae "..". */
const NOMBRE_CV_VALIDO = /^[0-9a-f]{32}\.pdf$/;
app.get('/uploads/cv/:filename', (req, res) => {
  if(!esAdmin(req) && !miPersona(req))
    return res.status(401).json({ error: 'Debe iniciar sesión para consultar este documento.' });
  if(!NOMBRE_CV_VALIDO.test(req.params.filename))
    return res.status(400).json({ error: 'Nombre de archivo no válido.' });
  res.type('application/pdf');
  res.sendFile(req.params.filename, { root: CV_DIR }, err => {
    if(err && !res.headersSent) res.status(404).json({ error: 'Documento no encontrado.' });
  });
});
const uploadCv = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CV_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.pdf')
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if(file.mimetype !== 'application/pdf') return cb(new Error('El CV debe ser un archivo PDF.'));
    cb(null, true);
  }
});
/* multer.fileFilter solo valida el mimetype que DECLARA el navegador, que
   cualquiera puede falsificar (confirmado en pruebas de seguridad: un .html
   subido como si fuera PDF se aceptó igual). Esta segunda validación revisa
   la firma real del archivo ya guardado (los PDF empiezan con "%PDF-") y
   borra el archivo si no coincide. Servir el CV siempre forzando
   Content-Type: application/pdf (ver /uploads/cv/:filename) ya mitigaba el
   riesgo de que el navegador lo interprete como HTML/script, pero igual no
   tiene sentido guardar en el sistema un archivo que dice ser CV y no lo es. */
function esPdfValido(filePath){
  try{
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === '%PDF-';
  }catch(e){ return false; }
}

/* Borra el PDF en disco solo si ningún otro candidato (p. ej. una copia
   hecha al abrir una ronda de desempate) sigue apuntando al mismo archivo. */
function borrarCvSiHuerfano(cv_filename){
  if(!cv_filename) return;
  if(db.candidatosConArchivo(cv_filename) <= 1) fs.unlink(path.join(CV_DIR, cv_filename), () => {});
}

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
  if(comite.abre){
    const t = parseCierreCDMX(comite.abre);
    if(!isNaN(t) && Date.now() < t) return false;
  }
  if(comite.cierra){
    const t = parseCierreCDMX(comite.cierra);
    if(!isNaN(t) && Date.now() > t) return false;
  }
  return true;
}

/* ---- Cómputo: ordena candidaturas, decide electas y detecta empate en la
   frontera de `escanos`. Se reutiliza para la matriz, los resultados
   públicos, el desempate y el acta. ---- */
function calcularResultado(comite_id){
  const comite = db.getComite(comite_id);
  const conteo = db.resultadosDe(comite_id);
  const conMap = {}; conteo.forEach(c => { conMap[c.candidato_id] = c.votos; });
  const ordenados = db.listarCandidatos(comite_id)
    .map(c => Object.assign({}, c, { votos: conMap[c.id] || 0 }))
    .sort((a, b) => b.votos - a.votos);
  const escanos = comite.escanos;
  /* Una candidatura con 0 votos nunca debe contar como electa ni como
     empatada: un empate implica contención real por un lugar, y 0 votos es
     ausencia total de apoyo, no una disputa. Sin este filtro, si todavía
     no vota la mayoría de las consejerías, el corte podía caer en 0 y
     marcar como "empatadas" a todas las candidaturas sin un solo voto. */
  const conVotos = ordenados.filter(c => c.votos > 0);
  let electos = [], empatados = [], plazasRestantes = 0;
  if(conVotos.length <= escanos){
    electos = conVotos.slice();
  }else{
    const corte = conVotos[escanos - 1].votos;
    const porEncima = conVotos.filter(c => c.votos > corte);
    const enCorte    = conVotos.filter(c => c.votos === corte);
    plazasRestantes = escanos - porEncima.length;
    if(enCorte.length <= plazasRestantes){
      electos = porEncima.concat(enCorte);
      plazasRestantes = 0;
    }else{
      electos = porEncima;
      empatados = enCorte;
    }
  }
  return { comite, ordenados, electos, empatados, plazasRestantes };
}
/* Combina el comité con su última ronda de desempate (si existe) para la
   lista final de electos del acta. Solo un nivel: si esa ronda a su vez
   empató, el admin abre otra y el acta hay que sacarla ya sobre esa. */
function calcularActaCompleta(comite_id){
  const base = calcularResultado(comite_id);
  let electosFinal = base.electos.slice();
  let desempate = null;
  const hijos = db.comitesHijosDe(comite_id);
  if(hijos.length){
    const hijo = hijos[hijos.length - 1];
    const rHijo = calcularResultado(hijo.id);
    desempate = { comite: hijo, resultado: rHijo };
    electosFinal = electosFinal.concat(rHijo.electos);
  }
  return { base, desempate, electosFinal };
}
/* "Empate" solo aparece para quienes de verdad compiten por un lugar
   restante (así se calcula empatados); cualquier otra candidatura que no
   quedó electa debe decir explícitamente "No electo", no quedar en blanco. */
function estadoCandidatura(c, resultado){
  return resultado.electos.some(x => x.id === c.id) ? 'Candidatura electa'
    : (resultado.empatados.some(x => x.id === c.id) ? 'Empate' : 'Candidatura no electa');
}

/* Regla de paridad tal como la definió el usuario: es paritaria si los
   hombres no superan a las mujeres por más de 1 (incluye mayoría de mujeres
   o integración total de mujeres); cualquier otra combinación (2 hombres
   más que mujeres, o más) es no paritaria. Las candidaturas electas sin
   "genero" capturado no cuentan en ningún lado, así que se reportan aparte. */
function calcularParidad(electos){
  const mujeres = electos.filter(c => c.genero === 'Mujer').length;
  const hombres = electos.filter(c => c.genero === 'Hombre').length;
  const sinCapturar = electos.length - mujeres - hombres;
  return { mujeres, hombres, sinCapturar, esParitaria: (hombres - mujeres) <= 1 };
}

/* ---- PDF del acta: paleta oficial INE 2026 y una tabla dibujada a mano
   (pdfkit no trae tablas). LOGO_PNG es una rasterización del SVG oficial
   (public/logo-ine.svg) generada una sola vez con Playwright — pdfkit no
   puede insertar SVG directo. */
const INE_PDF = { lila: '#674092', lilaOsc: '#49276F', gris: '#6b6f7a', filaAlt: '#f5f1fa' };
const LOGO_PNG = path.join(__dirname, 'assets', 'logo-ine.png');

function dibujarEncabezadoPdf(doc, titulo){
  if(fs.existsSync(LOGO_PNG)) doc.image(LOGO_PNG, doc.page.margins.left, doc.y, { width: 110 });
  doc.fillColor(INE_PDF.lila).font('Helvetica-Bold').fontSize(15)
    .text(titulo, doc.page.margins.left + 130, doc.y - 6, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 130 });
  doc.moveDown(2.2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(2).strokeColor(INE_PDF.lila).stroke();
  doc.moveDown(0.8);
  doc.x = doc.page.margins.left;
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
}

/* Tabla simple con encabezado en lila y filas alternadas; la altura de cada
   renglón se mide según su contenido (para que un texto largo que hace
   wrap, como un grado académico largo, no se encime con el siguiente
   renglón) y salta de página sola, repitiendo el encabezado, si no alcanza
   el espacio. */
function dibujarTabla(doc, columnas, widths, filas){
  const startX = doc.page.margins.left;
  const anchoTotal = widths.reduce((a, b) => a + b, 0);
  const padX = 6, padY = 4;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  function altoDe(valores, negritas){
    doc.font(negritas ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    return Math.max(...valores.map((v, i) => doc.heightOfString(String(v), { width: widths[i] - padX * 2 }))) + padY * 2;
  }
  function pintar(valores, y, alto, negritas, fondo){
    if(fondo) doc.rect(startX, y, anchoTotal, alto).fill(fondo);
    let x = startX;
    doc.font(negritas ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(negritas ? '#ffffff' : '#000000');
    valores.forEach((v, i) => { doc.text(String(v), x + padX, y + padY, { width: widths[i] - padX * 2 }); x += widths[i]; });
  }

  let y = doc.y;
  let alto = altoDe(columnas, true);
  pintar(columnas, y, alto, true, INE_PDF.lila);
  y += alto;

  filas.forEach((fila, idx) => {
    const altoFila = altoDe(fila, false);
    if(y + altoFila > pageBottom){
      doc.addPage();
      y = doc.page.margins.top;
      const altoEnc = altoDe(columnas, true);
      pintar(columnas, y, altoEnc, true, INE_PDF.lila);
      y += altoEnc;
    }
    pintar(fila, y, altoFila, false, idx % 2 === 1 ? INE_PDF.filaAlt : null);
    y += altoFila;
  });

  doc.x = startX;
  doc.y = y + 14;
  doc.fillColor('#000000');
}

/* ---- Catálogos públicos (sin datos sensibles) ---- */
app.get('/api/grupos', (req, res) => res.json(db.listarGrupos()));
app.get('/api/personas', (req, res) => res.json(db.listarPersonas()));
app.get('/api/comites', (req, res) => {
  res.json(db.listarComites().map(c => ({
    id: c.id, nombre: c.nombre, escanos: c.escanos, grupo_elector_id: c.grupo_elector_id,
    abierto: !!comiteAbierto(c), abre: c.abre, cierra: c.cierra,
    publicado: !!c.publicado, comite_padre_id: c.comite_padre_id,
    revelar_al_completar: !!c.revelar_al_completar, calcular_paridad: !!c.calcular_paridad
  })));
});

/* ---- Acceso de personas (primer acceso / login / sesión) ---- */
app.post('/api/persona/estado', (req, res) => {
  const { persona_id } = req.body || {};
  res.json({ tienePassword: !!db.getClave(persona_id) });
});
app.post('/api/persona/registrar', limitadorAcceso, (req, res) => {
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
app.post('/api/persona/login', limitadorAcceso, (req, res) => {
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
app.post('/api/persona/salir', (req, res) => {
  const token = req.header('X-Token') || '';
  if(token) db.delSesion(token);
  res.json({ ok: true });
});

/* ---- Elector: su boleta y su voto ---- */
app.get('/api/estado', (req, res) => {
  const id = miPersona(req);
  if(!id) return res.status(401).json({ error: 'Sesión no válida; vuelva a entrar.' });
  const persona = db.getPersona(id);
  const comites = db.comitesPorGrupo(persona.grupo_id)
    /* Una ronda de desempate (comite_padre_id) es una decisión del admin: no
       se le muestra a las personas electoras sino hasta que el admin la abre
       a propósito (botón "Abrir" en Comités), aunque ya exista creada. El
       comité principal sigue mostrándose siempre, abierto o cerrado. */
    .filter(c => !c.comite_padre_id || comiteAbierto(c))
    .map(c => ({
    id: c.id, nombre: c.nombre, escanos: c.escanos,
    abierto: comiteAbierto(c),
    confirmado: db.yaConfirmo(id, c.id),
    candidatos: db.listarCandidatos(c.id).map(cand => ({
      id: cand.id, nombre: cand.nombre, genero: cand.genero, grado_academico: cand.grado_academico, especialidad: cand.especialidad,
      cv_texto: cand.cv_texto, cv_url: cvUrl(cand.cv_filename)
    })),
    misVotos: db.votosDePersona(id, c.id)
  }));
  res.json({ persona, comites });
});
app.post('/api/voto', (req, res) => {
  const id = miPersona(req);
  if(!id) return res.status(401).json({ error: 'Sesión no válida; vuelva a entrar.' });
  const { comite_id, candidato_id, marcar } = req.body || {};
  const persona = db.getPersona(id);
  const comite = db.getComite(comite_id);
  if(!comite || comite.grupo_elector_id !== persona.grupo_id)
    return res.status(403).json({ error: 'Ese comité no le corresponde.' });
  if(!comiteAbierto(comite))
    return res.status(403).json({ error: 'La votación de este comité está cerrada.' });
  if(db.yaConfirmo(id, comite.id))
    return res.status(403).json({ error: 'Ya confirmó su votación; no se puede modificar.' });
  const candidato = db.getCandidato(candidato_id);
  if(!candidato || candidato.comite_id !== comite.id)
    return res.status(400).json({ error: 'Candidatura no válida para este comité.' });
  if(marcar){
    if(db.contarVotosPersona(id, comite.id) >= comite.escanos)
      return res.status(400).json({ error: `Ya emitió sus ${comite.escanos} votos.` });
    db.marcarVoto(id, comite.id, candidato.id);
  }else{
    db.desmarcarVoto(id, comite.id, candidato.id);
  }
  db.registrarAuditoria(`persona:${id}`, marcar ? 'voto_marcar' : 'voto_desmarcar', comite.id, { candidato_id: candidato.id, candidato: candidato.nombre });
  res.json({ ok: true, misVotos: db.votosDePersona(id, comite.id) });
});
app.post('/api/voto/confirmar', (req, res) => {
  const id = miPersona(req);
  if(!id) return res.status(401).json({ error: 'Sesión no válida; vuelva a entrar.' });
  const { comite_id, permitir_incompleto } = req.body || {};
  const persona = db.getPersona(id);
  const comite = db.getComite(comite_id);
  if(!comite || comite.grupo_elector_id !== persona.grupo_id)
    return res.status(403).json({ error: 'Ese comité no le corresponde.' });
  if(!comiteAbierto(comite))
    return res.status(403).json({ error: 'La votación de este comité está cerrada.' });
  if(db.yaConfirmo(id, comite.id))
    return res.status(409).json({ error: 'Ya había confirmado su votación.' });
  const n = db.contarVotosPersona(id, comite.id);
  if(n < comite.escanos && !permitir_incompleto)
    return res.status(400).json({ incompleto: true, error: `Solo marcó ${n} de ${comite.escanos} votos.` });
  db.confirmar(id, comite.id);
  db.registrarAuditoria(`persona:${id}`, 'confirmar', comite.id, null);
  if(comite.revelar_al_completar){
    const total = db.personasDeGrupo(comite.grupo_elector_id).length;
    const confirmadas = db.confirmacionesDe(comite.id).length;
    if(confirmadas >= total){
      db.editarComite(comite.id, { publicado: true });
      db.registrarAuditoria('sistema', 'resultados_publicados', comite.id, { motivo: 'revelar_al_completar' });
    }
  }
  res.json({ ok: true });
});
/* Deshace su propia confirmación para poder corregir su boleta (p. ej. si se
   equivocó). El comité debe seguir abierto; sus votos anteriores quedan tal
   cual, solo se desbloquean para poder cambiarlos. */
app.post('/api/voto/reabrir', (req, res) => {
  const id = miPersona(req);
  if(!id) return res.status(401).json({ error: 'Sesión no válida; vuelva a entrar.' });
  const { comite_id } = req.body || {};
  const persona = db.getPersona(id);
  const comite = db.getComite(comite_id);
  if(!comite || comite.grupo_elector_id !== persona.grupo_id)
    return res.status(403).json({ error: 'Ese comité no le corresponde.' });
  if(!comiteAbierto(comite))
    return res.status(403).json({ error: 'La votación de este comité está cerrada; no se puede modificar.' });
  db.reabrir(id, comite.id);
  db.registrarAuditoria(`persona:${id}`, 'reabrir_propia', comite.id, null);
  res.json({ ok: true });
});

/* ---- Resultados públicos (solo si el comité ya se publicó) ---- */
app.get('/api/resultados/:comite', (req, res) => {
  const comite = db.getComite(req.params.comite);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  if(!comite.publicado && !esAdmin(req))
    return res.status(403).json({ error: 'Resultados aún no publicados.' });
  const r = calcularResultado(comite.id);
  res.json({
    comite: { id: comite.id, nombre: comite.nombre, escanos: comite.escanos },
    candidatos: r.ordenados.map(c => ({
      id: c.id, nombre: c.nombre, genero: c.genero, grado_academico: c.grado_academico, especialidad: c.especialidad, votos: c.votos,
      electo: r.electos.some(e => e.id === c.id), empatado: r.empatados.some(e => e.id === c.id)
    })),
    plazasRestantes: r.plazasRestantes
  });
});

/* ---- Administración ---- */
app.post('/api/admin/login', limitadorAcceso, (req, res) => {
  res.json({ ok: compararSeguro((req.body && req.body.clave) || '', ADMIN_PASS) });
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
  const antes = db.getComite(req.params.id);
  const datos = req.body || {};
  db.editarComite(req.params.id, datos);
  if(antes && datos.abierto !== undefined && !!datos.abierto !== !!antes.abierto)
    db.registrarAuditoria('admin', datos.abierto ? 'comite_abierto' : 'comite_cerrado', antes.id, null);
  if(antes && datos.publicado !== undefined && !!datos.publicado !== !!antes.publicado)
    db.registrarAuditoria('admin', datos.publicado ? 'resultados_publicados' : 'resultados_ocultados', antes.id, null);
  if(antes && (datos.abre !== undefined || datos.cierra !== undefined))
    db.registrarAuditoria('admin', 'ventana_votacion_editada', antes.id, { abre: datos.abre ?? antes.abre, cierra: datos.cierra ?? antes.cierra });
  res.json({ ok: true });
});
app.delete('/api/admin/comite/:id', (req, res) => {
  db.borrarComite(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/candidatos/:comite', (req, res) => {
  res.json(db.listarCandidatos(req.params.comite).map(c => Object.assign({}, c, { cv_url: cvUrl(c.cv_filename) })));
});
app.post('/api/admin/candidato', uploadCv.single('cv'), (req, res) => {
  const { comite_id, nombre, genero, grado_academico, especialidad, cv_texto } = req.body || {};
  if(!comite_id || !nombre) return res.status(400).json({ error: 'Faltan datos.' });
  if(req.file && !esPdfValido(req.file.path)){
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'El archivo no es un PDF válido.' });
  }
  const id = db.crearCandidato(Number(comite_id), nombre, genero, grado_academico, especialidad, cv_texto,
    req.file ? req.file.filename : null, req.file ? req.file.originalname : null);
  res.json({ ok: true, id });
});
app.put('/api/admin/candidato/:id', uploadCv.single('cv'), (req, res) => {
  const candidato = db.getCandidato(req.params.id);
  if(!candidato) return res.status(404).json({ error: 'Candidatura no encontrada.' });
  if(req.file && !esPdfValido(req.file.path)){
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'El archivo no es un PDF válido.' });
  }
  const { nombre, genero, grado_academico, especialidad, cv_texto } = req.body || {};
  db.editarCandidato(req.params.id, nombre, genero, grado_academico, especialidad, cv_texto);
  if(req.file){
    borrarCvSiHuerfano(candidato.cv_filename);
    db.actualizarCvCandidato(req.params.id, req.file.filename, req.file.originalname);
  }
  res.json({ ok: true });
});
app.delete('/api/admin/candidato/:id', (req, res) => {
  const candidato = db.getCandidato(req.params.id);
  if(candidato) borrarCvSiHuerfano(candidato.cv_filename);
  db.borrarCandidato(req.params.id);
  res.json({ ok: true });
});

/* Matriz de cómputo: candidaturas × personas del grupo elector, con marcas,
   totales, electas y empatadas en la frontera de `escanos`. */
app.get('/api/admin/matriz/:comite', (req, res) => {
  const comite = db.getComite(req.params.comite);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  const r = calcularResultado(comite.id);
  const personas = db.personasDeGrupo(comite.grupo_elector_id);
  const confirmadas = new Set(db.confirmacionesDe(comite.id).map(c => c.persona_id));
  /* Orden fijo (alfabético, el mismo de listarCandidatos) en vez de por votos:
     así las filas no cambian de lugar cada vez que el admin marca o desmarca
     un voto en la matriz — solo se actualiza la marca, el total y el estado
     de esa fila, sin que "brinque" de posición. */
  res.json({
    comite,
    candidatos: db.listarCandidatos(comite.id).map(c => {
      const conteo = r.ordenados.find(x => x.id === c.id);
      return {
        id: c.id, nombre: c.nombre, genero: c.genero, grado_academico: c.grado_academico, especialidad: c.especialidad,
        cv_texto: c.cv_texto, cv_url: cvUrl(c.cv_filename), votos: conteo ? conteo.votos : 0,
        electo: r.electos.some(e => e.id === c.id), empatado: r.empatados.some(e => e.id === c.id)
      };
    }),
    personas: personas.map(p => ({ id: p.id, nombre: p.nombre, confirmado: confirmadas.has(p.id) })),
    marcas: db.marcasDeComite(comite.id),
    plazasRestantes: r.plazasRestantes,
    hijos: db.comitesHijosDe(comite.id),
    /* Solo se calcula y se manda si el comité lo tiene activado — si está
       apagado, ni siquiera se expone el dato (nada que mostrar ni de qué
       advertir en el cliente). */
    paridad: comite.calcular_paridad ? calcularParidad(r.electos) : null
  });
});

/* Corrección de votos: el admin puede marcar o desmarcar directo en la
   matriz (p. ej. para capturar una boleta física o corregir un error), sin
   las restricciones de sesión/comité-abierto/ya-confirmó que aplican a las
   personas electoras. Sigue respetando el límite de `escanos` por persona. */
app.post('/api/admin/voto', (req, res) => {
  const { persona_id, comite_id, candidato_id, marcar } = req.body || {};
  const persona = db.getPersona(persona_id);
  const comite = db.getComite(comite_id);
  if(!persona || !comite || comite.grupo_elector_id !== persona.grupo_id)
    return res.status(400).json({ error: 'Esa persona no pertenece al grupo elector de este comité.' });
  const candidato = db.getCandidato(candidato_id);
  if(!candidato || candidato.comite_id !== comite.id)
    return res.status(400).json({ error: 'Candidatura no válida para este comité.' });
  if(marcar){
    if(db.contarVotosPersona(persona_id, comite.id) >= comite.escanos)
      return res.status(400).json({ error: `${persona.nombre} ya votó ${comite.escanos} ${comite.escanos === 1 ? 'vez' : 'veces'}; quita uno de sus votos primero para poder cambiarlo.` });
    db.marcarVoto(persona_id, comite.id, candidato.id);
  }else{
    db.desmarcarVoto(persona_id, comite.id, candidato.id);
  }
  db.registrarAuditoria('admin', marcar ? 'voto_marcar_admin' : 'voto_desmarcar_admin', comite.id,
    { persona_id: persona.id, persona: persona.nombre, candidato_id: candidato.id, candidato: candidato.nombre });
  res.json({ ok: true });
});

/* La boleta de una persona en particular, vista desde el admin — mismos datos
   que vería ella en /api/estado, para acompañarla si se le dificulta o se
   confunde con el sistema. */
app.get('/api/admin/boleta/:comite/:persona', (req, res) => {
  const comite = db.getComite(req.params.comite);
  const persona = db.getPersona(req.params.persona);
  if(!comite || !persona || comite.grupo_elector_id !== persona.grupo_id)
    return res.status(404).json({ error: 'Persona o comité no encontrados para esta combinación.' });
  res.json({
    persona,
    comite: { id: comite.id, nombre: comite.nombre, escanos: comite.escanos, abierto: comiteAbierto(comite) },
    confirmado: db.yaConfirmo(persona.id, comite.id),
    candidatos: db.listarCandidatos(comite.id).map(cand => ({
      id: cand.id, nombre: cand.nombre, genero: cand.genero, grado_academico: cand.grado_academico, especialidad: cand.especialidad,
      cv_url: cvUrl(cand.cv_filename)
    })),
    misVotos: db.votosDePersona(persona.id, comite.id)
  });
});
/* Admin: reabre la boleta de una persona específica (p. ej. a petición de
   ella misma si ya confirmó y se equivocó), sin pasar por su sesión. */
app.post('/api/admin/voto/reabrir', (req, res) => {
  const { persona_id, comite_id } = req.body || {};
  const persona = db.getPersona(persona_id);
  db.reabrir(persona_id, comite_id);
  db.registrarAuditoria('admin', 'reabrir_admin', Number(comite_id), { persona_id, persona: persona ? persona.nombre : null });
  res.json({ ok: true });
});

/* Bitácora de auditoría de un comité: fecha/hora, actor y acción de cada
   actuación relevante (votos, confirmaciones, reaperturas, apertura/cierre
   del periodo de votación, publicación y generación de actas), para poder
   reconstruir la secuencia de eventos y verificar la integridad del proceso. */
app.get('/api/admin/auditoria/:comite', (req, res) => {
  res.json(db.auditoriaDe(req.params.comite));
});

app.post('/api/admin/comite/:id/desempate', (req, res) => {
  const comite = db.getComite(req.params.id);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  const r = calcularResultado(comite.id);
  if(!r.empatados.length) return res.status(400).json({ error: 'No hay empate que resolver.' });
  const hijoId = db.crearComite(comite.nombre + ' — Desempate', r.plazasRestantes, comite.grupo_elector_id, comite.id);
  /* Nace cerrada a propósito: el admin la abre desde Comités cuando esté
     listo para que las personas electoras voten ahí. */
  db.editarComite(hijoId, { abierto: false });
  r.empatados.forEach(c => {
    db.crearCandidato(hijoId, c.nombre, c.genero, c.grado_academico, c.especialidad, c.cv_texto, c.cv_filename, c.cv_nombre_original);
  });
  db.registrarAuditoria('admin', 'desempate_creado', comite.id, { hijo_id: hijoId, candidaturas: r.empatados.map(c => c.nombre) });
  res.json({ ok: true, id: hijoId });
});

/* Reinicia la votación de un comité desde cero: borra todos los votos y
   confirmaciones (no el comité ni sus candidaturas), para volver a votar
   —p. ej. tras hacer pruebas—. El comité y sus candidaturas se conservan. */
app.post('/api/admin/comite/:id/borrar-votos', (req, res) => {
  const comite = db.getComite(req.params.id);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  db.borrarVotosDeComite(comite.id);
  db.registrarAuditoria('admin', 'votos_borrados', comite.id, null);
  res.json({ ok: true });
});

function fechaGeneracion(){
  return new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' }) + ' (CDMX)';
}

/* Acta exportable: cómputo y candidaturas electas (combina la ronda de
   desempate más reciente, si existe), con la identidad institucional del INE
   y los datos que identifican el proceso de votación al que corresponde
   (comité, id, fecha y hora de generación). */
app.get('/api/admin/acta/:comite/xlsx', async (req, res) => {
  const comite = db.getComite(req.params.comite);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  const { base, electosFinal } = calcularActaCompleta(comite.id);
  const generado = fechaGeneracion();

  const wb = new ExcelJS.Workbook();
  const logoId = fs.existsSync(LOGO_PNG) ? wb.addImage({ filename: LOGO_PNG, extension: 'png' }) : null;
  const FILL_LILA = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF674092' } };
  const FILL_ALT  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3EEFB' } };
  const FONT_BLANCO = { bold: true, color: { argb: 'FFFFFFFF' } };
  const FONT_TITULO = { bold: true, size: 13, color: { argb: 'FF49276F' } };
  const FONT_TENUE  = { italic: true, size: 9, color: { argb: 'FF6B6F7A' } };
  const BORDE = { style: 'thin', color: { argb: 'FFE2D9F1' } };

  function nuevaHoja(nombre, titulo, columnas, anchos){
    const ws = wb.addWorksheet(nombre);
    ws.columns = anchos.map(w => ({ width: w }));
    if(logoId !== null) ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 54 } });
    ws.mergeCells(1, 3, 2, Math.max(6, columnas.length));
    const celdaTitulo = ws.getCell(1, 3);
    celdaTitulo.value = titulo;
    celdaTitulo.font = FONT_TITULO;
    celdaTitulo.alignment = { vertical: 'middle' };
    ws.mergeCells(3, 3, 3, Math.max(6, columnas.length));
    const celdaMeta = ws.getCell(3, 3);
    celdaMeta.value = `Generado: ${generado}`;
    celdaMeta.font = FONT_TENUE;
    ws.getRow(1).height = 26; ws.getRow(2).height = 26; ws.getRow(3).height = 16;
    const fila = ws.getRow(5);
    fila.values = columnas;
    fila.eachCell(c => { c.fill = FILL_LILA; c.font = FONT_BLANCO; c.border = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE }; });
    return ws;
  }

  const s1 = nuevaHoja('Cómputo', `Cómputo — ${comite.nombre}`,
    ['Candidatura', 'Grado académico', 'Votos', 'Estado'], [32, 20, 8, 22]);
  base.ordenados.forEach((c, i) => {
    const fila = s1.addRow([c.nombre, c.grado_academico || '', c.votos, estadoCandidatura(c, base)]);
    fila.eachCell(cell => { cell.border = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE }; if(i % 2 === 1) cell.fill = FILL_ALT; });
  });

  const s2 = nuevaHoja('Electos', `Candidaturas electas — ${comite.nombre}`,
    ['Candidatura', 'Grado académico', 'Votos'], [32, 26, 10]);
  electosFinal.forEach((c, i) => {
    const fila = s2.addRow([c.nombre, c.grado_academico || '', c.votos]);
    fila.eachCell(cell => { cell.border = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE }; if(i % 2 === 1) cell.fill = FILL_ALT; });
  });

  db.registrarAuditoria('admin', 'acta_generada', comite.id, { formato: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="acta-${comite.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
app.get('/api/admin/acta/:comite/pdf', (req, res) => {
  const comite = db.getComite(req.params.comite);
  if(!comite) return res.status(404).json({ error: 'Comité no encontrado.' });
  const { base, desempate, electosFinal } = calcularActaCompleta(comite.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="acta-${comite.id}.pdf"`);
  const doc = new PDFDocument({ margin: 40, size: 'letter' });
  doc.pipe(res);

  dibujarEncabezadoPdf(doc, 'Acta de integración — ' + comite.nombre);
  doc.fontSize(10).fillColor(INE_PDF.gris).text(`Escaños a integrar: ${comite.escanos} · Generado: ${fechaGeneracion()}`);
  doc.moveDown(1);

  doc.fillColor(INE_PDF.lilaOsc).font('Helvetica-Bold').fontSize(12).text('Cómputo (mayor a menor)');
  doc.moveDown(0.4);
  dibujarTabla(doc,
    ['Candidatura', 'Grado académico', 'Votos', 'Estado'],
    [180, 130, 40, 150],
    base.ordenados.map(c => [c.nombre, c.grado_academico || '', c.votos, estadoCandidatura(c, base)])
  );

  if(desempate){
    doc.fillColor(INE_PDF.lilaOsc).font('Helvetica-Bold').fontSize(12).text('Ronda de desempate — ' + desempate.comite.nombre);
    doc.moveDown(0.4);
    dibujarTabla(doc,
      ['Candidatura', 'Votos', 'Estado'],
      [300, 50, 150],
      desempate.resultado.ordenados.map(c => [c.nombre, c.votos, estadoCandidatura(c, desempate.resultado)])
    );
  }

  doc.addPage();
  dibujarEncabezadoPdf(doc, 'Candidaturas electas — ' + comite.nombre);
  doc.moveDown(0.4);
  electosFinal.forEach(c => {
    doc.circle(doc.page.margins.left + 4, doc.y + 5, 3).fill(INE_PDF.lila);
    doc.fillColor('#000000').font('Helvetica').fontSize(11).text(c.nombre, doc.page.margins.left + 16, doc.y - 4);
    doc.moveDown(0.5);
  });

  db.registrarAuditoria('admin', 'acta_generada', comite.id, { formato: 'pdf' });
  doc.end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Recurso no encontrado.' }));
/* Cualquier error lanzado dentro de una ruta /api (validaciones de la capa de
   datos, restricciones de la base, multer rechazando un archivo que no es
   PDF) se responde en JSON con 400 en vez de la página HTML por omisión de
   Express, que expone la ruta del servidor. */
app.use('/api', (err, req, res, next) => res.status(400).json({ error: err.message || 'Error inesperado.' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, HOST, () => console.log(
  `✅ Elecciones por comités en http://localhost:${PORT}` +
  (HOST === '127.0.0.1' ? ' (sólo local; el acceso público entra por nginx)' : '')));
