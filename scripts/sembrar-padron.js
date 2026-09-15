#!/usr/bin/env node
/* Siembra el padrón fijo de consejerías electorales (grupo "Consejerías" +
   las 11 personas reales) en la base de datos de elecciones-web. Es idempotente
   — se puede correr varias veces sin duplicar nada — y NO toca comités ni
   candidaturas, esas se capturan por ejercicio desde el admin.

   Uso local (contra el propio servidor, con su .env):
     node scripts/sembrar-padron.js

   Uso contra un despliegue remoto (p. ej. detrás de nginx bajo una subruta):
     BASE_URL=https://sisecom.ine.mx/comites/api ADMIN_PASS=<clave> node scripts/sembrar-padron.js

   BASE_URL por default apunta a http://127.0.0.1:<PORT del .env>/api.
   ADMIN_PASS se toma del .env del proyecto si no se pasa por variable de entorno. */
require('dotenv').config();

const ADMIN_PASS = process.env.ADMIN_PASS;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3007}/api`;

if(!ADMIN_PASS){
  console.error('Falta ADMIN_PASS (en el .env del proyecto, o como variable de entorno al correr el script).');
  process.exit(1);
}

const PERSONAS = [
  'Guadalupe Taddei Zavala',
  'Arturo Castillo Loza',
  'Arturo Manuel Chávez López',
  'Blanca Yassahara Cruz García',
  'Norma Irene De La Cruz Magaña',
  'Uuc-kib Espadas Ancona',
  'José Martín Fernando Faz Mora',
  'Frida Denisse Gómez Puga',
  'Carla Astrid Humphrey Jordan',
  'Rita Bell López Vences',
  'Jorge Montaño Ventura'
];

async function api(metodo, ruta, cuerpo){
  const r = await fetch(BASE_URL + ruta, {
    method: metodo,
    headers: Object.assign({ 'Content-Type': 'application/json' }, { 'X-Admin': ADMIN_PASS }),
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(`${metodo} ${ruta} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

(async () => {
  console.log('Sembrando padrón en', BASE_URL);

  const grupos = await api('GET', '/grupos');
  let grupo = grupos.find(g => g.nombre === 'Consejerías');
  if(!grupo){
    const creado = await api('POST', '/admin/grupo', { nombre: 'Consejerías' });
    grupo = { id: creado.id };
    console.log('Grupo "Consejerías" creado, id', grupo.id);
  }else{
    console.log('Grupo "Consejerías" ya existía, id', grupo.id);
  }

  const personasActuales = await api('GET', '/personas');
  for(const nombre of PERSONAS){
    const yaExiste = personasActuales.some(p => p.nombre === nombre && p.grupo_id === grupo.id);
    if(yaExiste){ console.log('  ya existía:', nombre); continue; }
    const r = await api('POST', '/admin/persona', { nombre, grupo_id: grupo.id });
    console.log('  creada:', nombre, '(id ' + r.id + ')');
  }

  const final = await api('GET', '/personas');
  console.log('\nTotal personas en el grupo Consejerías:', final.filter(p => p.grupo_id === grupo.id).length);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
