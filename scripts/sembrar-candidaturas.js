#!/usr/bin/env node
/* Siembra en el comité COTAPREP las candidaturas reales que ya están
   capturadas en producción (comisiones.sicodeaj.org/comites) — nombre,
   género, grado académico y especialidad. A propósito NO sube CV: esos se
   suben después a mano desde el admin (son archivos, no datos de texto).
   Es idempotente — no duplica candidaturas que ya existan por nombre.

   Requiere que el padrón ya exista (grupo "Consejerías"): corre primero
   scripts/sembrar-padron.js si hace falta.

   Uso local (contra el propio servidor, con su .env):
     node scripts/sembrar-candidaturas.js

   Uso contra un despliegue remoto:
     BASE_URL=https://sisecom.ine.mx/comites/api ADMIN_PASS=<clave> node scripts/sembrar-candidaturas.js */
require('dotenv').config();

const ADMIN_PASS = process.env.ADMIN_PASS;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3007}/api`;

if(!ADMIN_PASS){
  console.error('Falta ADMIN_PASS (en el .env del proyecto, o como variable de entorno al correr el script).');
  process.exit(1);
}

const NOMBRE_COMITE = 'COTAPREP';
const ESCANOS_COMITE = 7;
const CALCULAR_PARIDAD = true;

const CANDIDATURAS = [
  { nombre: 'Abel Alfredo Muñoz Pedraza', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Ciencia Política' },
  { nombre: 'Benito Gerónimo Marcos', genero: 'Hombre', grado_academico: 'Maestría', especialidad: 'Estadística y/o ciencia de datos / Investigación de Operaciones / Tecnologías de la Información y Comunicaciones / Ciencia Política' },
  { nombre: 'David Fernando Muñoz Negrón', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Investigación de Operaciones' },
  { nombre: 'Edgar Antonio Valdés Porras', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Investigación de Operaciones / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Efraín Eric Poot Capetillo', genero: 'Hombre', grado_academico: 'Maestría', especialidad: 'Ciencia Política' },
  { nombre: 'Gabriel Sánchez Pérez', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Gina Gallegos García', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Juana Canul-Reich', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Investigación de Operaciones / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Leonardo Israel Millan Garcia', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Luis Eduardo Medina Torres', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Ingestigación de Operaciones / Ciencia Política' },
  { nombre: 'María de Lourdes Guadalupe Martínez Villaseñor', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Miguel Ángel Viana Dzul', genero: 'Hombre', grado_academico: 'Maestría', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones / Ciencia Política' },
  { nombre: 'Pablo Corona Fraga', genero: 'Hombre', grado_academico: 'Maestría', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Patricia Fabiola Coutiño Osorio', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Investigación de Operaciones / Ciencia Política' },
  { nombre: 'Patricia Rayón Villela', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Paula Concepción Isiordia Lachica', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Ciencia Política' },
  { nombre: 'Rafael Pérez Pascual', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Investigación de Operaciones' },
  { nombre: 'Rosa María Mirón Lince', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Ciencia Política' },
  { nombre: 'Rosa de Guadalupe Cano Anguiano', genero: 'Mujer', grado_academico: 'Maestría', especialidad: 'Estadística y/o ciencia de datos / Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Servando Pineda Jaimes', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Ciencia Política' },
  { nombre: 'Sofía Isabel Ramírez Aguilar', genero: 'Mujer', grado_academico: 'Maestría', especialidad: 'Estadística y/o ciencia de datos / Ciencia Política' },
  { nombre: 'Victor Manuel Gonzalez y Gonzalez', genero: 'Hombre', grado_academico: 'Doctorado', especialidad: 'Tecnologías de la Información y Comunicaciones' },
  { nombre: 'Érika García Meneses', genero: 'Mujer', grado_academico: 'Doctorado', especialidad: 'Estadística y/o ciencia de datos / Investigación de Operaciones' }
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
async function apiForm(metodo, ruta, formData){
  const r = await fetch(BASE_URL + ruta, { method: metodo, headers: { 'X-Admin': ADMIN_PASS }, body: formData });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(`${metodo} ${ruta} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

(async () => {
  console.log('Sembrando candidaturas en', BASE_URL);

  const grupos = await api('GET', '/grupos');
  const grupo = grupos.find(g => g.nombre === 'Consejerías');
  if(!grupo){
    console.error('No existe el grupo "Consejerías" — corre primero scripts/sembrar-padron.js.');
    process.exit(1);
  }

  const comites = await api('GET', '/comites');
  let comite = comites.find(c => c.nombre === NOMBRE_COMITE);
  if(!comite){
    const creado = await api('POST', '/admin/comite', { nombre: NOMBRE_COMITE, escanos: ESCANOS_COMITE, grupo_elector_id: grupo.id });
    comite = { id: creado.id };
    await api('PUT', '/admin/comite/' + comite.id, { calcular_paridad: CALCULAR_PARIDAD });
    console.log(`Comité "${NOMBRE_COMITE}" creado, id ${comite.id} (escaños ${ESCANOS_COMITE}, paridad activada)`);
  }else{
    console.log(`Comité "${NOMBRE_COMITE}" ya existía, id ${comite.id}`);
  }

  const actuales = await api('GET', `/admin/candidatos/${comite.id}`);
  for(const c of CANDIDATURAS){
    if(actuales.some(x => x.nombre === c.nombre)){ console.log('  ya existía:', c.nombre); continue; }
    const fd = new FormData();
    fd.append('comite_id', comite.id);
    fd.append('nombre', c.nombre);
    fd.append('genero', c.genero);
    fd.append('grado_academico', c.grado_academico);
    fd.append('especialidad', c.especialidad);
    const r = await apiForm('POST', '/admin/candidato', fd);
    console.log('  creada:', c.nombre, '(id ' + r.id + ')');
  }

  const final = await api('GET', `/admin/candidatos/${comite.id}`);
  console.log(`\nTotal candidaturas en "${NOMBRE_COMITE}": ${final.length}`);
  console.log('Nota: los CV no se subieron — se agregan después desde el admin, por candidatura.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
