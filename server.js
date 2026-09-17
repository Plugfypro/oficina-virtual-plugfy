import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 4321);
const offlineTimeout = Number(process.env.OFFLINE_TIMEOUT_MS || 30000);
const ceoPanelToken = String(process.env.CEO_PANEL_TOKEN || '');
const heartbeatToken = String(process.env.HEARTBEAT_TOKEN || '');
const SESSION_COOKIE = 'miniverse_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function createSession() {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessions();
  return id;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Para endpoints de LECTURA llamados tanto por el navegador (sesion o token
// del CEO) como por automatizaciones de servidor a servidor (n8n, etc. --
// nunca tienen cookie de sesion). Acepta cualquiera de los tres. El panel
// real solo usa el token del CEO (isAuthorized) -- exigir ademas una sesion
// por cookie que el frontend nunca establece dejaba estos endpoints
// devolviendo 401 en silencio (metricas, flyers, auditorias, reportes...).
// Las paginas HTML y el WebSocket siguen siendo solo-sesion (isLoggedIn).
function isLoggedInOrAutomation(req) {
  if (isLoggedIn(req)) return true;
  if (isAuthorized(req)) return true;
  if (!heartbeatToken) return false;
  return req.headers['x-heartbeat-token'] === heartbeatToken;
}

function isLoggedIn(req) {
  if (!adminEmail || !adminPasswordHash) return false;
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

function renderLoginHtml(error) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Acceso — Oficina Virtual</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;font-family:Arial,sans-serif;}
  form{background:#161616;padding:32px;border-radius:12px;width:320px;border:1px solid #2a2a2a;}
  h1{color:#e5c76b;font-size:20px;margin:0 0 20px;}
  label{color:#aaa;font-size:13px;display:block;margin:12px 0 4px;}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #333;background:#0f0f0f;color:#fff;font-size:14px;}
  .pwd-wrap{position:relative;}
  .pwd-wrap input{padding-right:36px;}
  .pwd-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#888;cursor:pointer;font-size:16px;width:auto;margin:0;padding:2px 4px;}
  button[type="submit"]{width:100%;margin-top:20px;padding:11px;border:none;border-radius:6px;background:#e5c76b;color:#111;font-weight:bold;cursor:pointer;font-size:14px;}
  .error{color:#ff6b6b;font-size:13px;margin-top:12px;}
  .setup-hint{color:#888;font-size:12px;margin-top:16px;text-align:center;}
  .setup-hint a{color:#e5c76b;}
</style></head><body>
<form method="POST" action="/login">
  <h1>Oficina Virtual — Acceso</h1>
  <label>Email</label>
  <input type="email" name="email" required autofocus>
  <label>Contraseña</label>
  <div class="pwd-wrap">
    <input type="password" name="password" id="pwd" required>
    <button type="button" class="pwd-toggle" onclick="const p=document.getElementById('pwd');p.type=p.type==='password'?'text':'password';this.textContent=p.type==='password'?'👁':'🙈';">👁</button>
  </div>
  <button type="submit">Entrar</button>
  ${error ? '<div class="error">Email o contraseña incorrectos.</div>' : ''}
  ${!isAdminConfigured() ? '<div class="setup-hint">¿Primera vez? <a href="/setup">Configura tu acceso</a></div>' : ''}
</form>
</body></html>`;
}

function renderSetupHtml(error) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Configurar acceso — Oficina Virtual</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;font-family:Arial,sans-serif;}
  form{background:#161616;padding:32px;border-radius:12px;width:340px;border:1px solid #2a2a2a;}
  h1{color:#e5c76b;font-size:20px;margin:0 0 8px;}
  p{color:#888;font-size:13px;margin:0 0 16px;line-height:1.4;}
  label{color:#aaa;font-size:13px;display:block;margin:12px 0 4px;}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #333;background:#0f0f0f;color:#fff;font-size:14px;}
  .pwd-wrap{position:relative;}
  .pwd-wrap input{padding-right:36px;}
  .pwd-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#888;cursor:pointer;font-size:16px;width:auto;margin:0;padding:2px 4px;}
  button[type="submit"]{width:100%;margin-top:20px;padding:11px;border:none;border-radius:6px;background:#e5c76b;color:#111;font-weight:bold;cursor:pointer;font-size:14px;}
  .error{color:#ff6b6b;font-size:13px;margin-top:12px;}
</style></head><body>
<form method="POST" action="/setup">
  <h1>Configura tu acceso</h1>
  <p>Este es el único registro posible — crea el único usuario administrador de esta oficina. Una vez creado, esta pantalla se desactiva.</p>
  <label>Email</label>
  <input type="email" name="email" required autofocus>
  <label>Contraseña</label>
  <div class="pwd-wrap">
    <input type="password" name="password" id="pwd" minlength="8" required>
    <button type="button" class="pwd-toggle" onclick="const p=document.getElementById('pwd');p.type=p.type==='password'?'text':'password';this.textContent=p.type==='password'?'👁':'🙈';">👁</button>
  </div>
  <button type="submit">Crear acceso</button>
  ${error ? '<div class="error">' + escapeHtml(error) + '</div>' : ''}
</form>
</body></html>`;
}
const dataFile = String(process.env.DATA_FILE || '/app/data/state.json');

// Admin unico (email + hash de contrasena). Se puede fijar por variables de
// entorno (ADMIN_EMAIL/ADMIN_PASSWORD_HASH) o crear una vez desde /setup, que
// se guarda en un archivo junto al resto de datos persistentes. Solo puede
// existir un admin -- una vez creado (por env o por /setup), /setup se cierra.
const adminFile = path.join(path.dirname(dataFile), 'admin.json');
let adminEmail = String(process.env.ADMIN_EMAIL || '');
let adminPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || '');

function loadAdminFromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
    if (raw.email && raw.passwordHash) {
      adminEmail = raw.email;
      adminPasswordHash = raw.passwordHash;
    }
  } catch {
    // sin archivo todavia, o vacio -- normal en primer arranque
  }
}

function isAdminConfigured() {
  return Boolean(adminEmail && adminPasswordHash);
}

function saveAdminToFile(email, passwordHash) {
  writeJsonAtomic(adminFile, { email, passwordHash });
  adminEmail = email;
  adminPasswordHash = passwordHash;
}

function hashPasswordForStorage(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

// URL publica de esta oficina, solo para el widget opcional de WordPress
// (renderWordpressEmbedJs) — sin configurar, ese widget no funciona pero el
// resto de la oficina va igual. Nunca hardcodear un dominio real aqui.
const publicOfficeUrl = String(process.env.PUBLIC_OFFICE_URL || '').replace(/\/$/, '');

const agents = new Map();
const VALID_AGENT_STATES = new Set(['working', 'idle', 'thinking', 'speaking', 'sleeping', 'error', 'offline', 'collaborating', 'waiting', 'listening']);
const events = [];
const instructions = [];
const socialExecutions = [];
const workExecutions = [];
const reportes = [];
const reportesDir = path.join(path.dirname(dataFile), 'reportes');
const auditorias = [];
const auditoriasDir = path.join(path.dirname(dataFile), 'auditorias');
const conversaciones = [];
const flyers = [];
const gmbPosts = [];
const adsBorradores = [];
const calendario = [];
const planSemanalIA = { lunes: [], martes: [], miercoles: [], jueves: [], viernes: [], sabado: [], domingo: [] };
const planSemanalRedes = { lunes: [], martes: [], miercoles: [], jueves: [], viernes: [], sabado: [], domingo: [] };
const tareasManuales = { lunes: [], martes: [], miercoles: [], jueves: [], viernes: [], sabado: [], domingo: [] };
const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const serviciosPrecios = [];
const ticketsTecnicos = [];
const clientes = [];
const clientePosts = [];
const mediaSubida = [];
const N8N_INBOX_WEBHOOK_URL = String(process.env.N8N_INBOX_WEBHOOK_URL || '');
const N8N_INBOX_TOKEN = String(process.env.N8N_INBOX_TOKEN || '');
const N8N_FLYER_PUBLICAR_URL = String(process.env.N8N_FLYER_PUBLICAR_URL || '');
const VMSCONTENT_KEY = String(process.env.VMSCONTENT_KEY || '');
const N8N_PUBLICAR_MEDIA_URL = String(process.env.N8N_PUBLICAR_MEDIA_URL || 'https://n8n.srv1836153.hstgr.cloud/webhook/publicar-media-manual');
const businessMetrics = {
  ventas: 0,
  captaciones: 0,
  gastos: 0,
  ganancias: 0,
  suscriptores: 0,
  n8n_status: 'ok',
  n8n_workflows: 0,
  n8n_ejecuciones_hoy: 0,
  n8n_publicaciones_hoy: 0,
  notes: '',
  updatedAt: null,
};
const clients = new Set();

// --- Leads reales del scraper (pestana "Llamadas" del calendario) ---
// Se cargan una sola vez al arrancar desde un CSV puesto a mano en el volumen
// persistente /app/data (no forma parte de state.json -- serian ~80k filas,
// demasiado para guardar/escribir en cada saveState()).
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

let leadsData = [];
function cargarLeads() {
  try {
    const rutaCsv = path.join(process.env.DATA_FILE ? path.dirname(process.env.DATA_FILE) : '/app/data', 'leads.csv');
    const raw = fs.readFileSync(rutaCsv, 'utf8').replace(/^\uFEFF/, '');
    const lineas = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lineas.length) { leadsData = []; return; }
    const cabecera = parseCsvLine(lineas[0]);
    const idx = {
      nombre: cabecera.indexOf('Nombre'),
      categoria: cabecera.indexOf('Categoria'),
      zona: cabecera.indexOf('Zona'),
      ciudad: cabecera.indexOf('Ciudad'),
      direccion: cabecera.indexOf('Direccion'),
      telefono: cabecera.indexOf('Telefono'),
      web: cabecera.indexOf('Web'),
    };
    const out = [];
    for (let i = 1; i < lineas.length; i++) {
      const f = parseCsvLine(lineas[i]);
      const telefono = (f[idx.telefono] || '').trim();
      if (!telefono) continue;
      out.push({
        nombre: (f[idx.nombre] || '').trim(),
        categoria: (f[idx.categoria] || 'Sin categoria').trim(),
        ciudad: (f[idx.ciudad] || f[idx.zona] || 'Sin ciudad').trim(),
        direccion: (f[idx.direccion] || '').trim(),
        telefono,
        web: (f[idx.web] || '').trim(),
      });
    }
    leadsData = out;
    console.log('[leads] cargados', leadsData.length, 'leads con telefono desde', rutaCsv);
  } catch (e) {
    console.error('[leads] no se pudo cargar leads.csv:', e.message);
    leadsData = [];
  }
}
cargarLeads();
let nextEventId = 1;
let nextInstructionId = 1;
let nextSocialExecutionId = 1;
let nextWorkExecutionId = 1;
let nextReporteId = 1;
let nextAuditoriaId = 1;
let nextConversacionId = 1;
let nextMensajeId = 1;
let nextFlyerId = 1;
let nextGmbPostId = 1;
let nextAdsBorradorId = 1;
let nextCalendarioId = 1;
let nextPlanIaId = 1;
let nextPlanRedesId = 1;
let nextTareaManualId = 1;
let nextServicioId = 1;
let nextTicketId = 1;
let nextClienteId = 1;
let nextClientePostId = 1;
let nextMediaSubidaId = 1;

const TEAM_RESOURCES = {
  community: [
    'Instagram principal',
    'Instagram IA',
    'TikTok',
    'YouTube Shorts',
    'Meta Business Suite',
    'n8n publicaciones',
    'Biblioteca de hooks',
  ],
  comerciales: [
    'Leads scraper',
    'Google Sheets auditorías',
    'Email outbound',
    'WhatsApp comercial',
    'Calendario auditorías',
    'Plantillas comerciales',
  ],
  seo: [
    'Web VMS',
    'Web Plugfy.pro',
    'Web Gramflow',
    'Web TPV Plugfy',
    'Google Business',
    'Backlog SEO / GEO / AEO',
  ],
  web: [
    'WordPress VMS',
    'Hostinger',
    'Landing pages',
    'CTAs y copy',
    'Repositorio local',
  ],
  automatizacion: [
    'n8n',
    'OpenAI',
    'Drive',
    'Canva',
    'Webhooks',
    'APIs IA',
  ],
  operaciones: [
    'Google Business',
    'Panel oficina',
    'Reportes',
    'Control diario',
    'Auditorías',
  ],
  direccion: [
    'Panel CEO',
    'Métricas',
    'Reportes',
    'Oficina virtual',
    'Visión global',
  ],
};

function ensureDataDir() {
  const dir = path.dirname(dataFile);
  fs.mkdirSync(dir, { recursive: true });
}

// Escritura atomica (archivo temporal + rename) -- evita que un reinicio a
// mitad de un fs.writeFileSync deje el JSON truncado y loadState() reviente
// al leerlo la proxima vez.
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFile, file);
}

// Archivo propio y separado de state.json a proposito: state.json guarda una
// foto completa de agentes/instrucciones/etc. en cada saveState(), y si el
// guardado de sesiones se metiera ahi dentro, un login en mal momento podria
// sobrescribir esa foto completa (y perder agentes) en el siguiente reinicio.
// Este archivo solo contiene sesiones -- nunca puede tocar ni borrar datos.
const sessionsFile = String(process.env.SESSIONS_FILE || '/app/data/sessions.json');

function loadSessions() {
  try {
    if (!fs.existsSync(sessionsFile)) return;
    const raw = fs.readFileSync(sessionsFile, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return;
    const now = Date.now();
    for (const [id, session] of Object.entries(parsed)) {
      if (session && typeof session.expiresAt === 'number' && session.expiresAt > now) {
        sessions.set(id, session);
      }
    }
  } catch (error) {
    console.error('No se pudieron cargar las sesiones:', error.message || error);
  }
}

function saveSessions() {
  try {
    writeJsonAtomic(sessionsFile, Object.fromEntries(sessions));
  } catch (error) {
    console.error('No se pudieron guardar las sesiones:', error.message || error);
  }
}

function loadState() {
  try {
    ensureDataDir();
    if (!fs.existsSync(dataFile)) return;
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) {
      throw new Error('state.json no contiene un agents[] valido');
    }
    if (Array.isArray(parsed.instructions)) {
      instructions.splice(0, instructions.length, ...parsed.instructions);
      nextInstructionId = (instructions.at(-1)?.id || 0) + 1;
    }
    if (Array.isArray(parsed.socialExecutions)) {
      socialExecutions.splice(0, socialExecutions.length, ...parsed.socialExecutions);
      nextSocialExecutionId = (socialExecutions.at(-1)?.id || 0) + 1;
    }
    if (Array.isArray(parsed.workExecutions)) {
      workExecutions.splice(0, workExecutions.length, ...parsed.workExecutions);
      nextWorkExecutionId = (workExecutions.at(-1)?.id || 0) + 1;
    }
    if (Array.isArray(parsed.reportes)) {
      reportes.splice(0, reportes.length, ...parsed.reportes);
      nextReporteId = (reportes.at(-1)?.id || 0) + 1;
    }
    if (Array.isArray(parsed.auditorias)) {
      auditorias.splice(0, auditorias.length, ...parsed.auditorias);
      nextAuditoriaId = (auditorias.at(-1)?.id || 0) + 1;
    }
    if (Array.isArray(parsed.conversaciones)) {
      conversaciones.splice(0, conversaciones.length, ...parsed.conversaciones);
      nextConversacionId = Math.max(0, ...conversaciones.map((c) => c.id || 0)) + 1;
      nextMensajeId = Math.max(0, ...conversaciones.flatMap((c) => (c.mensajes || []).map((m) => m.id || 0))) + 1;
    }
    if (Array.isArray(parsed.flyers)) {
      flyers.splice(0, flyers.length, ...parsed.flyers);
      nextFlyerId = Math.max(0, ...flyers.map((f) => f.id || 0)) + 1;
    }
    if (Array.isArray(parsed.gmbPosts)) {
      gmbPosts.splice(0, gmbPosts.length, ...parsed.gmbPosts);
      nextGmbPostId = Math.max(0, ...gmbPosts.map((p) => p.id || 0)) + 1;
    }
    if (Array.isArray(parsed.adsBorradores)) {
      adsBorradores.splice(0, adsBorradores.length, ...parsed.adsBorradores);
      nextAdsBorradorId = Math.max(0, ...adsBorradores.map((p) => p.id || 0)) + 1;
    }
    if (Array.isArray(parsed.calendario)) {
      calendario.splice(0, calendario.length, ...parsed.calendario);
      nextCalendarioId = Math.max(0, ...calendario.map((c) => c.id || 0)) + 1;
    }
    if (parsed.planSemanalIA && typeof parsed.planSemanalIA === 'object') {
      let maxId = 0;
      for (const dia of DIAS_SEMANA) {
        planSemanalIA[dia] = Array.isArray(parsed.planSemanalIA[dia]) ? parsed.planSemanalIA[dia] : [];
        for (const it of planSemanalIA[dia]) maxId = Math.max(maxId, it.id || 0);
      }
      nextPlanIaId = maxId + 1;
    }
    if (parsed.planSemanalRedes && typeof parsed.planSemanalRedes === 'object') {
      let maxId = 0;
      for (const dia of DIAS_SEMANA) {
        planSemanalRedes[dia] = Array.isArray(parsed.planSemanalRedes[dia]) ? parsed.planSemanalRedes[dia] : [];
        for (const it of planSemanalRedes[dia]) maxId = Math.max(maxId, it.id || 0);
      }
      nextPlanRedesId = maxId + 1;
    }
    if (parsed.tareasManuales && typeof parsed.tareasManuales === 'object') {
      let maxId = 0;
      for (const dia of DIAS_SEMANA) {
        tareasManuales[dia] = Array.isArray(parsed.tareasManuales[dia]) ? parsed.tareasManuales[dia] : [];
        for (const it of tareasManuales[dia]) maxId = Math.max(maxId, it.id || 0);
      }
      nextTareaManualId = maxId + 1;
    }
    if (Array.isArray(parsed.serviciosPrecios) && parsed.serviciosPrecios.length) {
      serviciosPrecios.splice(0, serviciosPrecios.length, ...parsed.serviciosPrecios);
      nextServicioId = Math.max(0, ...serviciosPrecios.map((s) => s.id || 0)) + 1;
    }
    if (Array.isArray(parsed.ticketsTecnicos)) {
      ticketsTecnicos.splice(0, ticketsTecnicos.length, ...parsed.ticketsTecnicos);
      nextTicketId = Math.max(0, ...ticketsTecnicos.map((t) => t.id || 0)) + 1;
    }
    if (Array.isArray(parsed.clientes)) {
      clientes.splice(0, clientes.length, ...parsed.clientes);
      nextClienteId = Math.max(0, ...clientes.map((c) => c.id || 0)) + 1;
    }
    if (Array.isArray(parsed.clientePosts)) {
      clientePosts.splice(0, clientePosts.length, ...parsed.clientePosts);
      nextClientePostId = Math.max(0, ...clientePosts.map((p) => p.id || 0)) + 1;
    }
    if (Array.isArray(parsed.mediaSubida)) {
      mediaSubida.splice(0, mediaSubida.length, ...parsed.mediaSubida);
      nextMediaSubidaId = Math.max(0, ...mediaSubida.map((m) => m.id || 0)) + 1;
    }
    if (Array.isArray(parsed.agents)) {
      agents.clear();
      for (const agent of parsed.agents) {
        if (!agent.agent) continue;
        agents.set(agent.agent, { ...agent, lastSeen: Date.now() });
      }
    }
    if (parsed.businessMetrics && typeof parsed.businessMetrics === 'object') {
      Object.assign(businessMetrics, parsed.businessMetrics);
    }
  } catch (error) {
    stateLoadFailed = true;
    console.error('No se pudo cargar el estado:', error.message || error);
  }
}

let stateLoadFailed = false;
function saveState() {
  if (stateLoadFailed) {
    throw new Error('Guardado bloqueado: state.json no se pudo cargar de forma segura');
  }
  try {
    writeJsonAtomic(dataFile, {
      agents: publicAgents(),
      instructions,
      socialExecutions,
      workExecutions,
      reportes,
      auditorias,
      planSemanalIA,
      planSemanalRedes,
      tareasManuales,
      mediaSubida,
      serviciosPrecios,
      conversaciones,
      flyers,
      gmbPosts,
      adsBorradores,
      calendario,
      businessMetrics,
      ticketsTecnicos,
      clientes,
      clientePosts,
    });
  } catch (error) {
    console.error('No se pudo guardar el estado:', error.message || error);
    throw error;
  }
}

const SPANISH_REPAIRS = [
  ['\u00c3\u00a1', '\u00e1'], ['\u00c3\u00a9', '\u00e9'], ['\u00c3\u00ad', '\u00ed'], ['\u00c3\u00b3', '\u00f3'], ['\u00c3\u00ba', '\u00fa'],
  ['\u00c3\u0081', '\u00c1'], ['\u00c3\u0089', '\u00c9'], ['\u00c3\u008d', '\u00cd'], ['\u00c3\u0093', '\u00d3'], ['\u00c3\u009a', '\u00da'],
  ['\u00c3\u00b1', '\u00f1'], ['\u00c3\u0091', '\u00d1'], ['\u00c3\u00bc', '\u00fc'], ['\u00c3\u009c', '\u00dc'],
  ['\u00c2\u00b7', '.'], ['\u00c2', ''], ['\u00e2\u20ac\u00a6', '...'], ['\u00e2\u20ac\u201c', '-'], ['\u00e2\u20ac\u201d', '-'], ['\u00e2\u2020\u2019', '->'],
  // Formas ya deletreadas mal (sin el caracter acentuado) que puede dejar el
  // saneado agresivo de una limpieza anterior. Cada patron de busqueda usa la
  // palabra corrupta COMPLETA (nunca solo el sufijo) para no coincidir por
  // accidente dentro de una palabra ya bien escrita \u2014 ese fue el bug real:
  // 'ngulo' (buscando sin la 'a' inicial) coincidia dentro de "\u00e1ngulo" ya
  // correcto y lo iba corrompiendo un poco mas cada vez que se releia/guardaba.
  ['direccian', 'direcci\u00f3n'], ['Direccian', 'Direcci\u00f3n'],
  ['revisian', 'revisi\u00f3n'], ['Revisian', 'Revisi\u00f3n'],
  ['pagina', 'p\u00e1gina'], ['Pagina', 'P\u00e1gina'],
  ['praximo', 'pr\u00f3ximo'], ['Praximo', 'Pr\u00f3ximo'],
  ['matricas', 'm\u00e9tricas'], ['Matricas', 'M\u00e9tricas'],
  ['sincronizacian', 'sincronizaci\u00f3n'], ['Sincronizacian', 'Sincronizaci\u00f3n'],
  ['ejecucian', 'ejecuci\u00f3n'], ['Ejecucian', 'Ejecuci\u00f3n'],
  ['automtico', 'autom\u00e1tico'], ['Automtico', 'Autom\u00e1tico'],
  ['auditorias', 'auditor\u00edas'], ['Auditorias', 'Auditor\u00edas'],
  ['titulo', 't\u00edtulo'], ['Titulo', 'T\u00edtulo'],
  ['angulo', '\u00e1ngulo'], ['Angulo', '\u00c1ngulo'],
  ['ultima', '\u00faltima'], ['Ultima', '\u00daltima'],
  // Datos guardados de una corrupcion mas vieja donde el caracter acentuado
  // se convirtio literalmente en '?' (no en un byte mojibake): 'ci??n' solo
  // puede venir de '-ci\u00f3n' roto (nunca de una palabra ya correcta, que
  // tendria una 'o' con tilde real ahi, no signos de interrogacion), y lo
  // mismo con el separador ' ?? ' en vez de ' \u00b7 '. Seguro de aplicar.
  ['ci??n', 'ci\u00f3n'],
  ['si??n', 'si\u00f3n'],
  [' ?? ', ' \u00b7 '],
];

function sanitizeSpanishText(value) {
  let text = String(value ?? '');
  for (const [from, to] of SPANISH_REPAIRS) text = text.split(from).join(to);
  return text.replace(/\uFFFD/g, '').replace(/\s{2,}/g, ' ').trim();
}

function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeSpanishText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item)]));
  }
  return value;
}

function truncate(value, max = 80) {
  const text = sanitizeSpanishText(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function heartbeat(payload) {
  const existing = agents.get(payload.agent) || {};
  const agent = {
    agent: payload.agent,
    id: payload.agent,
    name: sanitizeSpanishText(payload.name || existing.name || payload.agent),
    state: VALID_AGENT_STATES.has(String(payload.state)) ? String(payload.state) : (existing.state || 'idle'),
    task: payload.task !== undefined ? sanitizeSpanishText(payload.task) : (existing.task || null),
    energy: payload.energy ?? existing.energy ?? 1,
    metadata: sanitizeDeep(payload.metadata || existing.metadata || {}),
    lastSeen: Date.now(),
  };
  agents.set(payload.agent, agent);
  saveState();
  broadcastAgents();
  return agent;
}

function publicAgents() {
  return Array.from(agents.values()).map((agent) => sanitizeDeep(agent));
}

const CANALES_INBOX = new Set(['email', 'whatsapp', 'instagram', 'web', 'voz', 'sms']);

function encontrarOCrearConversacion(canal, identificador, nombreContacto) {
  let conv = conversaciones.find((c) => c.canal === canal && c.identificador === identificador);
  if (!conv) {
    conv = {
      id: nextConversacionId++,
      canal,
      identificador,
      nombreContacto: sanitizeSpanishText(nombreContacto || identificador),
      etiquetas: [],
      estado: 'abierta',
      mensajes: [],
      sugerenciaIA: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    conversaciones.push(conv);
  }
  return conv;
}

function agregarMensajeInbox(payload) {
  const canal = String(payload.canal || '').toLowerCase();
  if (!CANALES_INBOX.has(canal)) throw new Error('canal_invalido');
  const identificador = String(payload.identificador || '').trim();
  if (!identificador) throw new Error('falta_identificador');
  const conv = encontrarOCrearConversacion(canal, identificador, payload.nombreContacto);
  const mensaje = {
    id: nextMensajeId++,
    autor: payload.autor === 'contacto' ? 'contacto' : 'sistema',
    texto: sanitizeSpanishText(String(payload.texto || '')),
    timestamp: Date.now(),
  };
  conv.mensajes.push(mensaje);
  if (conv.mensajes.length > 100) conv.mensajes.shift();
  if (payload.sugerenciaIA) {
    conv.sugerenciaIA = sanitizeSpanishText(String(payload.sugerenciaIA));
  }
  conv.estado = 'abierta';
  conv.updatedAt = Date.now();
  if (conversaciones.length > 500) {
    conversaciones.sort((a, b) => a.updatedAt - b.updatedAt);
    conversaciones.shift();
  }
  saveState();
  return conv;
}

function publicConversaciones() {
  return conversaciones
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({
      ...c,
      ultimoMensaje: c.mensajes.at(-1) || null,
      mensajes: undefined,
    }));
}

async function enviarRespuestaInbox(conv, texto) {
  if (!N8N_INBOX_WEBHOOK_URL) throw new Error('N8N_INBOX_WEBHOOK_URL no configurado');
  const resp = await fetch(N8N_INBOX_WEBHOOK_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'X-Inbox-Token': N8N_INBOX_TOKEN },
    body: JSON.stringify({
      conversacionId: conv.id,
      canal: conv.canal,
      identificador: conv.identificador,
      texto,
    }),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error('n8n respondio ' + resp.status + ': ' + raw.slice(0, 200));
  }
  const data = await resp.json().catch(() => ({}));
  if (data.ok === false) {
    throw new Error(data.error || 'El envio no se pudo completar');
  }
  return data;
}

async function publicarFlyerInstagram(flyer) {
  if (!N8N_FLYER_PUBLICAR_URL) throw new Error('N8N_FLYER_PUBLICAR_URL no configurado');
  const resp = await fetch(N8N_FLYER_PUBLICAR_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', 'X-Inbox-Token': N8N_INBOX_TOKEN },
    body: JSON.stringify({
      marca: flyer.marca,
      formato: flyer.formato,
      imagenUrl: flyer.imagenUrl,
      caption: flyer.caption,
    }),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error('n8n respondio ' + resp.status + ': ' + raw.slice(0, 200));
  }
  const data = await resp.json().catch(() => ({}));
  if (data.ok === false) {
    throw new Error(data.error || 'El envio no se pudo completar');
  }
  return data;
}

function pushEvent(agentId, action) {
  events.push({
    id: nextEventId++,
    timestamp: Date.now(),
    agentId,
    action,
  });
  if (events.length > 200) events.shift();
}

function computeMetrics(list = publicAgents()) {
  const byDepartment = {
    direccion: 0,
    community: 0,
    comerciales: 0,
    seo: 0,
    web: 0,
    automatizacion: 0,
    pentesting: 0,
    operaciones: 0,
  };

  const detail = {
    working: 0,
    thinking: 0,
    sleeping: 0,
    offline: 0,
    gmb: 0,
    social: 0,
    ads: 0,
    watchers: 0,
  };

  for (const agent of list) {
    const dep = inferDepartment(agent);
    if (dep === 'direccion') byDepartment.direccion += 1;
    else if (dep === 'community') byDepartment.community += 1;
    else if (dep === 'comerciales') byDepartment.comerciales += 1;
    else if (dep === 'seo') byDepartment.seo += 1;
    else if (dep === 'web') byDepartment.web += 1;
    else if (dep === 'automatizacion') byDepartment.automatizacion += 1;
    else if (dep === 'pentesting') byDepartment.pentesting += 1;
    else byDepartment.operaciones += 1;

    if (detail[agent.state] !== undefined) detail[agent.state] += 1;

    const text = `${agent.agent || ''} ${agent.name || ''}`.toLowerCase();
    if (/gmb|google business/.test(text)) detail.gmb += 1;
    if (/instagram|tiktok|youtube|facebook|community|redes|copy|creativ/.test(text)) detail.social += 1;
    if (/ads|media buyer|tracking|cro/.test(text)) detail.ads += 1;
    if (/watch_|vigilancia|guardian|instrucciones/.test(text)) detail.watchers += 1;
  }

  return {
    total: list.length,
    online: list.filter((agent) => agent.state !== 'offline').length,
    working: list.filter((agent) => agent.state === 'working').length,
    byDepartment,
    detail,
    lastEventId: events.at(-1)?.id || 0,
    recentEvents: events.slice(-8).reverse(),
  };
}

function coerceMetricNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function extractAgentMetrics(agent) {
  const source = agent?.metadata?.metrics && typeof agent.metadata.metrics === 'object'
    ? agent.metadata.metrics
    : (agent?.metadata && typeof agent.metadata === 'object' ? agent.metadata : {});

  return {
    ventas: coerceMetricNumber(source.ventas),
    captaciones: coerceMetricNumber(source.captaciones),
    gastos: coerceMetricNumber(source.gastos),
    ganancias: coerceMetricNumber(source.ganancias),
    suscriptores: coerceMetricNumber(source.suscriptores),
    n8n_workflows: coerceMetricNumber(source.n8n_workflows),
    n8n_ejecuciones_hoy: coerceMetricNumber(source.n8n_ejecuciones_hoy),
    n8n_publicaciones_hoy: coerceMetricNumber(source.n8n_publicaciones_hoy),
    hasBusinessData: [
      source.ventas,
      source.captaciones,
      source.gastos,
      source.ganancias,
      source.suscriptores,
      source.n8n_workflows,
      source.n8n_ejecuciones_hoy,
      source.n8n_publicaciones_hoy,
    ].some((value) => value !== undefined && value !== null && value !== ''),
  };
}

function aggregateBusinessMetrics(list = publicAgents()) {
  const totals = {
    ventas: 0,
    captaciones: 0,
    gastos: 0,
    ganancias: 0,
    suscriptores: 0,
    n8n_workflows: 0,
    n8n_ejecuciones_hoy: 0,
    n8n_publicaciones_hoy: 0,
  };

  let hasBusinessData = false;
  let working = 0;
  let online = 0;
  let socials = 0;
  let commercials = 0;
  let seo = 0;
  let web = 0;
  let automation = 0;

  for (const agent of list) {
    if (agent.state === 'working') working += 1;
    if (agent.state !== 'offline') online += 1;

    const dep = inferDepartment(agent);
    if (dep === 'community') socials += 1;
    else if (dep === 'comerciales') commercials += 1;
    else if (dep === 'seo') seo += 1;
    else if (dep === 'web') web += 1;
    else if (dep === 'automatizacion') automation += 1;

    const values = extractAgentMetrics(agent);
    hasBusinessData = hasBusinessData || values.hasBusinessData;
    totals.ventas += values.ventas;
    totals.captaciones += values.captaciones;
    totals.gastos += values.gastos;
    totals.ganancias += values.ganancias;
    totals.suscriptores += values.suscriptores;
    totals.n8n_workflows += values.n8n_workflows;
    totals.n8n_ejecuciones_hoy += values.n8n_ejecuciones_hoy;
    totals.n8n_publicaciones_hoy += values.n8n_publicaciones_hoy;
  }

  const automaticNotes = hasBusinessData
    ? `Modo automatico activo. ${working} trabajadores en marcha y metricas vivas reportadas por el equipo.`
    : `Modo automatico activo. ${working} trabajadores trabajando ahora, ${socials} en redes, ${commercials} en ventas, ${seo} en SEO, ${web + automation} en web/IA. Aun no hay KPIs de negocio reportados por agentes.`;

  return {
    ...totals,
    n8n_status: online > 0 ? 'ok' : 'warn',
    notes: automaticNotes,
    updatedAt: Date.now(),
    source: hasBusinessData ? 'agents' : 'office-auto',
    auto: true,
  };
}

function publicInstructions() {
  return sanitizeDeep(instructions.slice().reverse());
}

function publicSocialExecutions() {
  return sanitizeDeep(socialExecutions.slice().reverse());
}

function publicWorkExecutions() {
  return sanitizeDeep(workExecutions.slice().reverse());
}

const TEAM_EXECUTION_TEMPLATES = {
  ads_google: {
    title: 'Ejecución Google Ads (borrador, sin API todavia)',
    steps: [
      ['estrategia', 'Estrategia y objetivo de campaña'],
      ['keywords', 'Investigación de keywords'],
      ['copy', 'Titulares y descripciones (RSA)'],
      ['creativo', 'Creatividades / Performance Max'],
      ['presupuesto', 'Presupuesto, puja y KPIs'],
    ],
    preferredAgents: ['google_ads_estrategia', 'google_ads_keywords', 'google_ads_copy', 'google_ads_creativo', 'google_ads_presupuesto'],
  },
  ads_meta: {
    title: 'Ejecución Meta Ads (borrador, sin API todavia)',
    steps: [
      ['estrategia', 'Estrategia y objetivo de campaña'],
      ['audiencias', 'Públicos y segmentación'],
      ['copy', 'Copy principal y CTA'],
      ['creativo', 'Dirección creativa (imagen/video)'],
      ['presupuesto', 'Presupuesto y puja'],
    ],
    preferredAgents: ['meta_ads_estrategia', 'meta_ads_audiencias', 'meta_ads_copy', 'meta_ads_creativo', 'meta_ads_presupuesto'],
  },
  community: {
    title: 'Ejecución de redes',
    steps: [
      ['hook', 'Hook y ángulo'],
      ['copy', 'Copy y CTA'],
      ['creative', 'Creatividad 9:16'],
      ['review', 'Revisión final'],
    ],
    preferredAgents: ['social_copy_hooks', 'social_creative_design', 'social_instagram_main', 'caption_editor'],
  },
  comerciales: {
    title: 'Ejecución comercial',
    steps: [
      ['segment', 'Segmentación y prioridad'],
      ['message', 'Mensaje y propuesta'],
      ['followup', 'Seguimiento'],
      ['report', 'Resultado y siguiente paso'],
    ],
    preferredAgents: ['ventas_01', 'setter_leads', 'closer_ventas', 'copy_senior_sales'],
  },
  seo: {
    title: 'Ejecución SEO / GEO / AEO',
    steps: [
      ['audit', 'Auditoría y oportunidad'],
      ['priority', 'Prioridad y enfoque'],
      ['action', 'Acción propuesta'],
      ['report', 'Reporte y siguiente paso'],
    ],
    preferredAgents: ['seo_lead', 'seo_content', 'geo_specialist', 'aeo_specialist'],
  },
  web: {
    title: 'Ejecución web / conversión',
    steps: [
      ['review', 'Revisión de página'],
      ['cta', 'Mejora de CTA y mensaje'],
      ['ux', 'Ajuste UX / conversión'],
      ['report', 'Reporte y despliegue'],
    ],
    preferredAgents: ['web_dev', 'landing_designer', 'ux_conversion_01', 'copy_senior_web'],
  },
  automatizacion: {
    title: 'Ejecución IA / automatización',
    steps: [
      ['flow', 'Flujo y arquitectura'],
      ['prompt', 'Prompt y lógica'],
      ['validation', 'Validación operativa'],
      ['report', 'Reporte y siguiente iteración'],
    ],
    preferredAgents: ['automatizacion_n8n', 'chatbot_ai', 'prompt_engineer_01', 'automation_n8n_ops'],
  },
  operaciones: {
    title: 'Ejecución operaciones / Google Business',
    steps: [
      ['review', 'Revisión y control'],
      ['content', 'Publicación / actualización'],
      ['followup', 'Seguimiento'],
      ['report', 'Reporte y próximo movimiento'],
    ],
    preferredAgents: ['gmb_marketing', 'gmb_ia', 'audit_intake_manager', 'reporting_daily'],
  },
  direccion: {
    title: 'Ejecución dirección',
    steps: [
      ['focus', 'Foco y prioridad'],
      ['assign', 'Asignación'],
      ['review', 'Revisión de avance'],
      ['report', 'Reporte a CEO'],
    ],
    preferredAgents: ['director_general', 'director_marketing', 'director_comercial', 'project_manager'],
  },
};

// Manual operativo maestro: mision fija por trabajador (no se sobrescribe con
// heartbeats), mas ritmo diario/semanal, marcas, acceso real, permiso, prioridad
// y relacion de refuerzo (leaderEquivalente).
//
// Los datos REALES viven fuera del codigo, en config/mission-data.json (gitignored
// — son datos propios de la empresa, no del "motor" reutilizable). Si ese archivo
// no existe (instalacion nueva / repo publico clonado), se usa el ejemplo generico
// config/mission-data.example.json para que la oficina arranque igualmente.
function loadMissionData() {
  const realPath = path.join(process.cwd(), 'config', 'mission-data.json');
  const examplePath = path.join(process.cwd(), 'config', 'mission-data.example.json');
  const chosen = fs.existsSync(realPath) ? realPath : examplePath;
  try {
    return JSON.parse(fs.readFileSync(chosen, 'utf8'));
  } catch (error) {
    console.error(`No se pudo cargar ${chosen}:`, error.message);
    return { reglaMadre: [], ritmoDiario: [], ritmoSemanal: {}, herramientasPorDepartamento: {}, agentes: {} };
  }
}

const MISSION_DATA = loadMissionData();

function getAgentsByDepartment(department) {
  return publicAgents().filter((agent) => inferDepartment(agent) === department);
}

function buildWorkExecution(entry, department) {
  const template = TEAM_EXECUTION_TEMPLATES[department] || TEAM_EXECUTION_TEMPLATES.operaciones;
  const workers = getAgentsByDepartment(department);
  const preferred = template.preferredAgents
    .map((agentId) => workers.find((agent) => agent.agent === agentId))
    .filter(Boolean);
  const assignedWorkers = (preferred.length ? preferred : workers.slice(0, 4)).map((agent) => ({
    agent: agent.agent,
    name: agent.name || agent.agent,
    status: 'pendiente',
  }));
  const execution = {
    id: nextWorkExecutionId++,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    department,
    status: 'en_proceso',
    sourceInstructionId: entry.id,
    title: `${template.title} · ${department}`,
    brief: entry.message || '',
    target: entry.target || department,
    author: entry.author || 'CEO',
    steps: template.steps.map(([key, label], index) => ({ key, label, status: index === 0 ? 'en_proceso' : 'pendiente' })),
    assigned: assignedWorkers.map((worker, index) => ({ ...worker, status: index === 0 ? 'working' : 'pendiente' })),
    result: '',
  };
  workExecutions.push(execution);
  if (workExecutions.length > 300) workExecutions.shift();
  pushEvent(`work_execution:${department}`, {
    type: 'work_execution',
    state: execution.status,
    task: truncate(`Nueva ejecución ${department} #${execution.id}: ${entry.message || template.title}`, 140),
  });
  saveState();
  return execution;
}

// Fuentes de heartbeat que representan una accion real ya completada por una
// automatizacion de IA (n8n) en una sola pasada — a diferencia de las
// ejecuciones que crea la consola CEO (que son tareas humanas de varios dias
// con pasos que alguien tiene que ir completando), estas se crean YA
// terminadas, porque el trabajo real que describen ya se hizo de verdad en el
// momento en que llega el heartbeat. No incluye 'n8n-real-sync' (ese refleja
// estado continuo real, no una tarea puntual) ni 'mission' (no es automatizacion
// real, es la mision fija de los 130 trabajadores simulados).
const AUTOMATION_COMPLETION_SOURCES = new Set([
  'n8n-gmb-content-ia',
  'n8n-seo-auditoria-ia',
  'n8n-auditoria-web-ia',
  'n8n-reporte-diario-ia',
  'n8n-gmail-clasificador-ia',
  'n8n-alertas-ia',
]);

function buildCompletedAutomationExecution(agent, task) {
  const department = inferDepartment(agent);
  const template = TEAM_EXECUTION_TEMPLATES[department] || TEAM_EXECUTION_TEMPLATES.operaciones;
  const execution = {
    id: nextWorkExecutionId++,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    department,
    status: 'hecho',
    sourceInstructionId: null,
    title: `${template.title} · ${department}`,
    brief: task || '',
    target: department,
    author: 'Automatizacion IA',
    steps: template.steps.map(([key, label]) => ({ key, label, status: 'hecho' })),
    assigned: [{ agent: agent.agent, name: agent.name || agent.agent, status: 'hecho' }],
    result: task || '',
  };
  workExecutions.push(execution);
  if (workExecutions.length > 300) workExecutions.shift();
  pushEvent(`work_execution:${department}`, {
    type: 'work_execution',
    state: execution.status,
    task: truncate(`Trabajo real completado por ${agent.agent} #${execution.id}: ${task || template.title}`, 140),
  });
  saveState();
  return execution;
}

function maybeCreateWorkExecutions(entry) {
  const scope = String(entry.scope || '').toLowerCase();
  const target = String(entry.target || '').toLowerCase();
  const departments = ['community', 'comerciales', 'seo', 'web', 'automatizacion', 'pentesting', 'operaciones'];
  if (scope === 'global') return departments.map((department) => buildWorkExecution(entry, department));
  if (scope === 'team') {
    const department = departments.includes(target) || target === 'direccion' ? target : null;
    return department ? [buildWorkExecution(entry, department)] : [];
  }
  if (scope === 'worker') {
    const agent = publicAgents().find((item) => String(item.agent) === String(entry.target));
    const department = agent ? inferDepartment(agent) : null;
    return department ? [buildWorkExecution(entry, department)] : [];
  }
  return [];
}

function socialWorkers() {
  return publicAgents().filter((agent) => inferDepartment(agent) === 'community');
}

function buildSocialExecutionFromInstruction(entry) {
  const workers = socialWorkers();
  const coreWorkers = [
    workers.find((agent) => agent.agent === 'social_copy_hooks'),
    workers.find((agent) => agent.agent === 'social_creative_design'),
    workers.find((agent) => agent.agent === 'social_instagram_main'),
    workers.find((agent) => agent.agent === 'caption_editor'),
  ].filter(Boolean);

  const assigned = coreWorkers.length
    ? coreWorkers.map((agent) => ({ agent: agent.agent, name: agent.name || agent.agent, status: 'pendiente' }))
    : workers.slice(0, 4).map((agent) => ({ agent: agent.agent, name: agent.name || agent.agent, status: 'pendiente' }));

  const execution = {
    id: nextSocialExecutionId++,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'pendiente',
    sourceInstructionId: entry.id,
    title: truncate(entry.message || 'Nueva ejecución social', 120),
    brief: entry.message || '',
    target: entry.target || 'community',
    author: entry.author || 'CEO',
    steps: [
      { key: 'hook', label: 'Hook y ángulo', status: 'pendiente' },
      { key: 'copy', label: 'Copy y CTA', status: 'pendiente' },
      { key: 'creative', label: 'Creatividad 9:16', status: 'pendiente' },
      { key: 'review', label: 'Revisión final', status: 'pendiente' },
    ],
    assigned,
    result: '',
  };

  socialExecutions.push(execution);
  if (socialExecutions.length > 100) socialExecutions.shift();
  pushEvent('social_execution', {
    type: 'social_execution',
    state: execution.status,
    task: truncate(`Nueva ejecución social #${execution.id}: ${execution.title}`, 140),
  });
  saveState();
  return execution;
}

function maybeCreateSocialExecution(entry) {
  const target = String(entry.target || '').toLowerCase();
  const scope = String(entry.scope || '').toLowerCase();
  const text = `${target} ${entry.message || ''}`.toLowerCase();
  if (scope === 'global') return null;
  if (!/(community|instagram|tiktok|youtube|facebook|redes|social)/.test(text)) return null;
  return buildSocialExecutionFromInstruction(entry);
}

function startSocialExecution(executionId) {
  const execution = socialExecutions.find((item) => item.id === executionId);
  if (!execution) return null;
  execution.status = 'en_proceso';
  execution.updatedAt = Date.now();
  if (execution.steps[0]) execution.steps[0].status = 'en_proceso';
  execution.assigned = execution.assigned.map((item, index) => ({
    ...item,
    status: index === 0 ? 'working' : 'pendiente',
  }));
  pushEvent('social_execution', {
    type: 'social_execution',
    state: execution.status,
    task: truncate(`Ejecución social #${execution.id} iniciada`, 140),
  });
  saveState();
  return execution;
}

function completeSocialExecutionStep(executionId, stepKey) {
  const execution = socialExecutions.find((item) => item.id === executionId);
  if (!execution) return null;
  const stepIndex = execution.steps.findIndex((step) => step.key === stepKey);
  if (stepIndex === -1) return null;
  execution.steps = execution.steps.map((step, index) => {
    if (index < stepIndex) return { ...step, status: 'hecho' };
    if (index === stepIndex) return { ...step, status: 'hecho' };
    if (index === stepIndex + 1 && execution.status !== 'hecho') return { ...step, status: 'en_proceso' };
    return step;
  });
  execution.status = execution.steps.every((step) => step.status === 'hecho') ? 'hecho' : 'en_proceso';
  execution.updatedAt = Date.now();
  execution.assigned = execution.assigned.map((item, index) => ({
    ...item,
    status: execution.status === 'hecho'
      ? 'hecho'
      : index < Math.min(stepIndex + 1, execution.assigned.length - 1)
        ? 'hecho'
        : index === Math.min(stepIndex + 1, execution.assigned.length - 1)
          ? 'working'
          : 'pendiente',
  }));
  pushEvent('social_execution', {
    type: 'social_execution',
    state: execution.status,
    task: truncate(`Paso ${stepKey} actualizado en ejecución social #${execution.id}`, 140),
  });
  saveState();
  return execution;
}

function publicBusinessMetrics(list = publicAgents()) {
  const automatic = aggregateBusinessMetrics(list);
  // Los valores guardados a mano en el Editor de negocio (businessMetrics)
  // deben ganar siempre sobre el calculo automatico -- antes el orden del
  // spread era al reves y el automatico (que da 0 en casi todos los campos
  // porque ningun agente reporta ventas/ganancias reales) machacaba
  // silenciosamente lo que el CEO acababa de guardar. Bug real: "el editor
  // de metricas y negocio muestra siempre 0".
  return {
    ...automatic,
    ...businessMetrics,
    notes: businessMetrics.notes || automatic.notes || '',
    updatedAt: businessMetrics.updatedAt || automatic.updatedAt || null,
  };
}

function setBusinessMetrics(payload = {}) {
  const numericFields = ['ventas', 'captaciones', 'gastos', 'ganancias', 'suscriptores', 'n8n_workflows', 'n8n_ejecuciones_hoy', 'n8n_publicaciones_hoy'];
  for (const field of numericFields) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== '') {
      const value = Number(payload[field]);
      if (Number.isFinite(value)) businessMetrics[field] = value;
    }
  }
  if (payload.n8n_status !== undefined) {
    const status = String(payload.n8n_status || 'ok');
    businessMetrics.n8n_status = ['ok', 'warn', 'error'].includes(status) ? status : 'warn';
  }
  if (payload.notes !== undefined) businessMetrics.notes = truncate(String(payload.notes || ''), 500);
  businessMetrics.updatedAt = Date.now();
  saveState();
  pushEvent('dashboard:metrics', {
    type: 'metrics',
    state: 'updated',
    task: `Ventas ${businessMetrics.ventas} · Captaciones ${businessMetrics.captaciones} · Ganancias ${businessMetrics.ganancias}`,
  });
  return publicBusinessMetrics();
}

// Publica de verdad en Instagram (cuenta principal) un archivo que el CEO ha
// subido a mano desde el panel (avatar propio hecho con Gemini, foto real,
// etc.) -- usa el mismo pipeline real de siempre (mismo webhook/nodo robusto
// que ya usan los generadores automaticos), solo que el video/imagen no lo
// genera la IA, lo pone el CEO.
async function publicarMediaSubidaChat(mensaje) {
  if (!mediaSubida.length) {
    return { ok: false, error: 'No hay ningun archivo subido todavia -- sube una imagen o video primero con el clip del panel.' };
  }
  const media = mediaSubida.find((m) => !m.publicado) || mediaSubida[0];

  let caption = '';
  try {
    const gen = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Eres el community manager de Virtual Marketing Spain. El CEO ha subido un video o imagen propio (puede ser su propio avatar generado con IA) y quiere publicarlo. Te da una instruccion de que debe decir el texto. Escribe un caption real para Instagram en espanol de Espana, con gancho en la primera frase (nunca "Hola somos..."), y 8-10 hashtags relevantes. Devuelve JSON: {"caption":"texto con gancho, sin hashtags dentro","hashtags":["palabra1","palabra2",...]}' },
          { role: 'user', content: String(mensaje).slice(0, 500) || 'Publica este contenido con un texto atractivo sobre Virtual Marketing Spain.' },
        ],
      }),
    });
    if (gen.ok) {
      const data = await gen.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      const tags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map((h) => '#' + String(h).replace(/^#/, '')).join(' ');
      caption = (parsed.caption || '').trim() + (tags ? ('\n\n' + tags) : '');
    }
  } catch (e) { /* si falla la IA, seguimos con caption vacio en vez de bloquear la publicacion real */ }
  if (!caption) caption = String(mensaje).slice(0, 300) || 'Virtual Marketing Spain';

  let n8nOk = false;
  let n8nError = '';
  try {
    const pubRes = await fetch(N8N_PUBLICAR_MEDIA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaUrl: media.url, tipo: media.tipo, caption, ordenReal: true }),
    });
    n8nOk = pubRes.ok;
    if (!pubRes.ok) n8nError = `n8n respondio ${pubRes.status}`;
  } catch (e) {
    n8nError = String(e.message || e);
  }
  if (n8nOk) {
    media.publicado = true;
    saveState();
  }
  return { ok: n8nOk, media, caption, error: n8nOk ? undefined : (n8nError || 'no se pudo disparar la publicacion real') };
}

// Estado real "ahora mismo" de la oficina, para cuando el CEO pregunta que
// esta pasando / que estan haciendo los trabajadores -- lee directamente
// publicAgents() (heartbeats reales), nunca inventa actividad. No usa IA,
// es puro dato real formateado.
const DEPT_TITLES_LOCAL = {
  direccion: 'Dirección', scraper: 'Scrapers/Investigación', community: 'Community y redes',
  comerciales: 'Comerciales', seo: 'SEO/GEO/AEO', web: 'Web', automatizacion: 'IA y automatización',
  pentesting: 'Pentesting/Seguridad', tecnico: 'Soporte técnico', operaciones: 'Operaciones',
};
async function estadoEquipoAhoraChat() {
  const ahora = Date.now();
  const LIMITE_ACTIVO_MS = 2 * 60 * 60 * 1000; // 2h -- mismo orden de magnitud que OFFLINE_TIMEOUT_MS
  const todos = publicAgents();
  const activos = todos.filter((a) => a.state && a.state !== 'offline' && (ahora - (a.lastSeen || 0)) < LIMITE_ACTIVO_MS);
  const porDepto = {};
  for (const a of activos) {
    const dep = inferDepartment(a);
    (porDepto[dep] = porDepto[dep] || []).push(a);
  }
  const departamentos = Object.keys(porDepto)
    .sort((a, b) => porDepto[b].length - porDepto[a].length)
    .map((dep) => {
      const nombre = DEPT_TITLES_LOCAL[dep] || dep;
      const ejemplos = porDepto[dep].slice(0, 3).map((a) => `${a.name || a.agent} (${a.state}${a.task ? ': ' + String(a.task).slice(0, 80) : ''})`).join('; ');
      const resto = porDepto[dep].length > 3 ? ` y ${porDepto[dep].length - 3} más` : '';
      return { departamento: nombre, total: porDepto[dep].length, ejemplos: ejemplos + resto };
    });
  return { ok: true, totalActivos: activos.length, totalRegistrados: todos.length, departamentos };
}

// Lee el calendario de contenido REAL ya guardado (mismo array que alimenta
// publicar_flyer/publicar_reel/publicar_historia -- "la marca que toque segun
// el calendario") y devuelve hoy + las proximas entradas programadas. Antes
// de esto no habia ninguna forma de responder "cuando esta programada la
// siguiente publicacion" salvo el fallback honesto de "no tengo ese dato".
async function consultarCalendarioRedesChat() {
  const hoyStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const ordenado = [...calendario].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const hoy = ordenado.find((c) => c.fecha === hoyStr) || null;
  const proximas = ordenado.filter((c) => c.fecha > hoyStr).slice(0, 5);
  return { ok: true, hoyStr, hoy, proximas, totalProgramadas: calendario.length };
}

// Disparadores reales de n8n para ordenes del CEO -- antes de esto
// pushInstruction solo guardaba texto y fabricaba una simulacion visual
// (maybeCreateSocialExecution/maybeCreateWorkExecutions), sin ejecutar nada
// de verdad. Ahora, si el mensaje coincide con alguna de estas reglas, se
// llama al webhook REAL del workflow n8n correspondiente (mismos webhooks de
// prueba ya usados y verificados durante esta sesion) y el resultado REAL
// (exito o fallo) viaja en la respuesta, en vez de una ejecucion inventada.
// Una orden puede disparar varios workflows a la vez (ej. "revisad SEO y
// generad contenido" dispara los dos).
const N8N_BASE = 'https://n8n.srv1836153.hstgr.cloud/webhook/';
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '');

// Bug real (2026-09-10): cuando el CEO pedia por chat un reel/flyer/historia
// de una marca concreta (ej. "publica un reel de Virtual Marketing Spain"),
// el POST al webhook de n8n solo mandaba { tema: texto } -- nunca la marca
// pedida. El workflow de n8n caia siempre en "la marca que toque segun el
// calendario/rotacion", asi que una orden explicita de VMS podia acabar
// publicando Gramflow si le tocaba a Gramflow ese dia. Esto detecta la marca
// mencionada en el texto (si hay alguna) para mandarla explicita como
// marcaSolicitada; los workflows de n8n (ReelDiario001 y similares) ya la
// respetan con prioridad sobre el calendario cuando llega.
function detectarMarcaExplicita(texto) {
  const t = String(texto || '').toLowerCase();
  if (/\btpv\s*plugfy\b|\btpvplugfy\b/.test(t)) return 'tpvplugfy';
  if (/\bgramflow\b/.test(t)) return 'gramflow';
  if (/\bvirtual\s*marketing\s*spain\b|\bvms\b/.test(t)) return 'vms';
  if (/\bplugfy(\.pro)?\b/.test(t)) return 'plugfy';
  return null;
}

// Catalogo de automatizaciones reales disponibles -- 'descripcion' es lo que
// lee la IA para decidir si una orden en lenguaje natural del CEO encaja,
// asi que hay que mantenerlo honesto: si algo no esta aqui, no existe de
// verdad todavia (ej: Stories, Reels, reutilizar publicaciones antiguas).
const REGLAS_AUTOMATIZACION_REAL = [
  { intento: 'publicar_instagram', descripcion: 'Publicar en el feed de Instagram el siguiente contenido nuevo ya preparado en la cola, para cualquiera de las 4 marcas. NO sirve para reutilizar publicaciones antiguas -- eso no existe todavia. Para Stories usar publicar_historia, para Reels usar publicar_reel.', re: /\bpublica(r|d|mos|ndo|lo|los)?\b|\bpubliquen\b/i, path: 'instagram-publicar-trigger-prueba', method: 'GET' },
  { intento: 'publicar_flyer', descripcion: 'Generar y publicar HOY un Flyer (imagen fija) nuevo en Instagram para la marca que toque segun el calendario de contenido, en feed y tambien como Story si el calendario lo indica.', re: /\bflyers?\b/i, path: 'flyer-diario-test', method: 'POST' },
  { intento: 'publicar_reel', descripcion: 'Generar y publicar HOY un Reel (video corto) nuevo en Instagram Y Facebook para la marca que toque segun el calendario de contenido, en feed y tambien como Story si el calendario lo indica. Reels SI existe y funciona de verdad. Usar esto tambien cuando el CEO pida algo generico como "publicacion en redes sociales" sin especificar formato -- PERO SOLO SI NO hay ningun archivo subido pendiente de publicar en el contexto de abajo; si lo hay y el mensaje del CEO puede razonablemente referirse a el (aunque no use la palabra "subido" -- p.ej. "esta imagen", "esto", "lo que te he pasado"), usar publicar_media_subida en su lugar, nunca este.', re: /\breels?\b|\bvideos?\b|\bpublicaci[oó]n(es)?\b.*\bredes\b|\bredes\s*sociales\b.*\bpublica/i, path: 'reel-diario-test', method: 'POST' },
  { intento: 'publicar_historia', descripcion: 'Generar y publicar HOY una Historia (Story) nueva en Instagram para la marca que toque segun el calendario de contenido.', re: /\bhistorias?\b|\bstor(y|ies)\b/i, path: 'historia-diaria-prueba', method: 'POST' },
  { intento: 'auditoria_seo', descripcion: 'Auditoria semanal de SEO/GEO/AEO de las webs propias.', re: /\bseo\b/i, path: 'seo-auditoria-test', method: 'POST' },
  { intento: 'auditoria_web', descripcion: 'Auditoria de conversion/UX de las webs propias (landing, CTAs, estructura).', re: /\bweb\b/i, path: 'auditoria-web-test', method: 'POST' },
  { intento: 'pentest_seguridad', descripcion: 'Auditoria tecnica de seguridad (cabeceras HTTPS, exposicion de version de WordPress, etc.) de las webs propias y de clientes.', re: /\bpentest\b|\bseguridad\b|\bauditor[ií]a?\s*t[eé]cnica\b/i, path: 'pentest-revisar-ahora', method: 'POST' },
  { intento: 'generar_contenido', descripcion: 'Generar contenido nuevo de texto/copy para redes sociales para las 4 marcas (no genera la imagen, solo el texto).', re: /\bgenerad?\s*contenido\b|\bcontenido\s*nuevo\b/i, path: 'generador-contenido-test', method: 'POST' },
  { intento: 'ideas_virales', descripcion: 'Generar ideas de video/reel con gancho y guion, basadas en formatos probados (no en tendencias en tiempo real).', re: /\bideas?\s*virales?\b/i, path: 'ideas-virales-test', method: 'POST' },
  { intento: 'gmb_contenido', descripcion: 'Generar y preparar publicaciones para las fichas de Google Business de los distintos negocios.', re: /\bgmb\b|\bgoogle\s*business\b|\bficha\s*de\s*google\b/i, path: 'gmb-contenido-test', method: 'POST' },
  { intento: 'editar_gmb_negocio', descripcion: 'Cambiar/regenerar AHORA MISMO la publicacion de Google Business de UN negocio concreto (de los 6 con ficha conectada: Virtual Marketing Spain Marketing, Virtual Marketing Spain IA, Terapia de Masajes, Soiz, Ginna Nails, Bike Montain), opcionalmente con una instruccion sobre que debe decir. Usar esto (no gmb_contenido) cuando se nombre un negocio concreto.', re: /\b(cambia|edita|regenera|pon\s*otr[ao])\b.*(google\s*business|gmb|ficha)|\b(google\s*business|gmb)\b.*(cambia|edita|regenera)/i, local: regenerarGmbPostChat },
  { intento: 'alta_cliente_nuevo', descripcion: 'Dar de alta un cliente nuevo de la agencia (nombre, carpeta de Drive, notas). Usar cuando el CEO presente explicitamente un cliente nuevo ("este es el nuevo cliente...").', re: /\bnuevo\s*cliente\b|\bcliente\s*nuevo\b|\balta\s*de\s*cliente\b/i, local: altaClienteChat },
  { intento: 'anadir_servicio_cliente', descripcion: 'Anadir un servicio nuevo (Google Ads, Meta Ads, SEO, web, automatizacion, redes, etc.) a un cliente YA existente, y asignarlo al equipo real que corresponda. Usar cuando se nombre un cliente ya dado de alta pidiendo un servicio adicional.', re: /\bquiere\s*tambien\b|\ba[ñn]ad[ei]r?\s*servicio\b|\btambien\s*quiere\b/i, local: anadirServicioClienteChat },
  { intento: 'generar_post_cliente', descripcion: 'Generar texto + hashtags reales para una publicacion de Instagram/Facebook de un cliente cualquiera (de la lista de clientes dados de alta, no solo las 4 marcas propias), listos para copiar/pegar. Usar cuando se pida una publicacion/post para un cliente concreto.', re: /\b(publicaci[oó]n|post)\b.*\bpara\b|\bpublica(r)?\b.*\bcliente\b/i, local: generarPostClienteChat },
  { intento: 'gmb_resumen_diario', descripcion: 'Enviar por email el resumen diario con las publicaciones de Google Business listas para subir manualmente de las 6 empresas (mientras no este conectada la API real de Google Business).', re: /resumen.*google\s*business|google\s*business.*resumen|env.*google\s*business|todos\s*los\s*d[ií]as.*google\s*business/i, path: 'gmb-resumen-diario', method: 'POST' },
  { intento: 'estado_equipo_ahora', descripcion: 'Decir AHORA MISMO, en el propio chat, que esta pasando en la oficina o que estan haciendo los trabajadores/equipos ahora (estado en vivo real, no un email). Usar para preguntas tipo "que esta pasando ahora", "que estan haciendo los trabajadores", "dame el estado del equipo/la oficina ahora".', re: /qu[eé]\s*(est[aá]|estan|est[aá]n)\s*(pasando|haciendo)|estado\s*(de\s*)?(la\s*oficina|los?\s*trabajador|el\s*equipo)|c[oó]mo\s*van\s*los?\s*trabajador/i, local: estadoEquipoAhoraChat },
  { intento: 'publicar_media_subida', descripcion: 'Publicar en redes sociales una foto o video que el CEO acaba de subir el mismo desde el panel (con el boton del clip), por ejemplo un avatar suyo generado con IA en Gemini. NO sirve para generar contenido nuevo con IA -- solo para el archivo que el CEO ya subio a mano. Usar cuando el CEO diga cosas como "publica esto", "sube el video que acabo de subir", "publica mi avatar", "publica la foto/el video subido" -- Y TAMBIEN con frases mas naturales que no usen la palabra "subido" en absoluto (p.ej. "publica esta imagen de que necesitamos comerciales", "sacad esto a redes", "publicad lo que os he pasado"), SIEMPRE que el contexto de abajo indique que hay un archivo pendiente de publicar: en ese caso, cualquier peticion de publicar contenido sin especificar que hay que generarlo desde cero se refiere a ese archivo, no a generar nada nuevo.', re: /\b(publica|sube|publiquen)[a-z]*\b.{0,30}\b(subid[oa]|acabo\s*de\s*subir|avatar|el\s*clip|lo\s*que\s*he\s*subido|esta\s*imagen|este\s*v[ií]deo|esta\s*foto|lo\s*que\s*(te\s*)?he\s*pasado)\b/i, local: publicarMediaSubidaChat },
  { intento: 'reporte_diario', descripcion: 'Generar por EMAIL el reporte ejecutivo diario completo (no es para contestar en el chat en el momento).', re: /\breporte\b/i, path: 'reporte-diario-test', method: 'POST' },
  { intento: 'email_capacidades_chatbots', descripcion: 'Enviar por EMAIL a una direccion concreta que el CEO indique en el mensaje un resumen real de lo que se puede automatizar con chatbots e IA (chatbot de atencion al cliente, automatizacion de WhatsApp, bot de llamadas con IA, automatizacion de procesos internos, informes automaticos). Usar cuando el CEO pida enviar o mandar un email a alguien sobre chatbots, automatizacion o inteligencia artificial -- necesita que el mensaje incluya una direccion de email.', re: /\b(env[ií]a|manda|env[ií]ale|mandale)\b.{0,20}\bemail\b.{0,40}\b(chatbot|autom|inteligencia\s*artificial|\bia\b)|\bemail\b.{0,40}\b(chatbot|autom.{0,20}ia\b)\b.{0,20}\b(env[ií]a|manda)/i, path: 'enviar-email-chatbots', method: 'POST' },
  { intento: 'revisar_correos', descripcion: 'Revisar y clasificar los correos de Gmail pendientes.', re: /\bcorreos?\b|\bgmail\b|\bemails?\b/i, path: 'gmail-revisar-ahora', method: 'POST' },
  { intento: 'plugfyguard_vigilancia', descripcion: 'Vigilancia de seguridad especifica de PlugfyGuard sobre las apps propias (Plugfy panel, Gramflow).', re: /\bplugfyguard\b/i, path: 'plugfyguard-revisar-ahora', method: 'POST' },
  { intento: 'revisar_errores_n8n', descripcion: 'Revisar de verdad, consultando la API real de n8n, si algun workflow/automatizacion (bot de llamadas, redes, GMB, facturas, etc.) ha fallado en las ultimas 24 horas -- lista cada error real con el workflow, el nodo y el mensaje exacto. Ademas hay un aviso automatico por email cada 2h si aparece un error nuevo, sin que el CEO tenga que preguntar.', re: /\berrores?\b|\bfallos?\b|\bfalla(ndo|r)?\b|\bdiagnostic/i, path: 'revisar-errores-n8n', method: 'POST' },
  { intento: 'vigilancia_alertas', descripcion: 'Vigilancia general 24/7 y alertas sobre el estado de las automatizaciones y sistemas propios.', re: /\balertas?\b|\bvigilancia\b/i, path: 'alertas-test', method: 'POST' },
  { intento: 'auditoria_empresa', descripcion: 'Preparar una auditoria/informe para un cliente o empresa nueva (no una de las 4 marcas propias).', re: /\bauditor[ií]a?\s*(de\s*)?(empresa|cliente)s?\b/i, path: 'auditoria-empresa', method: 'POST' },
  { intento: 'auditoria_web_cliente', descripcion: 'Auditoria tecnica real de si la web de un cliente (ej. Soiz Estampaciones) funciona bien y esta adaptada a movil/tablet: comprueba paginas clave (inicio, tienda, checkout) de verdad.', re: /auditor[ií]a?.*(funcion|adapt|movil|m[oó]vil|tablet|responsive)|(funcion|adapt|movil|m[oó]vil|tablet|responsive).*auditor[ií]a?/i, path: 'auditoria-web-cliente', method: 'POST' },
  { intento: 'investigacion_redes', descripcion: 'Investigar competencia y tendencias en redes sociales.', re: /\binvestigaci[oó]n\b|\bcompetencia\b/i, path: 'investigacion-redes-test', method: 'POST' },
  { intento: 'briefing_web', descripcion: 'Generar un briefing inicial para un proyecto de web nueva.', re: /\bbriefing\b/i, path: 'web-ia-briefing', method: 'POST' },
  { intento: 'generar_imagen', descripcion: 'Generar la imagen (plantilla HTML/CSS) para el siguiente contenido pendiente de alguna de las 4 marcas.', re: /\bimagen(es)?\b/i, path: 'asset-imagen-prueba', method: 'GET' },
  { intento: 'reenviar_factura', descripcion: 'Reenviar por email la ultima factura ya generada de un cliente (ej. Soiz Estampaciones), sin generar una factura nueva.', re: /reenv.*factura|factura.*reenv/i, path: 'factura-reenviar-ultima', method: 'POST' },
  { intento: 'estado_ventas', descripcion: 'Estado real AHORA MISMO del bot de llamadas/ventas: leads pendientes, contactados, citas agendadas, llamadas hechas hoy, categorias con mas pendientes. Datos reales consultados en directo a la base de datos, no un resumen preparado de antemano.', re: /\bventas?\b|\bllamadas?\b|\bleads?\b|\bcomercial(es)?\b|\bciti?as?\b/i, path: 'estado-ventas-real', method: 'GET' },
  { intento: 'propuesta_auditoria', descripcion: 'Cadena completa auditoria->copy->ventas: coge el hallazgo REAL mas reciente de una auditoria tecnica/web ya realizada y escribe un argumento de venta especifico para presentarselo a ese cliente, en vez de un texto generico. Distinto de auditoria_web/auditoria_seo (que generan la auditoria en si) -- esto convierte una auditoria ya hecha en una propuesta real.', re: /\bpropuesta\b.*\bauditor[ií]a\b|\bargumento\b.*\bauditor[ií]a\b|\bvender\b.*\bauditor[ií]a\b/i, path: 'propuesta-auditoria-real', method: 'POST' },
  { intento: 'copy_con_investigacion', descripcion: 'Cadena completa research->copy: investiga de verdad en internet el tema/sector pedido y LUEGO escribe un texto de venta apoyado en esos hallazgos reales (datos, cifras, fuentes), en vez de argumentos genericos inventados. Usar cuando pidan copy que se apoye en datos reales o investigacion de sector/competencia.', re: /\bcopy\b.*\binvestigaci[oó]n\b|\btexto\b.*\bcon\s*datos\s*reales\b|\bargumentos?\s*reales?\b.*\bventa\b/i, path: 'copy-con-investigacion-real', method: 'POST' },
  { intento: 'propuesta_lead', descripcion: 'Cadena completa scraper->copy->ventas: coge un lead REAL de la cola (el que se nombre, o el siguiente pendiente) y escribe un mensaje de primer contacto real y personalizado (WhatsApp) usando sus datos reales (categoria, ciudad), listo para que ventas lo envie. Distinto de copy_bajo_demanda (que es un texto suelto sin lead real detras) y de lanzar_llamadas (que llama por telefono, no escribe mensaje).', re: /\bpropuesta\b.*\blead\b|\bmensaje\b.*\blead\b|\bcontacta(r)?\b.*\blead\b|primer\s*contacto/i, path: 'propuesta-lead-real', method: 'POST' },
  { intento: 'copy_bajo_demanda', descripcion: 'Escribir AHORA un texto/copy concreto bajo demanda (hook, titular, texto de venta, caption suelto...) para un uso puntual, distinto del contenido diario automatico de las 4 marcas.', re: /\bescribe(me)?\b.*\b(texto|hook|copy|titular|frase)\b|\bredacta(me)?\b/i, path: 'copy-bajo-demanda-real', method: 'POST' },
  { intento: 'investigar_competidor', descripcion: 'Investigar AHORA en internet a un competidor o sector concreto: fortalezas, debilidades y oportunidades reales, con fuentes. Distinto de investigacion_redes (que es para el calendario interno de contenido) -- esto es un analisis competitivo legible para el CEO.', re: /\binvestiga(r)?\b.*\bcompetenci|\banaliza(r)?\b.*\bcompetidor|\bcompetidor(es)?\b.*\b(analiza|investiga)/i, path: 'investigar-competidor-real', method: 'POST' },
  { intento: 'estado_auditorias', descripcion: 'Estado real AHORA MISMO de las auditorias gratuitas solicitadas por clientes potenciales via WhatsApp: cuantas hay, cuantas tienen cita confirmada, cuantas siguen sin agendar, proximas citas. Datos reales del inbox, no inventados.', re: /\bauditor[ií]as?\s*(pendiente|solicitad|agend)|\bcuantas?\s*auditor[ií]as?\b|estado.*auditor[ií]as?/i, path: 'auditorias-estado-real', method: 'GET' },
  { intento: 'lanzar_llamadas', descripcion: 'Disparar AHORA un lote real de llamadas salientes del bot de ventas (a los leads pendientes segun la cola real, respetando el limite diario ya configurado). Distinto de estado_ventas: esto EJECUTA llamadas de verdad, no solo consulta cifras.', re: /\b(lanza|dispara|empieza|inicia)\b.*\bllama/i, path: 'lanzar-llamadas-real', method: 'POST' },
  { intento: 'metricas_redes', descripcion: 'Metricas REALES de las ultimas publicaciones de Instagram (alcance, vistas, likes, comentarios) de las 2 cuentas, consultadas en directo a la API de Instagram ahora mismo. No es el calendario de contenido ni el catalogo de automatizaciones, son resultados reales de rendimiento.', re: /m[eé]tricas?\b|\brendimiento\b|\bresultados?\s*(de\s*)?(redes|contenido|posts?|publicaciones)\b|\balcance\b|\bengagement\b|c[oó]mo\s*(va|van|est[aá]n?)\s*(las\s*)?redes/i, path: 'metricas-redes-real', method: 'GET' },
  { intento: 'consultar_calendario_redes', descripcion: 'Consultar AHORA que publicacion (marca, formato: reel/feed/story, hora) esta programada hoy y en los proximos dias segun el calendario de contenido REAL ya guardado. Es solo CONSULTA -- distinto de publicar_flyer/publicar_reel/publicar_historia (que generan y publican algo nuevo ya mismo) y de metricas_redes (que da resultados de lo ya publicado). Usar para preguntas tipo "cuando esta programada la proxima publicacion", "que toca publicar hoy/manana", "calendario de redes", "cuando publicamos en instagram".', re: /cu[aá]ndo\s*(est[aá]n?)?\s*programad|calendario\s*(de\s*)?(contenido|redes)|qu[eé]\s*toca\s*publicar|pr[oó]xima\s*publicaci[oó]n|cu[aá]ndo\s*(se\s*)?publica(mos)?/i, local: consultarCalendarioRedesChat },
];

// Clasificador por IA: en vez de exigir que el CEO escriba exactamente la
// palabra clave, se le pasa el catalogo real de automatizaciones a OpenAI y
// se le pide que entienda la intencion en lenguaje natural. Si la orden
// habla de algo que no existe (Stories, Reels, reutilizar publicaciones
// antiguas...) la IA no debe inventarse una coincidencia -- el prompt se lo
// deja explicito.
async function clasificarAutomatizacionesConIA(mensaje) {
  const catalogo = REGLAS_AUTOMATIZACION_REAL.map((r) => `- ${r.intento}: ${r.descripcion}`).join('\n');
  // Contexto real del archivo pendiente: sin esto, el clasificador no tiene
  // forma de saber a que se refiere el CEO cuando dice "esto"/"esta imagen"
  // sin la palabra literal "subido" -- causaba que peticiones en lenguaje
  // natural cayeran en publicar_reel (el catch-all generico) en vez de
  // publicar_media_subida, aunque hubiera un archivo real esperando.
  const pendiente = mediaSubida.filter((m) => !m.publicado);
  const contextoMedia = pendiente.length
    ? `\n\nCONTEXTO IMPORTANTE: ahora mismo hay ${pendiente.length} archivo(s) subido(s) por el CEO pendiente(s) de publicar (el mas reciente: "${pendiente[pendiente.length - 1].nombreOriginal}", tipo ${pendiente[pendiente.length - 1].tipo}). Si el mensaje del CEO pide publicar/subir/sacar contenido a redes SIN pedir explicitamente generar algo nuevo con IA, y no especifica un formato que no encaje con ese archivo, asume que se refiere a ESE archivo pendiente y usa publicar_media_subida -- aunque no diga la palabra "subido" literalmente.`
    : '\n\nCONTEXTO: ahora mismo no hay ningun archivo subido pendiente de publicar, asi que publicar_media_subida no puede aplicar.';
  const systemPrompt = `Eres el clasificador de ordenes del CEO de una agencia de marketing. Tienes este catalogo de automatizaciones REALES disponibles (y solo estas, ninguna mas):\n${catalogo}${contextoMedia}\n\nDado el mensaje del CEO, devuelve SOLO un JSON con la forma {"intentos": ["nombre_intento", ...]} listando los intentos del catalogo que la orden pide ejecutar AHORA, de forma explicita y clara. Puede haber varios, uno, o ninguno.\n\nSe muy estricto -- ante la duda, deja el array vacio. En concreto:\n- Una pregunta de charla o de estado general ("como vamos", "que tal", "algun problema", "todo bien por ahi") NO es una orden de ejecutar nada, aunque el catalogo tenga un intento parecido (ej. reporte_diario) -- eso solo cuenta si el CEO pide explicitamente el reporte/informe/resumen en si (ej. "mandame el reporte diario", "generame el informe").\n- Si la orden pide algo que no esta en el catalogo (por ejemplo Stories, Reels, reutilizar publicaciones antiguas, o cualquier otra cosa sin un intento correspondiente en la lista de arriba), NO inventes una coincidencia -- devuelve un array vacio para esa parte. Revisa bien la lista completa antes de descartar algo, puede haber cambiado recientemente.\n- Interpreta el mensaje del CEO como lenguaje natural real, no busques palabras clave exactas -- el CEO puede pedir lo mismo de muchas formas distintas, entiende la intencion real usando tambien el CONTEXTO de arriba.\nNo expliques nada, solo el JSON.`;

  const respuesta = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: mensaje },
      ],
    }),
  });

  if (!respuesta.ok) throw new Error(`OpenAI respondio ${respuesta.status}`);
  const data = await respuesta.json();
  const contenido = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = JSON.parse(contenido || '{"intentos":[]}');
  const validos = new Set(REGLAS_AUTOMATIZACION_REAL.map((r) => r.intento));
  return (parsed.intentos || []).filter((i) => validos.has(i));
}

async function responderChatCEO(mensaje, historial) {
  const catalogo = REGLAS_AUTOMATIZACION_REAL.map((r) => `- ${r.intento}: ${r.descripcion}`).join('\n');
  const systemPrompt = `Eres el asistente de soporte del CEO de Virtual Marketing Spain (agencia de marketing digital) y de su agencia de automatizaciones con IA. Hablas siempre en espanol, de forma directa y practica, como un compañero de confianza que ayuda a resolver imprevistos del dia a dia.

Estas integrado en el panel privado de la oficina virtual (Miniverse). Conoces el catalogo REAL de automatizaciones ya disponibles en esta oficina (las unicas que existen de verdad, no hay mas):
${catalogo}

Estas hablando con el CEO AHORA porque su mensaje NO coincidio con ninguna accion ejecutable del catalogo de arriba (si hubiera coincidido, ya se habria disparado sola antes de llegar a ti, sin necesitar tu respuesta). Por eso: si lo que pide SI encaja con algo del catalogo pero no se detecto (raro, pero puede pasar con frases ambiguas), dile que lo vuelva a pedir mas claro y se ejecutara. Si pide algo que de verdad no existe en el catalogo, dilo con honestidad en vez de inventar que existe.

Si el CEO reporta un problema tecnico real (algo roto, un error, algo que no funciona como deberia) que necesita que alguien revise codigo/infraestructura a fondo -- no solo disparar una automatizacion ya hecha -- pon "crearTicket":true para que quede registrado y lo revise el equipo tecnico (Claude Code), y dile en tu respuesta que ha quedado anotado para revision. No crees ticket para preguntas normales, dudas, o cosas que ya se resuelven con el catalogo.

Devuelve SIEMPRE un unico objeto JSON valido, sin markdown: {"respuesta":"tu respuesta en espanol para el CEO","crearTicket":false}.`;

  const messages = [{ role: 'system', content: systemPrompt }];
  for (const turno of (historial || []).slice(-10)) {
    if (turno && turno.role && turno.content) {
      messages.push({ role: turno.role === 'ai' ? 'assistant' : 'user', content: String(turno.content).slice(0, 4000) });
    }
  }
  messages.push({ role: 'user', content: String(mensaje).slice(0, 4000) });

  const respuesta = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.5, response_format: { type: 'json_object' }, messages }),
  });

  if (!respuesta.ok) throw new Error(`OpenAI respondio ${respuesta.status}`);
  const data = await respuesta.json();
  const contenido = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(contenido || '{}'); } catch { parsed = {}; }
  if (parsed.crearTicket) {
    await crearTicketTecnico(mensaje, 'chat-ceo');
  }
  return parsed.respuesta || 'No he podido generar una respuesta ahora mismo.';
}

// Escribe/actualiza una entrada de hoy en el Calendario de Redes Sociales
// (planSemanalRedes) para una marca+cuenta concreta -- reemplaza la entrada
// de hoy de esa marca+tipo si ya existia (evita duplicar si un workflow se
// reintenta el mismo dia).
function upsertPlanSemanalRedes(marca, tipo, cuenta, hora, resumen) {
  const dia = DIAS_SEMANA[(new Date().getDay() + 6) % 7];
  const lista = planSemanalRedes[dia];
  const hoyStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const idx = lista.findIndex((it) => it.marca === marca && it.tipo === tipo && it.fechaDia === hoyStr);
  const entrada = {
    id: idx >= 0 ? lista[idx].id : nextPlanRedesId++,
    hora: String(hora || '').slice(0, 5),
    marca: String(marca || '').slice(0, 60),
    tipo: String(tipo || '').slice(0, 30),
    cuenta: String(cuenta || '').slice(0, 160),
    resumen: String(resumen || '').slice(0, 500),
    fechaDia: hoyStr,
    createdAt: Date.now(),
  };
  if (idx >= 0) lista[idx] = entrada; else lista.push(entrada);
  lista.sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
  saveState();
  return entrada;
}

// Escribe/actualiza una entrada de hoy en el Calendario Semanal (planSemanalIA)
// para una empresa concreta -- reemplaza la entrada de hoy de esa empresa si
// ya existia (en vez de duplicar) cuando algo se regenera varias veces el
// mismo dia.
function upsertPlanSemanalIA(empresa, tareas) {
  const dia = DIAS_SEMANA[(new Date().getDay() + 6) % 7]; // getDay(): 0=domingo -> reindexado a lunes=0
  const hora = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
  const hoyStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  // Bug real corregido (2026-09-16): planSemanalIA[dia] esta indexado por
  // NOMBRE del dia de la semana (lunes, martes...), que se repite cada
  // semana -- antes solo se comprobaba/reemplazaba la entrada de HOY
  // (mismo fechaDia), asi que la entrada del mismo dia de semanas
  // ANTERIORES para la misma empresa se quedaba acumulada para siempre
  // (el lunes de hace 3 semanas seguia mostrandose junto al de hoy).
  // Ahora se eliminan TODAS las entradas previas de esa empresa en ese
  // dia de la semana (de cualquier semana) antes de anadir la nueva --
  // actualizar el calendario reemplaza lo anterior, no lo acumula.
  planSemanalIA[dia] = planSemanalIA[dia].filter((it) => it.empresa !== empresa);
  planSemanalIA[dia].push({ id: nextPlanIaId++, hora, empresa: String(empresa).slice(0, 120), tareas: String(tareas).slice(0, 2000), fechaDia: hoyStr, createdAt: Date.now() });
  planSemanalIA[dia].sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
  saveState();
}

async function crearTicketTecnico(mensaje, origen) {
  const ticket = {
    id: nextTicketId++,
    timestamp: Date.now(),
    // Ampliado de 500 a 4000: un ticket de errores reales de n8n necesita
    // caber workflow+nodo+mensaje+id de ejecucion de varios fallos a la vez,
    // para que el equipo tecnico (Claude Code) pueda ir directo al codigo
    // sin tener que volver a investigar desde cero.
    mensaje: truncate(String(mensaje || ''), 4000),
    origen: origen || 'desconocido',
    estado: 'pendiente',
  };
  ticketsTecnicos.unshift(ticket);
  if (ticketsTecnicos.length > 100) ticketsTecnicos.pop();
  saveState();
  // Ademas de quedar en la lista de tickets (Estado del sistema), se asigna
  // como trabajo real al equipo tecnico -- para que no sea solo una nota
  // suelta, sino algo que aparezca en "Ultimas instrucciones" de ese equipo.
  // skipAutomationCheck evita que este mensaje se re-clasifique a si mismo.
  try {
    await pushInstruction({
      scope: 'team',
      target: 'tecnico',
      message: `Ticket #${ticket.id}: ${ticket.mensaje}`,
      author: `CEO (chat, via ${origen || 'ticket'})`,
      skipAutomationCheck: true,
    });
  } catch { /* el ticket ya quedo guardado igualmente, esto es solo el aviso extra */ }
  return ticket;
}

// Mismos 6 negocios y mismo tono/reglas que el workflow n8n "GMB - Contenido
// Diario" (rotacion automatica) -- esto permite regenerar AHORA MISMO, por
// chat, la publicacion de un negocio concreto en vez de esperar a su turno en
// la rotacion, con una instruccion extra opcional del CEO.
const PERFILES_GMB = {
  virtual_marketingspain_marketing: { nombre: 'Virtual Marketing Spain (Marketing Digital)', tipo: 'agencia de marketing digital', enfoque: 'captacion de clientes B2B, SEO, redes sociales, diseno web, autoridad local' },
  virtual_marketingspain_ia: { nombre: 'Virtual Marketing Spain (Automatizacion con IA)', tipo: 'agencia de automatizacion con inteligencia artificial', enfoque: 'chatbots, automatizacion de procesos, bots de llamadas, atencion al cliente con IA' },
  terapia_masajes: { nombre: 'Terapia de Masajes (Elche)', tipo: 'centro de masajes y bienestar', enfoque: 'bienestar, relajacion, dolor muscular, bonos de sesiones, horarios disponibles' },
  soiz_estampaciones: { nombre: 'Soiz', tipo: 'marca de ropa y equipaciones deportivas personalizadas para clubs en Elche', enfoque: 'equipaciones deportivas personalizadas para clubs y equipos, diseno a medida, calidad, plazos de entrega, confianza -- centrar SIEMPRE el contenido en equipaciones deportivas y clubs. Llamar a la marca SIEMPRE "Soiz", nunca "Soiz Estampaciones".' },
  ginna_nails: { nombre: 'Ginna Nails', tipo: 'salon de manicura y unas', enfoque: 'disenos, cuidado, promociones, disponibilidad de cita, tendencias' },
  bike_montain: { nombre: 'Bike Montain', tipo: 'tienda y taller de bicicletas', enfoque: 'reparacion, venta, mantenimiento, temporada, confianza tecnica' },
};

async function regenerarGmbPostChat(mensaje) {
  const listaNegocios = Object.entries(PERFILES_GMB).map(([clave, p]) => `- ${clave}: ${p.nombre}`).join('\n');
  const extraccion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `El CEO pide cambiar/regenerar la publicacion de Google Business de un negocio. Negocios reales disponibles (solo estos):\n${listaNegocios}\n\nDevuelve JSON: {"negocio":"clave_exacta_o_vacio","instruccion":"lo que pida en concreto sobre el contenido, o vacio si no especifica nada"}. Si no se identifica con certeza un negocio de la lista, negocio vacio.` },
        { role: 'user', content: String(mensaje).slice(0, 500) },
      ],
    }),
  });
  if (!extraccion.ok) throw new Error(`OpenAI respondio ${extraccion.status}`);
  const dataExtraccion = await extraccion.json();
  let elegido;
  try { elegido = JSON.parse(dataExtraccion.choices?.[0]?.message?.content || '{}'); } catch { elegido = {}; }
  const perfil = PERFILES_GMB[elegido.negocio];
  if (!perfil) {
    return { ok: false, error: 'No se ha identificado con certeza para que negocio (de los 6 con Google Business conectado) es el cambio.' };
  }

  const fecha = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const systemPrompt = 'Eres el responsable de publicaciones de Google Business Profile (antes Google My Business) de negocios reales en Espana. Escribes en espanol de Espana, cercano, local, creible, NUNCA generico ni de relleno (prohibido "descubre", "no te lo pierdas", "la mejor opcion" sin contexto concreto). Las publicaciones de Google Business son cortas (maximo 1500 caracteres, ideal 200-280), muy directas, estructura dolor-solucion-CTA, con una unica idea clara y un CTA de boton real de Google (elige uno de: RESERVAR, PEDIR_ONLINE, COMPRAR, MAS_INFORMACION, REGISTRARSE, LLAMAR). Devuelves SIEMPRE un unico objeto JSON valido, sin markdown, sin texto antes ni despues.';
  const userPrompt = 'Negocio: ' + perfil.nombre + '\n' +
    'Tipo de negocio: ' + perfil.tipo + '\n' +
    'Enfoque habitual: ' + perfil.enfoque + '\n' +
    'Fecha: ' + fecha + '\n' +
    (elegido.instruccion ? ('Instruccion concreta del CEO para esta publicacion: ' + elegido.instruccion + '\n') : '') +
    '\nGenera UNA publicacion de Google Business real y publicable hoy, en JSON con esta estructura EXACTA:\n' +
    '{"titulo":"","texto":"","cta_boton":"","idea_foto":""}\n\n' +
    'titulo: maximo 58 caracteres. texto: SIEMPRE entre 200 y 280 caracteres (ni menos ni mas -- muy breve, 2-3 frases cortas, letra grande y legible dentro de una plantilla de imagen). Estructura obligatoria en ese orden: (1) nombra un dolor/problema real y concreto del cliente de este tipo de negocio, (2) la solucion directa que ofrece el negocio para ese dolor, (3) una llamada a la accion clara y directa (que encaje con el cta_boton elegido). Nada de relleno, nada de adjetivos vacios, directo al grano. idea_foto: describe la imagen en una frase lista para usarse directamente como prompt de generacion de imagen con IA (sujeto concreto, escena, estilo/ambiente) -- no una idea vaga, sino una instruccion clara de que imagen generar.';

  const generacion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.6, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
  });
  if (!generacion.ok) throw new Error(`OpenAI respondio ${generacion.status}`);
  const dataGeneracion = await generacion.json();
  let contenido;
  try { contenido = JSON.parse(dataGeneracion.choices?.[0]?.message?.content || '{}'); } catch { contenido = {}; }
  if (!contenido.texto) return { ok: false, error: 'La IA no devolvio un texto valido.' };

  const existente = gmbPosts.find((p) => p.negocio === perfil.nombre && p.fecha === fecha && p.estado === 'pendiente');
  const post = existente || { id: nextGmbPostId++, negocio: perfil.nombre, fecha, createdAt: Date.now() };
  post.titulo = String(contenido.titulo || '').slice(0, 120);
  post.texto = sanitizeSpanishText(String(contenido.texto)).slice(0, 1600);
  post.ctaBoton = String(contenido.cta_boton || '').slice(0, 40);
  post.ideaFoto = String(contenido.idea_foto || '').slice(0, 300);
  post.estado = 'pendiente';
  post.updatedAt = Date.now();
  if (!existente) {
    gmbPosts.unshift(post);
    if (gmbPosts.length > 300) gmbPosts.length = 300;
  }
  saveState();
  upsertPlanSemanalIA(perfil.nombre, `${post.titulo}\n\n${post.texto}\n📷 ${post.ideaFoto}`);
  return { ok: true, negocio: perfil.nombre, post };
}

// Alta de un cliente nuevo directamente desde el chat del CEO ("este es el
// nuevo cliente, tiene la carpeta en Drive en tal sitio") -- registro real y
// consultable, no una simulacion. No crea nada mas (accesos, workflows...),
// solo dej el cliente dado de alta para poder referenciarlo despues (ej. al
// anadir un servicio nuevo).
async function altaClienteChat(mensaje) {
  const extraccion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'El CEO esta dando de alta un cliente nuevo de la agencia. Extrae de su mensaje: el nombre del cliente/negocio, el enlace de Drive si lo menciona, y cualquier nota extra (sector, contacto, etc). Devuelve JSON: {"nombre":"","driveUrl":"","notas":""}. Si no se menciona un dato, dejalo vacio.' },
        { role: 'user', content: String(mensaje).slice(0, 500) },
      ],
    }),
  });
  if (!extraccion.ok) throw new Error(`OpenAI respondio ${extraccion.status}`);
  const data = await extraccion.json();
  let datos;
  try { datos = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { datos = {}; }
  if (!datos.nombre) return { ok: false, error: 'No se ha identificado el nombre del cliente nuevo.' };

  const cliente = {
    id: nextClienteId++,
    nombre: String(datos.nombre).slice(0, 120),
    driveUrl: String(datos.driveUrl || '').slice(0, 500),
    notas: String(datos.notas || '').slice(0, 500),
    servicios: [],
    createdAt: Date.now(),
  };
  clientes.unshift(cliente);
  saveState();
  return { ok: true, cliente };
}

// Mapa simple de servicio -> departamento real de la oficina, para asignar la
// orden al equipo correcto (mismo detectarDestinatarioChat que usa el chat).
function departamentoParaServicio(servicio) {
  const s = String(servicio || '').toLowerCase();
  if (/google\s*ads|meta\s*ads|facebook\s*ads|publicidad|anuncios/.test(s)) return 'ads';
  if (/seo|geo|aeo|posicionamiento/.test(s)) return 'seo';
  if (/web|landing|wordpress/.test(s)) return 'web';
  if (/automat|chatbot|whatsapp|n8n|ia\b/.test(s)) return 'automatizacion';
  if (/redes|social|instagram|tiktok|community/.test(s)) return 'community';
  if (/gmb|google\s*business/.test(s)) return 'seo';
  return 'operaciones';
}

// Anadir un servicio nuevo a un cliente YA existente (ej. "Soiz quiere
// tambien Google Ads y Meta Ads") -- registra el servicio en su ficha Y
// levanta una instruccion real al equipo/departamento que corresponda, para
// que quede como trabajo pendiente de verdad, no solo anotado.
async function anadirServicioClienteChat(mensaje) {
  const listaClientes = clientes.map((c) => c.nombre).join(', ') || '(ninguno dado de alta todavia)';
  const extraccion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `El CEO quiere anadir uno o varios servicios nuevos a un cliente YA existente. Clientes dados de alta: ${listaClientes}. Devuelve JSON: {"cliente":"nombre exacto de la lista o vacio","servicios":["servicio1","servicio2"]}. Si el cliente no esta en la lista, "cliente" vacio.` },
        { role: 'user', content: String(mensaje).slice(0, 500) },
      ],
    }),
  });
  if (!extraccion.ok) throw new Error(`OpenAI respondio ${extraccion.status}`);
  const data = await extraccion.json();
  let datos;
  try { datos = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { datos = {}; }
  const cliente = clientes.find((c) => c.nombre === datos.cliente);
  if (!cliente || !Array.isArray(datos.servicios) || !datos.servicios.length) {
    return { ok: false, error: `No se ha identificado el cliente (dados de alta: ${listaClientes}) o los servicios a anadir.` };
  }

  for (const servicio of datos.servicios) {
    cliente.servicios.push({ nombre: String(servicio).slice(0, 120), addedAt: Date.now() });
  }
  saveState();

  const equipos = [...new Set(datos.servicios.map(departamentoParaServicio))];
  for (const equipo of equipos) {
    const serviciosDeEsteEquipo = datos.servicios.filter((s) => departamentoParaServicio(s) === equipo);
    await pushInstruction({
      scope: 'team',
      target: equipo,
      message: `Nuevo servicio para el cliente ${cliente.nombre}: ${serviciosDeEsteEquipo.join(', ')}. Prepara el arranque real de este servicio.`,
      author: 'CEO (chat, alta de servicio)',
      skipAutomationCheck: true,
    });
  }
  return { ok: true, cliente, servicios: datos.servicios, equipos };
}

// Genera texto + hashtags reales para una publicacion de REDES SOCIALES de un
// cliente cualquiera (de la lista `clientes`, no solo las 4 marcas propias) --
// mismo patron que regenerarGmbPostChat pero para Instagram/Facebook en vez de
// Google Business. El CEO copia/pega el resultado a mano (sin API de
// publicacion para clientes todavia, igual que GMB).
async function generarPostClienteChat(mensaje) {
  const listaClientes = clientes.map((c) => c.nombre).join(', ') || '(ninguno dado de alta todavia)';
  const extraccion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `El CEO pide una publicacion de redes sociales (Instagram/Facebook) para un cliente. Clientes dados de alta: ${listaClientes}. Devuelve JSON: {"cliente":"nombre exacto de la lista o vacio","plataforma":"Instagram o Facebook, por defecto Instagram","instruccion":"de que debe hablar la publicacion, o vacio"}.` },
        { role: 'user', content: String(mensaje).slice(0, 500) },
      ],
    }),
  });
  if (!extraccion.ok) throw new Error(`OpenAI respondio ${extraccion.status}`);
  const dataExtraccion = await extraccion.json();
  let elegido;
  try { elegido = JSON.parse(dataExtraccion.choices?.[0]?.message?.content || '{}'); } catch { elegido = {}; }
  const cliente = clientes.find((c) => c.nombre === elegido.negocio || c.nombre === elegido.cliente);
  if (!cliente) {
    return { ok: false, error: `No se ha identificado el cliente (dados de alta: ${listaClientes}).` };
  }

  const systemPrompt = 'Eres el community manager de una agencia de marketing, escribiendo la publicacion de un cliente para Instagram/Facebook. Escribes en espanol de Espana, cercano, creible, NUNCA generico ni de relleno (prohibido "descubre", "no te lo pierdas", "la mejor opcion" sin contexto concreto). Devuelves SIEMPRE un unico objeto JSON valido, sin markdown.';
  const userPrompt = 'Cliente: ' + cliente.nombre + '\n' +
    (cliente.notas ? ('Notas del cliente: ' + cliente.notas + '\n') : '') +
    'Plataforma: ' + (elegido.plataforma || 'Instagram') + '\n' +
    (elegido.instruccion ? ('Instruccion concreta del CEO: ' + elegido.instruccion + '\n') : '') +
    '\nGenera UNA publicacion real y publicable hoy, en JSON con esta estructura EXACTA:\n' +
    '{"texto":"","hashtags":[],"ideaFoto":""}\n\n' +
    'texto: cuerpo de la publicacion, 400-900 caracteres, una sola idea concreta. hashtags: 5-8 hashtags reales relevantes (sin el simbolo #). ideaFoto: que foto o video real acompanaria esta publicacion.';

  const generacion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.6, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
  });
  if (!generacion.ok) throw new Error(`OpenAI respondio ${generacion.status}`);
  const dataGeneracion = await generacion.json();
  let contenido;
  try { contenido = JSON.parse(dataGeneracion.choices?.[0]?.message?.content || '{}'); } catch { contenido = {}; }
  if (!contenido.texto) return { ok: false, error: 'La IA no devolvio un texto valido.' };

  const fecha = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const plataforma = /facebook/i.test(elegido.plataforma || '') ? 'Facebook' : 'Instagram';
  const existente = clientePosts.find((p) => p.cliente === cliente.nombre && p.fecha === fecha && p.plataforma === plataforma && p.estado === 'pendiente');
  const post = existente || { id: nextClientePostId++, cliente: cliente.nombre, plataforma, fecha, createdAt: Date.now() };
  post.texto = sanitizeSpanishText(String(contenido.texto)).slice(0, 2200);
  post.hashtags = Array.isArray(contenido.hashtags) ? contenido.hashtags.map((h) => String(h).replace(/^#/, '').slice(0, 40)).slice(0, 10) : [];
  post.ideaFoto = String(contenido.ideaFoto || '').slice(0, 300);
  post.estado = 'pendiente';
  post.updatedAt = Date.now();
  if (!existente) {
    clientePosts.unshift(post);
    if (clientePosts.length > 300) clientePosts.length = 300;
  }
  saveState();
  upsertPlanSemanalIA(cliente.nombre, `${plataforma}: "${post.texto.slice(0, 80)}..." -- pendiente de publicar manual`);
  return { ok: true, cliente: cliente.nombre, post };
}

async function dispararAutomatizacionReal(entry) {
  const texto = entry.message || '';
  let intentosDetectados;
  let fuente = 'ia';

  try {
    intentosDetectados = await clasificarAutomatizacionesConIA(texto);
  } catch (err) {
    // Si OpenAI falla (red, clave, etc.) no se cae toda la deteccion --
    // se cae de vuelta al matching por palabras clave, mas limitado pero
    // sin dependencias externas.
    fuente = 'palabras_clave_fallback';
    intentosDetectados = REGLAS_AUTOMATIZACION_REAL.filter((r) => r.re.test(texto)).map((r) => r.intento);
  }

  if (!intentosDetectados.length) return null;

  const reglas = REGLAS_AUTOMATIZACION_REAL.filter((r) => intentosDetectados.includes(r.intento));
  const resultados = [];
  for (const regla of reglas) {
    // Algunas automatizaciones viven dentro de este mismo servidor (no en n8n)
    // -- ej. regenerar un post de Google Business ya generado con IA aqui
    // mismo. Estas usan "local" (una funcion) en vez de "path" (webhook n8n).
    if (regla.local) {
      try {
        const cuerpo = await regla.local(texto);
        resultados.push({ intento: regla.intento, disparado: true, ok: !!cuerpo.ok, respuesta: cuerpo, deteccion: fuente });
      } catch (err) {
        resultados.push({ intento: regla.intento, disparado: true, ok: false, error: String(err && err.message || err), deteccion: fuente });
      }
      continue;
    }
    try {
      const opciones = { method: regla.method || 'GET', signal: AbortSignal.timeout(30000) };
      if (opciones.method === 'POST') {
        opciones.headers = { 'Content-Type': 'application/json' };
        const marcaSolicitada = detectarMarcaExplicita(texto);
        const cuerpoPost = { tema: texto, ordenReal: true };
        if (marcaSolicitada) cuerpoPost.marcaSolicitada = marcaSolicitada;
        opciones.body = JSON.stringify(cuerpoPost);
      }
      const respuesta = await fetch(N8N_BASE + regla.path, opciones);
      let cuerpo = null;
      try { cuerpo = await respuesta.json(); } catch { /* sin cuerpo JSON, no pasa nada */ }
      resultados.push({ intento: regla.intento, disparado: true, ok: respuesta.ok, statusHttp: respuesta.status, respuesta: cuerpo, deteccion: fuente });
    } catch (err) {
      resultados.push({ intento: regla.intento, disparado: true, ok: false, error: String(err && err.message || err), deteccion: fuente });
    }
  }
  return resultados;
}

// Traduce la respuesta REAL (JSON) de una automatizacion a una frase que el
// CEO pueda leer directamente en el chat, en vez de solo el nombre del
// intento -- para que "revisa los errores" conteste con los errores reales,
// no con un "vale, enviado" vacio.
function resumirResultadoAutomatizacion(r) {
  const cuerpo = r.respuesta;
  if (!cuerpo) return null;
  if (r.intento === 'revisar_errores_n8n') {
    if (!cuerpo.hayErrores) return 'no hay ningun error real en las ultimas 24h en n8n, todo correcto';
    const lista = (cuerpo.errores || []).slice(0, 5).map((e) => {
      const det = e.detalle || {};
      return `${e.workflow || '?'}${det.nodo ? ' (' + det.nodo + ')' : ''}: ${det.mensaje || 'error sin detalle'}`;
    }).join(' | ');
    const extra = cuerpo.totalErrores > 5 ? ` y ${cuerpo.totalErrores - 5} más` : '';
    return `se han encontrado ${cuerpo.totalErrores} error(es) real(es) en las últimas 24h: ${lista}${extra}`;
  }
  if (r.intento === 'estado_ventas') {
    const e = cuerpo.por_estado || {};
    const grandes = cuerpo.pendientes_empresas_grandes || 0;
    const top = (cuerpo.top_categorias_pendientes || []).slice(0, 3).map((c) => `${c.categoria} (${c.total})`).join(', ');
    return `ahora mismo hay ${e.pendiente || 0} leads pendientes de llamar, ${e.contactado || 0} ya contactados y ${e.cita_agendada || 0} cita(s) agendada(s) en total. Hoy se han hecho ${cuerpo.llamadas_intentadas_hoy || 0} llamadas y ${cuerpo.citas_agendadas_hoy || 0} citas nuevas. De empresas grandes quedan ${grandes} pendientes. Las categorías con más pendientes son: ${top || 'sin datos'}.`;
  }
  if (r.intento === 'propuesta_auditoria') {
    if (!cuerpo.ok) return `no se ha podido preparar la propuesta: ${cuerpo.error}`;
    return `cadena auditoría->copy completa -> hallazgo real: "${(cuerpo.hallazgoReal || '').slice(0, 150)}..." -> propuesta lista: "${cuerpo.texto}"`;
  }
  if (r.intento === 'copy_con_investigacion') {
    return `cadena research->copy completa -> hallazgos reales: "${(cuerpo.hallazgos || '').slice(0, 200)}..." -> texto final: "${cuerpo.texto}"`;
  }
  if (r.intento === 'propuesta_lead') {
    if (!cuerpo.ok) return `no se ha podido preparar la propuesta: ${cuerpo.error || 'sin lead disponible'}`;
    const l = cuerpo.lead || {};
    return `cadena completa: lead real "${l.nombre}" (${l.categoria}, ${l.ciudad}) -> mensaje listo -> "${cuerpo.mensaje}"`;
  }
  if (r.intento === 'copy_bajo_demanda') {
    return `texto listo -> "${cuerpo.texto || 'no se pudo generar'}"`;
  }
  if (r.intento === 'investigar_competidor') {
    return `análisis real completado -> ${cuerpo.texto || 'no se pudo completar la investigación'}`;
  }
  if (r.intento === 'estado_auditorias') {
    const proximas = (cuerpo.proximasCitas || []).map((c) => `${c.nombre} (${c.tipo}) el ${new Date(c.fecha).toLocaleString('es-ES')}`).join('; ');
    return `hay ${cuerpo.totalSolicitadas || 0} auditoría(s) gratuita(s) solicitada(s) por WhatsApp en total, ${cuerpo.conCitaConfirmada || 0} con cita ya confirmada y ${cuerpo.sinCitaTodavia || 0} todavía sin agendar. ${proximas ? 'Próximas: ' + proximas + '.' : 'Sin próximas citas confirmadas.'}`;
  }
  if (r.intento === 'lanzar_llamadas') {
    if (cuerpo.primer_error && !cuerpo.llamadas) return `no se ha podido lanzar el lote: ${cuerpo.primer_error}`;
    return `lote real lanzado: ${cuerpo.llamadas || 0} llamada(s) iniciada(s) de verdad ahora mismo${cuerpo.errores ? `, ${cuerpo.errores} con error` : ''}.`;
  }
  if (r.intento === 'editar_gmb_negocio') {
    if (!cuerpo.ok) return `no se ha podido cambiar la publicación de Google Business: ${cuerpo.error}`;
    const p = cuerpo.post || {};
    return `publicación de Google Business de "${cuerpo.negocio}" actualizada -> "${p.titulo}": ${(p.texto || '').slice(0, 150)}... (botón ${p.ctaBoton}), visible en la Consola del CEO para copiar/pegar`;
  }
  if (r.intento === 'alta_cliente_nuevo') {
    if (!cuerpo.ok) return `no se ha podido dar de alta el cliente: ${cuerpo.error}`;
    return `cliente "${cuerpo.cliente.nombre}" dado de alta${cuerpo.cliente.driveUrl ? ' con carpeta de Drive guardada' : ''}`;
  }
  if (r.intento === 'generar_post_cliente') {
    if (!cuerpo.ok) return `no se ha podido generar la publicación: ${cuerpo.error}`;
    const p = cuerpo.post || {};
    return `publicación de ${p.plataforma} para "${cuerpo.cliente}" generada -> "${(p.texto || '').slice(0, 150)}..." (#${(p.hashtags || []).slice(0, 3).join(' #')}), visible en la Consola del CEO para copiar/pegar`;
  }
  if (r.intento === 'anadir_servicio_cliente') {
    if (!cuerpo.ok) return `no se ha podido añadir el servicio: ${cuerpo.error}`;
    return `añadido a "${cuerpo.cliente.nombre}": ${cuerpo.servicios.join(', ')} -- avisado el equipo de ${cuerpo.equipos.join(' y ')} para que lo arranque`;
  }
  if (r.intento === 'estado_equipo_ahora') {
    if (!cuerpo.departamentos || !cuerpo.departamentos.length) return `no hay ningun trabajador con actividad real registrada en las ultimas 2 horas (de ${cuerpo.totalRegistrados || 0} agentes en total)`;
    const partes = cuerpo.departamentos.map((d) => `${d.departamento} (${d.total}): ${d.ejemplos}`);
    return `${cuerpo.totalActivos} trabajador(es) con actividad real ahora mismo -> ${partes.join(' | ')}`;
  }
  if (r.intento === 'publicar_media_subida') {
    if (!cuerpo.ok) return `no se ha podido publicar el archivo subido: ${cuerpo.error}`;
    const m = cuerpo.media || {};
    return `publicacion real disparada con el ${m.tipo === 'video' ? 'video' : 'imagen'} que subiste (${m.nombreOriginal || 'archivo'}) -> "${(cuerpo.caption || '').slice(0, 150)}..."`;
  }
  if (r.intento === 'metricas_redes') {
    const partes = (cuerpo.cuentas || []).map((c) => {
      if (c.error) return `${c.cuenta}: error consultando (${c.error})`;
      const posts = c.ultimosPosts || [];
      if (!posts.length) return `${c.cuenta}: sin publicaciones recientes o sin datos`;
      const p = posts[0];
      const media = posts.reduce((s, x) => s + (x.alcance || 0), 0) / posts.length;
      return `${c.cuenta}: última pieza (${p.tipo}, ${p.fecha.slice(0, 10)}) con ${p.alcance} de alcance y ${p.vistas} vistas; media de las últimas ${posts.length} publicaciones: ${media.toFixed(1)} de alcance`;
    });
    return `métricas reales ahora mismo -> ${partes.join(' | ')}`;
  }
  if (r.intento === 'consultar_calendario_redes') {
    const describe = (c) => `${c.fecha} -> ${c.marca} (${(c.formatos || []).join('+') || 'sin formato'}${c.mejorHora ? `, ${c.mejorHora}` : ''})${c.resumen ? `: ${c.resumen.slice(0, 100)}` : ''}`;
    if (!cuerpo.totalProgramadas) return 'el calendario de contenido esta vacio ahora mismo, no hay ninguna publicacion programada guardada todavia';
    const partes = [];
    partes.push(cuerpo.hoy ? `hoy (${cuerpo.hoyStr}) toca -> ${describe(cuerpo.hoy)}` : `hoy (${cuerpo.hoyStr}) no hay nada programado en el calendario`);
    if (cuerpo.proximas && cuerpo.proximas.length) {
      partes.push(`próximas: ${cuerpo.proximas.map(describe).join(' | ')}`);
    }
    return partes.join(' -- ');
  }
  return null;
}

// Respuesta natural "en persona": cuando el CEO le habla a un trabajador o
// equipo concreto y la orden NO coincide con ninguna automatizacion real
// (dispararAutomatizacionReal), en vez de la frase generica de siempre se le
// pide a la IA que conteste como esa persona/equipo -- pero siempre anclada
// al catalogo real, nunca inventando cifras o trabajo que no existe. Si la
// pregunta encaja con algo real, la IA debe decirlo y sugerir disparar esa
// automatizacion (el CEO puede volver a escribir la orden que coincida).
async function responderComoTrabajador(entry, department) {
  const catalogo = REGLAS_AUTOMATIZACION_REAL.map((r) => `- ${r.intento}: ${r.descripcion}`).join('\n');
  let persona;
  if (entry.scope === 'worker') {
    const agent = publicAgents().find((item) => String(item.agent) === String(entry.target));
    persona = agent ? `Eres ${agent.name || agent.agent}, del equipo de ${department || 'operaciones'} de la oficina.` : `Eres un trabajador del equipo de ${department || 'operaciones'}.`;
  } else if (entry.scope === 'team') {
    persona = `Hablas en nombre del equipo de ${department || entry.target} al completo.`;
  } else {
    persona = 'Hablas en nombre de toda la oficina.';
  }

  const systemPrompt = `${persona} Trabajas para Virtual Marketing Spain (agencia de marketing digital) y su agencia de automatizaciones con IA. Te acaba de escribir el CEO por el chat interno de la oficina. Responde en espanol, en primera persona, breve y natural, como lo haria un compañero de verdad -- no como un bot generico.

Catalogo REAL de automatizaciones ya conectadas en esta oficina (las unicas que existen de verdad):
${catalogo}

Reglas:
- Si lo que pregunta el CEO SI encaja con algo del catalogo, dilo con naturalidad y anima a que lo lance (ej: "eso te lo puedo comprobar ahora mismo, dime 'revisa los errores' y lo disparo"). No hace falta repetir el nombre tecnico del intento.
- Si pregunta algo de tu puesto para lo que NO hay automatizacion real conectada (ej. cifras en vivo que no se guardan en ningun sitio consultable), se honesto: di que no tienes ese dato en tiempo real todavia, y si existe una accion real relacionada del catalogo, ofrecela como alternativa. Nunca inventes numeros ni cuentes trabajo como hecho si no lo es.
- No hables de "steps", "workExecutions" ni de ningun progreso simulado -- eso no existe para el CEO, solo existe lo real.
- Se breve: 2-4 frases como mucho.`;

  const respuesta = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: String(entry.message || '').slice(0, 500) },
      ],
    }),
  });
  if (!respuesta.ok) throw new Error(`OpenAI respondio ${respuesta.status}`);
  const data = await respuesta.json();
  const contenido = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!contenido) throw new Error('OpenAI sin contenido');
  return contenido;
}

async function pushInstruction(payload) {
  const entry = {
    id: nextInstructionId++,
    timestamp: Date.now(),
    scope: payload.scope || 'global',
    target: payload.target || 'all',
    message: truncate(payload.message || '', 240),
    author: payload.author || 'CEO',
  };
  instructions.push(entry);
  if (instructions.length > 200) instructions.shift();
  saveState();
  pushEvent(`instruction:${entry.target}`, {
    type: 'instruction',
    state: entry.scope,
    task: entry.message,
  });
  // Desactivado a peticion explicita del usuario (2026-09-08): estas dos
  // funciones fabricaban progreso visual falso (pasos "en_proceso"/"working"
  // asignados a agentes que no ejecutaban nada real) cada vez que llegaba una
  // instruccion de equipo/community. Se deja el resto del sistema intacto
  // (rutas API, render de UI, arrays en memoria) para no romper nada; solo se
  // deja de generar contenido fabricado nuevo.
  const socialExecution = null;
  const workExecutions = [];
  // skipAutomationCheck: usado por automatizaciones "locales" (ver mas abajo)
  // que ya construyen su propio mensaje de notificacion interna para un
  // equipo -- sin esto, ese mensaje podria volver a coincidir con la misma
  // automatizacion que lo genero (ej. "anadir servicio a cliente") y entrar
  // en un bucle infinito de re-disparo.
  const automatizacionReal = payload.skipAutomationCheck ? null : await dispararAutomatizacionReal(entry);
  if (automatizacionReal) {
    for (const r of automatizacionReal) {
      pushEvent(`instruction:${entry.target}`, {
        type: 'automatizacion_real',
        state: r.ok ? 'disparado' : 'error',
        task: r.ok
          ? `n8n confirmo la recepcion de la orden real (${r.intento})`
          : `n8n no respondio correctamente para ${r.intento}: ${r.error || r.statusHttp}`,
      });
    }
  }
  // Confirmacion literal e inmediata (real, no simulada): a diferencia de los
  // "workExecutions" fabricados de mas abajo, este texto es la unica cosa que
  // el panel puede prometer con certeza absoluta -- que la orden se guardo y,
  // cuales automatizaciones reales (si alguna) la recibieron. El usuario
  // pidio explicitamente que el chat del CEO conteste algo literal ("vale",
  // "si") en vez de quedar en silencio.
  let respuestaInmediata;
  if (automatizacionReal && automatizacionReal.length) {
    const exitosas = automatizacionReal.filter((r) => r.ok);
    const fallidas = automatizacionReal.filter((r) => !r.ok);
    const partes = [];
    if (exitosas.length) {
      partes.push(`se ha enviado a la automatización real: ${exitosas.map((r) => r.intento).join(', ')}`);
      for (const r of exitosas) {
        const resumen = resumirResultadoAutomatizacion(r);
        if (resumen) partes.push(resumen);
      }
    }
    if (fallidas.length) partes.push(`ha fallado al intentar: ${fallidas.map((r) => r.intento + ' (' + (r.error || 'error ' + r.statusHttp) + ')').join(', ')}`);
    respuestaInmediata = 'Vale, recibido. La orden ' + partes.join('; y ') + '.';
    entry.estado = fallidas.length && !exitosas.length ? 'error' : 'realizado';
  } else {
    let department = null;
    if (entry.scope === 'worker') {
      const agent = publicAgents().find((item) => String(item.agent) === String(entry.target));
      department = agent ? inferDepartment(agent) : null;
    } else if (entry.scope === 'team') {
      department = entry.target;
    }
    try {
      respuestaInmediata = await responderComoTrabajador(entry, department);
    } catch (err) {
      respuestaInmediata = 'Vale, recibido. Esta orden concreta todavía no coincide con ninguna automatización real conectada — queda registrada, pero el trabajo de los equipos de abajo es una simulación visual, no ejecución real.';
    }
    entry.estado = 'respondido';
  }
  entry.respuesta = respuestaInmediata;
  saveState();
  return { instruction: entry, socialExecution: socialExecution || null, workExecutions: workExecutions || [], automatizacionReal, respuestaInmediata };
}

function updateWorkExecution(executionId, action, stepKey = '') {
  const execution = workExecutions.find((item) => item.id === executionId);
  if (!execution) return null;
  if (action === 'start') {
    execution.status = 'en_proceso';
    execution.updatedAt = Date.now();
    if (execution.steps[0] && execution.steps[0].status === 'pendiente') execution.steps[0].status = 'en_proceso';
    if (execution.assigned[0]) execution.assigned[0].status = 'working';
  }
  if (action === 'complete_step') {
    const stepIndex = execution.steps.findIndex((step) => step.key === stepKey);
    if (stepIndex === -1) return null;
    execution.steps = execution.steps.map((step, index) => {
      if (index < stepIndex) return { ...step, status: 'hecho' };
      if (index === stepIndex) return { ...step, status: 'hecho' };
      if (index === stepIndex + 1 && execution.status !== 'hecho') return { ...step, status: 'en_proceso' };
      return step;
    });
    execution.status = execution.steps.every((step) => step.status === 'hecho') ? 'hecho' : 'en_proceso';
    execution.assigned = execution.assigned.map((worker, index) => ({
      ...worker,
      status: execution.status === 'hecho'
        ? 'hecho'
        : index < Math.min(stepIndex + 1, execution.assigned.length - 1)
          ? 'hecho'
          : index === Math.min(stepIndex + 1, execution.assigned.length - 1)
            ? 'working'
            : 'pendiente',
    }));
    execution.updatedAt = Date.now();
  }
  pushEvent(`work_execution:${execution.department}`, {
    type: 'work_execution',
    state: execution.status,
    task: truncate(`Ejecución ${execution.department} #${execution.id} actualizada`, 140),
  });
  saveState();
  return execution;
}

function sweepAgents() {
  const now = Date.now();
  let changed = false;
  for (const agent of agents.values()) {
    // Los agentes con mision fija (sin automatizacion real detras que los
    // vaya "viendo") no tienen una señal de actividad que vigilar — su
    // estado offline/sleeping no significaria nada real, solo ausencia de
    // heartbeat. Se quedan en su estado asignado indefinidamente. Los que
    // SI tienen automatizacion real (n8n-real-sync) siguen decayendo con
    // normalidad si esta deja de reportar.
    if (agent.metadata && agent.metadata.static) continue;
    const elapsed = now - agent.lastSeen;
    if (agent.state !== 'offline' && agent.state !== 'sleeping' && elapsed > offlineTimeout) {
      agent.state = 'sleeping';
      changed = true;
    } else if (agent.state === 'sleeping' && elapsed > offlineTimeout * 2) {
      agent.state = 'offline';
      changed = true;
    }
  }
  if (changed) broadcastAgents();
}

function broadcastAgents() {
  const message = JSON.stringify({ type: 'agents', agents: publicAgents() });
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function renderStatusHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miniverse Office</title>
  <style>
    body{margin:0;background:#0d0f14;color:#f4f4f7;font-family:Inter,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
    .box{max-width:780px;padding:32px;border:1px solid rgba(212,175,55,.25);background:rgba(18,20,28,.92);border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    h1{margin:0 0 12px;font-size:42px;line-height:1}
    p{color:#afb3c2;line-height:1.6}
    .links{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
    a{color:#111;background:#d4af37;padding:10px 14px;border-radius:999px;text-decoration:none;font-weight:700}
    code{display:block;margin-top:18px;padding:14px;background:#10131b;border-radius:14px;color:#ddd;white-space:pre-wrap}
  .plantilla-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-top:10px}
.plantilla-item{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 12px;cursor:pointer;transition:.15s}
.plantilla-item:hover{border-color:rgba(212,175,55,.4);background:rgba(212,175,55,.06)}
.plantilla-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#d4af37;font-weight:800;margin-bottom:5px}
.plantilla-texto{font-size:12.5px;color:#f3f3f5;line-height:1.5}
.plantilla-item.copiado{border-color:#23d18b}
</style>
</head>
<body>
  <div class="box">
    <h1>Miniverse Office</h1>
    <p>Servicio listo para correr 24/7. La oficina visual está en <strong>/office</strong> y los agentes reales reportan por <strong>/api/heartbeat</strong>.</p>
    <div class="links">
      <a href="/office">Abrir oficina</a>
      <a href="/api/info">API info</a>
      <a href="/api/agents">Agentes</a>
      <a href="/api/events">Eventos</a>
    </div>
    <code>POST /api/heartbeat
{ "agent": "director_general", "name": "Director General", "state": "working", "task": "Revisando prioridades" }</code>
  </div>
</body>
</html>`;
}

function inferDepartment(agent) {
  const text = `${agent.agent || ''} ${agent.name || ''}`.toLowerCase();
  if (/^tecnico_|soporte t[eé]cnico/.test(text)) return 'tecnico';
  if (/google_ads|ads_google/.test(text)) return 'ads_google';
  if (/meta_ads|ads_meta/.test(text)) return 'ads_meta';
  if (/(director|ceo|gerencia|admin)/.test(text)) return 'direccion';
  if (/(scraper|scrape)/.test(text)) return 'scraper';
  if (/(community|social|redes|instagram|tiktok|youtube|content)/.test(text)) return 'community';
  if (/(comercial|ventas|sales|closer|lead)/.test(text)) return 'comerciales';
  if (/(seo|geo|aeo|sem|posicionamiento)/.test(text)) return 'seo';
  if (/(web|developer|dev|frontend|backend|wordpress|diseño|design)/.test(text)) return 'web';
  if (/(automat|n8n|bot|chatbot|ia|ai|workflow)/.test(text)) return 'automatizacion';
  if (/(pentest|seguridad|security)/.test(text)) return 'pentesting';
  return 'operaciones';
}

// Detecta si un mensaje libre del chat va dirigido a un trabajador concreto
// (por su id o nombre, como palabra completa para evitar falsos positivos
// tipo "Ana" dentro de "mañana") o a un equipo/departamento por palabra clave.
// Si no se detecta nada especifico, se trata como dirigido a toda la oficina.
function detectarDestinatarioChat(mensaje) {
  const texto = String(mensaje || '').toLowerCase();
  for (const agent of publicAgents()) {
    const id = String(agent.agent || '');
    const nombre = String(agent.name || '');
    for (const candidato of [id, nombre]) {
      if (candidato.length < 4) continue;
      const escapado = candidato.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('\\b' + escapado + '\\b').test(texto)) {
        return { scope: 'worker', target: id };
      }
    }
  }
  const equipos = {
    tecnico: /equipo\s*t[eé]cnico|soporte\s*t[eé]cnico|t[eé]cnicos\b/,
    community: /\b(community|redes sociales|instagram|tiktok|youtube)\b/,
    comerciales: /\b(comercial(es)?|ventas|closer)\b/,
    seo: /\bseo\b|\bgeo\b|\baeo\b|posicionamiento/,
    web: /\bweb\b|frontend|backend|wordpress/,
    automatizacion: /automatizaci[oó]n(es)?|\bn8n\b/,
    pentesting: /pentest|seguridad t[eé]cnica/,
    direccion: /direcci[oó]n|gerencia/,
  };
  for (const [dept, re] of Object.entries(equipos)) {
    if (re.test(texto)) return { scope: 'team', target: dept };
  }
  return { scope: 'global', target: 'all' };
}

// /office y /ceo comparten la misma plantilla base (renderOfficeHtml) para no
// duplicar 900+ lineas de HTML/CSS/JS ya probadas -- cada ruta simplemente
// recorta, con marcadores HTML (comentarios, seguros dentro de un template
// literal), la seccion que no le corresponde. /office se queda solo con la
// cuadricula de agentes; /ceo se queda solo con la consola de ordenes y las
// metricas, para que la oficina visual quede mas limpia.
function stripMarkedSection(html, marcador, reemplazo) {
  const inicio = `<!--${marcador}_INICIO-->`;
  const fin = `<!--${marcador}_FIN-->`;
  const i = html.indexOf(inicio);
  const f = html.indexOf(fin);
  if (i === -1 || f === -1) return html;
  return html.slice(0, i) + reemplazo + html.slice(f + fin.length);
}

const SIDEBAR_LINKS = [
  { key: 'office', href: '/office', label: 'Oficina', icon: '&#127970;' },
  { key: 'ceo', href: '/ceo', label: 'Consola CEO', icon: '&#127919;' },
  { key: 'operations', href: '/operations', label: 'Operaciones', icon: '&#9881;' },
  { key: 'manual', href: '/manual', label: 'Manual', icon: '&#128214;' },
  { key: 'inbox', href: '/inbox', label: 'Inbox', icon: '&#128229;' },
  { key: 'calendario', href: '/calendario-semanal', label: 'Calendario', icon: '&#128197;' },
  { key: 'estado', href: '/estado-sistema', label: 'Estado sistema', icon: '&#129513;' },
];

function renderSidebarHtml(activeKey) {
  const items = SIDEBAR_LINKS.map((l) => `<a class="vms-nav-link${l.key === activeKey ? ' active' : ''}" href="${l.href}"><span class="vms-nav-icon">${l.icon}</span><span>${l.label}</span></a>`).join('');
  return `<aside class="vms-nav-sidebar">
    <div class="vms-nav-brand">VMS<span>Oficina Virtual</span></div>
    <nav class="vms-nav-links">${items}</nav>
    <a class="vms-nav-link vms-nav-logout" href="/logout"><span class="vms-nav-icon">&#8617;</span><span>Cerrar sesi&oacute;n</span></a>
  </aside>`;
}

const SIDEBAR_CSS = `
html,body{overflow-x:hidden;max-width:100%}
body{padding-left:222px}
.vms-nav-sidebar{position:fixed;top:0;left:0;bottom:0;width:222px;background:rgba(14,14,19,.98);border-right:1px solid rgba(212,175,55,.18);display:flex;flex-direction:column;padding:22px 14px;gap:4px;overflow-y:auto;z-index:9999}
.vms-nav-brand{color:#d4af37;font-weight:900;font-size:18px;letter-spacing:.04em;margin-bottom:18px;display:flex;flex-direction:column;line-height:1.2}
.vms-nav-brand span{color:#888;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.1em}
.vms-nav-links{display:flex;flex-direction:column;gap:4px;flex:1}
.vms-nav-link{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;color:#c9c9d2;text-decoration:none;font-size:13.5px;font-weight:600}
.vms-nav-link:hover{background:rgba(255,255,255,.06)}
.vms-nav-link.active{background:rgba(212,175,55,.14);color:#d4af37}
.vms-nav-icon{font-size:15px;width:18px;text-align:center;flex-shrink:0}
.vms-nav-logout{margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px;color:#ff8b8b}
@media(max-width:820px){
  .vms-nav-sidebar{position:relative;width:100%;flex-direction:row;flex-wrap:wrap;height:auto;padding:12px;border-right:none;border-bottom:1px solid rgba(212,175,55,.18)}
  .vms-nav-brand{display:none}
  .vms-nav-links{flex-direction:row;flex-wrap:wrap}
  body{padding-left:0}
}
.vms-tabs-bar{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 18px;padding:6px;background:rgba(255,255,255,.03);border:1px solid rgba(212,175,55,.14);border-radius:14px}
.vms-tabs-bar:empty{display:none;margin:0}
.vms-tab-btn{appearance:none;border:none;background:transparent;color:#9a9aa6;font-weight:700;font-size:13px;padding:9px 16px;border-radius:10px;cursor:pointer;white-space:nowrap;font-family:inherit}
.vms-tab-btn:hover{color:#d4d4de;background:rgba(255,255,255,.05)}
.vms-tab-btn.active{background:rgba(212,175,55,.16);color:#d4af37}
.vms-tab-panel{display:none}
.vms-tab-panel.active{display:block}
@media(max-width:820px){.vms-tabs-bar{gap:4px}.vms-tab-btn{padding:8px 12px;font-size:12px}}
`;

function renderOfficeHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Oficina Virtual</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:radial-gradient(circle at top left,rgba(212,175,55,.14),transparent 24%),radial-gradient(circle at top right,rgba(255,255,255,.08),transparent 18%),linear-gradient(180deg,#0b0b0f 0%,#13131a 100%);color:#f3f3f5;min-height:100vh}
.shell{max-width:1440px;margin:0 auto;padding:28px}
.hero{display:grid;grid-template-columns:1.35fr .85fr;gap:20px;align-items:stretch}
.panel{background:rgba(20,20,27,.86);border:1px solid rgba(212,175,55,.20);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.32);backdrop-filter:blur(12px)}
.hero-copy{padding:34px}
.eyebrow{color:#d4af37;font-size:12px;text-transform:uppercase;letter-spacing:.2em;margin-bottom:14px}
h1{margin:0 0 14px;font-size:clamp(32px,4vw,56px);line-height:.95}
.sub{color:#b8b8c3;font-size:16px;line-height:1.6;max-width:800px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:22px}
.stat{padding:16px;border-radius:18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.stat b{display:block;font-size:28px;margin-bottom:6px}
.stat span{color:#aaaab6;font-size:13px}
.hero-side{padding:24px;display:flex;flex-direction:column;gap:16px}
.signal{padding:18px;border-radius:18px;background:linear-gradient(180deg,rgba(212,175,55,.15),rgba(212,175,55,.04));border:1px solid rgba(212,175,55,.28)}
.signal h2{margin:0 0 8px;font-size:18px}
.signal p{margin:0;color:#d7d7de;font-size:14px;line-height:1.5}
.mini-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.mini-card{padding:16px;border-radius:18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.mini-card strong{display:block;font-size:14px;margin-bottom:6px}
.mini-card span{color:#a9a9b4;font-size:13px}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:24px 0 18px}
.toolbar h3{margin:0;font-size:22px}
.toolbar .hint{color:#9f9fac;font-size:14px}
.metrics-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;margin-bottom:18px}
.metrics-card{padding:18px}
.metrics-card h3{margin:0 0 14px;font-size:20px}
.metrics-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.metric-line{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;gap:12px}
.metric-line span{color:#acacb8;font-size:13px}
.metric-line strong{font-size:16px}
.events-list{display:grid;gap:10px}
.event-line{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.event-line strong{display:block;font-size:13px;margin-bottom:4px}
.event-line span{color:#a9a9b4;font-size:12px;line-height:1.45}
.command-grid{display:grid;grid-template-columns:1fr;gap:18px;margin-bottom:18px}
.command-card{padding:18px}
.command-card h3{margin:0 0 14px;font-size:20px}
.field{display:grid;gap:8px;margin-bottom:12px}
.field label{font-size:13px;color:#b9b9c4}
.field input,.field select,.field textarea{width:100%;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:14px;padding:12px 14px;font:inherit}
.field textarea{min-height:110px;resize:vertical}
.button-row{display:flex;gap:10px;flex-wrap:wrap}
.quick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}
.quick-btn{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#f4f4f7;font-weight:700;padding:10px 12px;border-radius:14px;cursor:pointer;font-size:12px}
.quick-btn:hover{border-color:rgba(212,175,55,.45);background:rgba(212,175,55,.08)}
.btn-gold{border:none;background:#d4af37;color:#121216;font-weight:800;padding:12px 16px;border-radius:999px;cursor:pointer}
.btn-dark{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#f4f4f7;font-weight:700;padding:12px 16px;border-radius:999px;cursor:pointer}
.command-status{margin-top:12px;font-size:13px;color:#b8c7b0}
.reply-card{margin-top:12px;padding:14px 16px;border-radius:16px;background:rgba(35,209,139,.06);border:1px solid rgba(35,209,139,.25);animation:replyIn .25s ease}
.reply-card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.reply-card-avatar{width:34px;height:34px;border-radius:12px;background:rgba(35,209,139,.15);color:#23d18b;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:0 0 auto}
.reply-card-name{font-weight:800;color:#f3f3f5;font-size:13.5px}
.reply-card-sub{font-size:11.5px;color:#8a9a92}
.reply-steps{display:grid;gap:6px;margin-top:4px}
.reply-step{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:6px 10px;border-radius:10px;background:rgba(255,255,255,.03)}
.reply-step b{font-weight:700}
.reply-step b.pendiente{color:#f0b94f}.reply-step b.en_proceso{color:#57c7ff}.reply-step b.hecho{color:#23d18b}
@keyframes replyIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.instruction-list{display:grid;gap:10px;max-height:520px;overflow-y:auto}
.instruction-line{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.instruction-line strong{display:block;font-size:13px;margin-bottom:4px}
.instruction-line span{color:#a9a9b4;font-size:12px;line-height:1.45}
.social-exec-list{display:grid;gap:10px}
.social-exec{padding:14px;border-radius:18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);display:grid;gap:10px}
.social-exec-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.social-exec-title{font-size:14px;font-weight:800}
.social-exec-meta{font-size:12px;color:#a9a9b4}
.social-badge{display:inline-flex;align-items:center;justify-content:center;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}
.social-badge.pendiente{background:rgba(240,185,79,.12);color:#f0b94f}
.social-badge.en_proceso{background:rgba(87,199,255,.12);color:#57c7ff}
.social-badge.hecho{background:rgba(35,209,139,.12);color:#23d18b}
.social-steps{display:grid;gap:8px}
.steps-progress{display:flex;align-items:center;gap:10px;margin:8px 0}
.steps-progress-bar{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.steps-progress-bar span{display:block;height:100%;background:linear-gradient(90deg,#d4af37,#f0d97a);border-radius:999px;transition:width .3s ease}
.steps-progress b{font-size:11px;color:#d4af37;white-space:nowrap}
.social-step{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);font-size:12px}
.social-step span{color:#cfd0d8}
.social-step b{font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.social-step b.pendiente{color:#f0b94f}
.social-step b.en_proceso{color:#57c7ff}
.social-step b.hecho{color:#23d18b}
.social-assigned{display:flex;flex-wrap:wrap;gap:8px}
.social-worker{padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);font-size:11px;color:#d9dae2}
.social-worker.working{border-color:rgba(87,199,255,.4);color:#57c7ff}
.social-worker.hecho{border-color:rgba(35,209,139,.4);color:#23d18b}
.work-exec-list{display:grid;gap:10px}
.resource-list{display:flex;flex-wrap:wrap;gap:8px}
.resource-chip{padding:7px 10px;border-radius:999px;background:rgba(212,175,55,.08);border:1px solid rgba(212,175,55,.18);font-size:11px;color:#f0d679}
.token-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.token-row input{flex:1 1 240px;min-width:0}
.biz-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;margin-bottom:18px}
.biz-card{padding:18px}
.biz-card h3{margin:0 0 14px;font-size:20px}
.biz-top{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
.kpi{padding:14px;border-radius:18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.kpi b{display:block;font-size:24px;margin-bottom:4px}
.kpi span{display:block;color:#a9a9b4;font-size:12px}
.kpi small{color:#d4af37;font-size:12px}
.bars{display:grid;gap:10px}
.bar{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.bar-head{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:8px}
.bar-track{height:10px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden}
.bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#d4af37,#f6d36d)}
.biz-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.biz-note{margin-top:12px;padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);font-size:12px;color:#b1b1bc;line-height:1.5}
.status-ok{color:#23d18b}.status-warn{color:#f0b94f}.status-error{color:#ff6467}
.office{display:grid;grid-template-columns:1fr;gap:14px}
.office-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.office-toolbar-left{display:flex;gap:10px;flex-wrap:wrap}
.office-chip{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#f4f4f7;border-radius:999px;padding:9px 12px;font-size:12px;font-weight:700;cursor:pointer}
.office-chip.active{background:rgba(212,175,55,.14);border-color:rgba(212,175,55,.35);color:#f6d36d}
.zone{padding:0;min-height:auto;overflow:hidden}
.zone-details{border-radius:22px}
.zone-summary{list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 20px;cursor:pointer}
.zone-summary::-webkit-details-marker{display:none}
.zone-summary-main{display:flex;align-items:center;gap:12px;min-width:0}
.zone-summary h4{margin:0;font-size:18px}
.zone-count{color:#b1b1bc;font-size:13px}
.zone-body{padding:0 18px 18px}
.pill{padding:6px 10px;border-radius:999px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#121216;background:#d4af37;font-weight:700}
.desks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.desk{border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02)),rgba(14,14,18,.9);border:1px solid rgba(255,255,255,.06);padding:14px;min-height:130px;position:relative;overflow:hidden}
.desk::before{content:"";position:absolute;inset:auto -10% 0 auto;width:120px;height:120px;background:radial-gradient(circle,rgba(212,175,55,.12),transparent 65%)}
.desk-top{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.avatar{width:40px;height:40px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;background:rgba(212,175,55,.12);color:#f6d36d;font-weight:800;flex:0 0 auto}
.desk-name{font-size:14px;font-weight:700}
.desk-role{color:#9a9aa6;font-size:12px}
.desk-status{display:inline-flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:#d7d7de}
.dot{width:10px;height:10px;border-radius:999px;background:#777;box-shadow:0 0 0 4px rgba(255,255,255,.03)}
.dot.working{background:#23d18b}.dot.idle{background:#f0b94f}.dot.thinking{background:#d77dff}.dot.speaking{background:#57c7ff}.dot.error{background:#ff6467}.dot.sleeping{background:#8794ff}.dot.offline{background:#666a73}
.task{color:#a5a5b0;font-size:12px;line-height:1.5;min-height:36px}
.desk-empty{display:grid;place-items:center;color:#767684;font-size:13px;min-height:130px;border:1px dashed rgba(255,255,255,.1);border-radius:18px}
.picker-layout{display:grid;grid-template-columns:.5fr 1.5fr;gap:12px}
.target-panel{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.target-panel h5{margin:0 0 10px;font-size:13px;color:#d9d9e2}
.target-select{width:100%;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:14px;padding:12px 14px;font:inherit}
.target-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;max-height:560px;overflow:auto;padding-right:4px}
.target-card{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#f4f4f7;border-radius:16px;padding:12px;cursor:pointer;text-align:left;display:grid;gap:8px;transition:.15s ease}
.target-card:hover{border-color:rgba(212,175,55,.35);background:rgba(212,175,55,.08)}
.target-card.active{border-color:rgba(212,175,55,.5);background:rgba(212,175,55,.12);box-shadow:0 0 0 1px rgba(212,175,55,.15) inset}
.target-card-head{display:flex;align-items:center;gap:10px}
.target-card-name{font-size:13px;font-weight:800;line-height:1.2}
.target-card-sub{font-size:11px;color:#a9a9b4;line-height:1.35}
.target-card-task{font-size:11px;color:#bfc0cb;line-height:1.35}
.field-inline-note{margin-top:8px;color:#9f9fac;font-size:12px}
.footer-note{margin-top:18px;color:#8f8f9d;font-size:13px}
@media (max-width:1280px){
  .metrics-grid,.biz-grid,.command-grid{grid-template-columns:1fr}
  .desks{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width:1024px){
  .hero,.picker-layout{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .mini-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .desks{grid-template-columns:repeat(2,minmax(0,1fr))}
  .biz-top{grid-template-columns:repeat(2,minmax(0,1fr))}
  .biz-form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:768px){
  .shell{padding:16px}
  h1{font-size:clamp(28px,8vw,42px)}
  .sub{font-size:14px}
  .stats,.mini-grid,.target-grid,.biz-top,.biz-form-grid{grid-template-columns:1fr}
  .desks{grid-template-columns:1fr}
  .toolbar,.office-toolbar,.zone-summary,.bar-head{align-items:flex-start}
  .token-row,.button-row{flex-direction:column}
  .token-row input,.btn-gold,.btn-dark{width:100%}
  .field input,.field select,.field textarea,.target-select{font-size:16px}
  .command-card,.metrics-card,.biz-card,.hero-copy,.hero-side{padding:16px}
  .zone-summary{padding:16px}
  .zone-body{padding:0 16px 16px}
}
@media (max-width:480px){
  .stat b,.kpi b{font-size:22px}
  .office-chip{width:100%;text-align:center}
  .pill{font-size:10px}
  .desk{min-height:120px}
}
${SIDEBAR_CSS}
</style>
</head>
<body>
${renderSidebarHtml('office')}
<div class="shell">
  <div id="vms-tabs-bar" class="vms-tabs-bar"></div>
  <div class="vms-tab-panel" data-tab-label="Resumen">
  <section class="hero">
    <div class="panel hero-copy">
      <div class="eyebrow">Virtual HQ · 24/7</div>
      <h1>La oficina virtual<br>de tu empresa</h1>
      <p class="sub">Un centro de mando vivo para dirección, community managers, comerciales, SEO, automatización y web. Bonito, claro y preparado para crecer.</p>
      <div class="stats">
        <div class="stat"><b id="stat-online">0</b><span>Agentes activos</span></div>
        <div class="stat"><b id="stat-total">0</b><span>Puestos ocupados</span></div>
        <div class="stat"><b id="stat-working">0</b><span>Trabajando ahora</span></div>
      </div>
    </div>
    <aside class="panel hero-side">
      <div class="signal">
        <h2>Centro de control</h2>
        <p>Este panel está pensado para que tú solo recibas visión, resultados y bloqueos. El trabajo lo hace el sistema.</p>
      </div>
      <div class="mini-grid">
        <div class="mini-card"><strong>Dirección</strong><span>Prioridades, control y reporting.</span></div>
        <div class="mini-card"><strong>Community</strong><span>Contenido y redes sociales.</span></div>
        <div class="mini-card"><strong>Comerciales</strong><span>Captación y seguimiento.</span></div>
        <div class="mini-card"><strong>SEO & Web</strong><span>Tráfico, páginas y conversión.</span></div>
      </div>
    </aside>
  </section>
  <div class="toolbar">
    <h3>Equipos y puestos</h3>
    <div class="hint">Actualización automática cada 5 segundos</div>
  </div>
  <section class="metrics-grid">
    <div class="panel metrics-card">
      <h3>Vista ejecutiva</h3>
      <div class="events-list">
        <div class="event-line">
          <strong>Oficina principal</strong>
          <span>Esta vista muestra equipo, métricas, instrucciones y control ejecutivo.</span>
        </div>
        <div class="event-line">
          <strong>Operaciones</strong>
          <span>Las ejecuciones sociales y el motor general están separadas para no ensuciar la oficina.</span>
        </div>
      </div>
    </div>
    <div class="panel metrics-card">
      <h3>Estado de estructura</h3>
      <div class="events-list">
        <div class="event-line"><strong>Workers vivos</strong><span>Siempre visibles en la oficina principal.</span></div>
        <div class="event-line"><strong>Métricas</strong><span>Resumen ejecutivo y control de negocio.</span></div>
        <div class="event-line"><strong>Histórico</strong><span>Separado del panel principal para mantener claridad.</span></div>
      </div>
    </div>
  </section>
  </div>
  <!--CEO_CONSOLE_INICIO-->
  <div class="vms-tab-panel" data-tab-label="Consola CEO">
  <section class="metrics-grid">
    <div class="panel metrics-card">
      <h3>Panel de métricas</h3>
      <div class="metrics-list" id="metrics-list"></div>
    </div>
    <div class="panel metrics-card">
      <h3>Actividad reciente</h3>
      <div class="events-list" id="events-list"></div>
    </div>
  </section>
  <section class="command-grid">
    <div class="panel command-card">
      <h3>Consola del CEO</h3>
      <div class="token-row">
        <input id="ceo-token" placeholder="Token privado del CEO">
        <button class="btn-dark" id="save-token">Guardar token</button>
      </div>
      <div class="field">
        <label for="scope">Tipo de instrucción</label>
        <select id="scope">
          <option value="worker">Trabajador concreto</option>
          <option value="team">Equipo / departamento</option>
          <option value="global">Toda la oficina</option>
        </select>
      </div>
      <div class="field">
        <label for="target">Destino</label>
        <input id="target" placeholder="ej: social_instagram_main, community, seo, all" type="hidden">
        <div class="picker-layout">
          <div class="target-panel">
            <h5>Equipo / departamento</h5>
            <select id="target-group" class="target-select">
              <option value="all">Toda la oficina</option>
            </select>
            <div class="field-inline-note" id="target-helper">Selecciona grupo o trabajador sin escribirlo a mano.</div>
          </div>
          <div class="target-panel">
            <h5>Trabajadores del grupo</h5>
            <div class="target-grid" id="target-grid"></div>
          </div>
        </div>
      </div>
      <div class="field">
        <label for="author">Quién da la orden</label>
        <input id="author" value="CEO">
      </div>
      <div class="field">
        <label for="message">Instrucción</label>
        <textarea id="message" placeholder="Ej: prepara 3 ideas para Google Business de Terapia de Masajes y prioriza una publicación esta semana. Para publicar una foto/video propio, adjuntalo con el clip y escribe 'publica esto'."></textarea>
      </div>
      <input type="file" id="command-media-input" accept="image/*,video/*" style="display:none">
      <div class="button-row">
        <button class="btn-gold" id="send-command">Enviar instrucción</button>
        <button class="btn-dark" id="fill-global">Prioridad global</button>
        <button class="btn-dark" id="fill-social">Orden a redes</button>
        <button class="btn-dark" id="fill-tecnico">🔧 Aviso a Técnicos</button>
        <button class="btn-dark" id="command-media-clip" type="button" title="Adjuntar una foto o video para publicar en redes sociales">📎 Adjuntar foto/video</button>
      </div>
      <div class="command-status" id="command-media-status">Sin archivo adjunto.</div>
      <div class="command-status" id="command-status">Listo para enviar órdenes.</div>
      <div id="command-reply"></div>
    </div>
    <div class="panel command-card">
      <h3>Chat directo con la IA (soporte)</h3>
      <div class="events-list" id="ceo-chat-log" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
      <div class="field" style="margin-top:10px">
        <textarea id="ceo-chat-input" placeholder="Pregunta algo, pide ayuda, o adjunta una foto/video y escribe 'publica esto'..." rows="2"></textarea>
      </div>
      <input type="file" id="ceo-media-input" accept="image/*,video/*" style="display:none">
      <div class="button-row">
        <button class="btn-gold" id="ceo-chat-send">Enviar</button>
        <button class="btn-dark" id="ceo-media-clip" type="button" title="Adjuntar una foto o video para publicar en redes">📎 Adjuntar foto/video</button>
      </div>
      <div class="command-status" id="ceo-media-status">Sin archivo adjunto.</div>
      <div class="command-status" id="ceo-chat-status">Listo para hablar.</div>
    </div>
    <div class="panel command-card">
      <h3>Últimas instrucciones</h3>
      <div class="instruction-list" id="instruction-list"></div>
    </div>
  </section>
  </div>
  <div class="vms-tab-panel" data-tab-label="Informes y auditorías">
  <section class="command-grid">
    <div class="panel command-card">
      <h3>Informes diarios (HTML + PDF)</h3>
      <div class="instruction-list" id="reportes-list"></div>
    </div>
    <div class="panel command-card">
      <h3>Auditorías solicitadas (WhatsApp)</h3>
      <div class="instruction-list" id="auditorias-list"></div>
    </div>
    <div class="panel command-card">
      <h3>Flyers pendientes de aprobar</h3>
      <div class="instruction-list" id="flyers-list"></div>
    </div>
  </section>
  </div>
  <div class="vms-tab-panel" data-tab-label="Google Business">
  <section class="command-grid">
    <div class="panel command-card">
      <h3>Google Business — publicar manual (sin API todavia)</h3>
      <div class="instruction-list" id="gmb-posts-list"></div>
    </div>
  </section>
  </div>
  <div class="vms-tab-panel" data-tab-label="Redes cliente (manual)">
  <section class="command-grid">
    <div class="panel command-card">
      <h3>Redes sociales de clientes — publicar manual (sin API todavia)</h3>
      <p style="margin-top:0;font-size:12.5px;color:#999">Pídelo por chat: "publicación para [cliente]" (el cliente debe estar dado de alta antes). Genera texto + hashtags reales listos para copiar/pegar.</p>
      <div class="instruction-list" id="cliente-posts-list"></div>
    </div>
  </section>
  </div>
  <div class="vms-tab-panel" data-tab-label="Métricas y negocio">
  <section class="biz-grid">
    <div class="panel biz-card">
      <h3>Métricas interactivas</h3>
      <div class="biz-top" id="biz-top"></div>
      <div class="bars" id="biz-bars"></div>
      <div class="biz-note" id="biz-note">Sin notas de negocio por ahora.</div>
    </div>
    <div class="panel biz-card">
      <h3>Editor de negocio</h3>
      <div class="biz-form-grid">
        <div class="field"><label for="m-ventas">Ventas</label><input id="m-ventas" type="number" min="0" step="1"></div>
        <div class="field"><label for="m-captaciones">Captaciones</label><input id="m-captaciones" type="number" min="0" step="1"></div>
        <div class="field"><label for="m-gastos">Gastos (€)</label><input id="m-gastos" type="number" min="0" step="0.01"></div>
        <div class="field"><label for="m-ganancias">Ganancias (€)</label><input id="m-ganancias" type="number" min="0" step="0.01"></div>
        <div class="field"><label for="m-suscriptores">Suscriptores</label><input id="m-suscriptores" type="number" min="0" step="1"></div>
        <div class="field"><label for="m-n8n-status">Estado n8n</label><select id="m-n8n-status"><option value="ok">OK</option><option value="warn">Aviso</option><option value="error">Error</option></select></div>
        <div class="field"><label for="m-n8n-workflows">Workflows activos</label><input id="m-n8n-workflows" type="number" min="0" step="1"></div>
        <div class="field"><label for="m-n8n-exec">Ejecuciones hoy</label><input id="m-n8n-exec" type="number" min="0" step="1"></div>
        <div class="field"><label for="m-n8n-posts">Publicaciones hoy</label><input id="m-n8n-posts" type="number" min="0" step="1"></div>
      </div>
      <div class="field"><label for="m-notes">Notas</label><textarea id="m-notes" placeholder="Ej: hoy miércoles 12 de agosto de 2026 se publicó Instagram manualmente y toca revisar rate limits de Meta."></textarea></div>
      <div class="button-row">
        <button class="btn-gold" id="save-metrics">Guardar métricas</button>
        <button class="btn-dark" id="sync-metrics-auto">Sincronizar automatico</button>
      </div>
      <div class="command-status" id="metrics-status">Listo para actualizar métricas.</div>
    </div>
  </section>
  </div>
  <!--CEO_CONSOLE_FIN-->
  <!--AGENT_GRID_INICIO-->
  <div class="vms-tab-panel" data-tab-label="Equipo">
  <div class="office-toolbar">
    <div class="office-toolbar-left" id="office-filter"></div>
    <div class="hint">Pulsa un grupo para ver solo ese equipo y hablar más rápido con quien toque.</div>
  </div>
  <section class="office" id="office"></section>
  </div>
  <!--AGENT_GRID_FIN-->
  <div class="footer-note">Usa nombres como director_general, cm_vms, ventas_01, seo_lead o web_dev para que la oficina organice mejor a cada agente.</div>
</div>
<script>
function escapeHtml(value){
  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
const ZONES=[
  {key:'direccion',title:'Dirección',tag:'CEO / Control'},
  {key:'ads_google',title:'Google Ads',tag:'Búsqueda / Display'},
  {key:'ads_meta',title:'Meta Ads',tag:'Facebook / Instagram'},
  {key:'community',title:'Community & Redes',tag:'Contenido'},
  {key:'comerciales',title:'Comerciales',tag:'Ventas'},
  {key:'scraper',title:'Scrapers e Investigación',tag:'Leads'},
  {key:'seo',title:'SEO / GEO / AEO',tag:'Tráfico'},
  {key:'web',title:'Páginas Web',tag:'Conversión'},
  {key:'automatizacion',title:'IA & Automatización',tag:'Escala'},
  {key:'pentesting',title:'Pentesting / Seguridad',tag:'Seguridad'},
  {key:'tecnico',title:'Soporte Técnico',tag:'Reparación'},
  {key:'operaciones',title:'Operaciones',tag:'Soporte'}
];
function inferDepartment(agent){
  const text=(String(agent.agent||'')+' '+String(agent.name||'')).toLowerCase();
  if (/^tecnico_|soporte t[eé]cnico/.test(text)) return 'tecnico';
  if (/google_ads|ads_google/.test(text)) return 'ads_google';
  if (/meta_ads|ads_meta/.test(text)) return 'ads_meta';
  if (/(director|ceo|gerencia|admin)/.test(text)) return 'direccion';
  if (/(scraper|scrape)/.test(text)) return 'scraper';
  if (/(community|social|redes|instagram|tiktok|youtube|content)/.test(text)) return 'community';
  if (/(comercial|ventas|sales|closer|lead)/.test(text)) return 'comerciales';
  if (/(seo|geo|aeo|sem|posicionamiento)/.test(text)) return 'seo';
  if (/(web|developer|dev|frontend|backend|wordpress|diseño|design)/.test(text)) return 'web';
  if (/(automat|n8n|bot|chatbot|ia|ai|workflow)/.test(text)) return 'automatizacion';
  if (/(pentest|seguridad|security)/.test(text)) return 'pentesting';
  return 'operaciones';
}
function stateLabel(state){
  const map={working:'Trabajando',idle:'En espera',thinking:'Pensando',speaking:'Hablando',sleeping:'Pausado',error:'Con incidencia',offline:'Desconectado',collaborating:'Colaborando',waiting:'Esperando',listening:'Escuchando'};
  return map[state||'idle']||state||'En espera';
}
function initials(name){return String(name||'').split(/\\s+/).filter(Boolean).slice(0,2).map(x=>x[0].toUpperCase()).join('')}
function metricRow(label,value){
  return '<div class="metric-line"><span>'+label+'</span><strong>'+value+'</strong></div>';
}
function eventRow(item){
  const type=item.action.type||'evento';
  const state=item.action.state||'';
  const task=item.action.task||'Sin detalle';
  return '<div class="event-line"><strong>'+escapeHtml(item.agentId||'agente')+' · '+escapeHtml(type)+(state?' · '+escapeHtml(state):'')+'</strong><span>'+escapeHtml(task)+'</span></div>';
}
function instructionRow(item){
  const respuestaHtml=item.respuesta?('<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#23d18b;font-size:12px">'+escapeHtml(item.respuesta)+'</div>'):'';
  const badges={realizado:['#23d18b','Realizado'],error:['#ff6b6b','Error'],respondido:['#B8A35A','Respondido']};
  const badge=badges[item.estado];
  const badgeHtml=badge?(' <span style="background:'+badge[0]+'22;color:'+badge[0]+';border-radius:999px;padding:2px 10px;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em">'+badge[1]+'</span>'):'';
  return '<div class="instruction-line"><strong>'+escapeHtml(item.author||'CEO')+' → '+escapeHtml(item.target||'all')+' · '+escapeHtml(item.scope||'global')+badgeHtml+'</strong><span>'+escapeHtml(item.message||'Sin mensaje')+'</span>'+respuestaHtml+'</div>';
}
function reporteRow(item){
  const enlaces='<a href="/reportes/'+encodeURIComponent(item.id)+'.html" target="_blank" style="color:#B8A35A;margin-right:10px">Ver HTML</a>'+(item.tienePdf?'<a href="/reportes/'+encodeURIComponent(item.id)+'.pdf" target="_blank" style="color:#B8A35A">Ver / descargar PDF</a>':'<span style="color:#666">Sin PDF</span>');
  return '<div class="instruction-line"><strong>'+escapeHtml(item.fecha||'')+'</strong><span>'+escapeHtml(item.resumen||'Sin resumen')+'</span><div style="margin-top:6px">'+enlaces+'</div></div>';
}
function auditoriaRow(item){
  const a=item.auditoria||{};
  const fecha=a.fecha?new Date(a.fecha).toLocaleString('es-ES'):'sin fecha';
  const cita=a.fechaCitaIso?new Date(a.fechaCitaIso).toLocaleString('es-ES',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}):null;
  const citaHtml=cita?'<div style="margin-top:4px;color:#D9B84A;font-weight:600">📅 Cita confirmada: '+escapeHtml(cita)+'</div>':'<div style="margin-top:4px;color:#999">Sin hora de cita confirmada todavia</div>';
  return '<div class="instruction-line"><strong>'+escapeHtml(a.nombre||item.nombreContacto||'Sin nombre')+' · solicitado '+escapeHtml(fecha)+'</strong><span>Tel: '+escapeHtml(a.telefono||item.identificador||'-')+' · Email: '+escapeHtml(a.email||'-')+' · Interes: '+escapeHtml(a.tipoServicio||'-')+'</span>'+citaHtml+'<div style="margin-top:6px"><a href="/inbox" style="color:#B8A35A">Ver conversación en el Inbox</a></div></div>';
}
function flyerRow(item){
  const fecha=item.createdAt?new Date(item.createdAt).toLocaleString('es-ES'):'sin fecha';
  const estadoTxt={pendiente:'Pendiente',publicado:'Publicado',descartado:'Descartado'}[item.estado]||item.estado;
  const acciones=item.estado==='pendiente'
    ?'<div style="margin-top:8px;display:flex;gap:8px"><button class="btn-gold" onclick="aprobarFlyer('+Number(item.id)+')" style="padding:8px 14px;font-size:12px">Aprobar y publicar</button><button class="btn-dark" onclick="descartarFlyer('+Number(item.id)+')" style="padding:8px 14px;font-size:12px">Descartar</button></div>'
    :'';
  return '<div class="instruction-line"><strong>'+escapeHtml(item.marca||'')+' · '+escapeHtml(item.formato||'post')+' · '+escapeHtml(fecha)+'</strong><span>'+escapeHtml(estadoTxt)+'</span><div style="margin-top:8px;display:flex;gap:12px;align-items:flex-start"><img src="'+escapeHtml(item.imagenUrl||'')+'" style="width:90px;border-radius:8px;border:1px solid rgba(255,255,255,.1)"><div style="flex:1;font-size:12.5px;color:#ccc;max-height:70px;overflow:hidden">'+escapeHtml(String(item.caption||'').slice(0,220))+'</div></div>'+acciones+'</div>';
}
function gmbPostRow(item){
  const fecha=item.createdAt?new Date(item.createdAt).toLocaleString('es-ES'):'sin fecha';
  const estadoTxt={pendiente:'Pendiente de publicar',publicado:'Publicado'}[item.estado]||item.estado;
  const textoCompleto=(item.titulo?item.titulo+'\\n\\n':'')+String(item.texto||'');
  const acciones=item.estado==='pendiente'
    ?'<div style="margin-top:8px;display:flex;gap:8px"><button class="btn-gold" data-gmb-copy style="padding:8px 14px;font-size:12px">Copiar texto</button><button class="btn-dark" onclick="marcarPublicadoGmb('+Number(item.id)+')" style="padding:8px 14px;font-size:12px">Marcar publicado</button></div>'
    :'';
  const ctaHtml=item.ctaBoton?(' · Boton: '+escapeHtml(item.ctaBoton)):'';
  const fotoHtml=item.ideaFoto?('<div style="margin-top:6px;font-size:11.5px;color:#999">📷 '+escapeHtml(item.ideaFoto)+'</div>'):'';
  return '<div class="instruction-line" data-gmb-texto="'+escapeHtml(textoCompleto)+'"><strong>'+escapeHtml(item.negocio||'')+ctaHtml+' · '+escapeHtml(fecha)+'</strong><span>'+escapeHtml(estadoTxt)+'</span><div style="margin-top:8px;font-size:12.5px;color:#ccc;white-space:pre-wrap">'+escapeHtml(textoCompleto)+'</div>'+fotoHtml+acciones+'</div>';
}
async function marcarPublicadoGmb(id){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token) return;
  try{
    await fetch('/api/gmb-posts/'+id+'/publicado',{method:'POST',headers:{'x-ceo-token':token}});
    await refreshGmbPosts();
  }catch{}
}
async function refreshGmbPosts(){
  const box=document.getElementById('gmb-posts-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  try{
    const response=await fetch('/api/gmb-posts',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.gmbPosts||[]);
    box.innerHTML=list.length?list.slice(0,12).map(gmbPostRow).join(''):'<div class="instruction-line"><span>Todavia no hay publicaciones de Google Business preparadas.</span></div>';
    box.querySelectorAll('[data-gmb-copy]').forEach(function(btn){
      btn.addEventListener('click',function(){
        const linea=btn.closest('[data-gmb-texto]');
        const texto=linea?linea.getAttribute('data-gmb-texto'):'';
        navigator.clipboard.writeText(texto||'').then(function(){
          btn.textContent='Copiado ✓';
          setTimeout(function(){ btn.textContent='Copiar texto'; },1500);
        });
      });
    });
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las publicaciones de Google Business.</span></div>';
  }
}
function clientePostRow(item){
  const fecha=item.createdAt?new Date(item.createdAt).toLocaleString('es-ES'):'sin fecha';
  const estadoTxt={pendiente:'Pendiente de publicar',publicado:'Publicado'}[item.estado]||item.estado;
  const hashtagsTxt=(item.hashtags||[]).map(function(h){return '#'+h;}).join(' ');
  const textoCompleto=String(item.texto||'')+(hashtagsTxt?('\\n\\n'+hashtagsTxt):'');
  const acciones=item.estado==='pendiente'
    ?'<div style="margin-top:8px;display:flex;gap:8px"><button class="btn-gold" data-cliente-post-copy style="padding:8px 14px;font-size:12px">Copiar texto</button><button class="btn-dark" onclick="marcarPublicadoClientePost('+Number(item.id)+')" style="padding:8px 14px;font-size:12px">Marcar publicado</button></div>'
    :'';
  const fotoHtml=item.ideaFoto?('<div style="margin-top:6px;font-size:11.5px;color:#999">📷 '+escapeHtml(item.ideaFoto)+'</div>'):'';
  return '<div class="instruction-line" data-cliente-post-texto="'+escapeHtml(textoCompleto)+'"><strong>'+escapeHtml(item.cliente||'')+' · '+escapeHtml(item.plataforma||'')+' · '+escapeHtml(fecha)+'</strong><span>'+escapeHtml(estadoTxt)+'</span><div style="margin-top:8px;font-size:12.5px;color:#ccc;white-space:pre-wrap">'+escapeHtml(String(item.texto||''))+'</div><div style="margin-top:6px;font-size:11.5px;color:#B8A35A">'+escapeHtml(hashtagsTxt)+'</div>'+fotoHtml+acciones+'</div>';
}
async function marcarPublicadoClientePost(id){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token) return;
  try{
    await fetch('/api/cliente-posts/'+id+'/publicado',{method:'POST',headers:{'x-ceo-token':token}});
    await refreshClientePosts();
  }catch{}
}
async function refreshClientePosts(){
  const box=document.getElementById('cliente-posts-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  try{
    const response=await fetch('/api/cliente-posts',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.clientePosts||[]);
    box.innerHTML=list.length?list.slice(0,12).map(clientePostRow).join(''):'<div class="instruction-line"><span>Todavia no hay publicaciones de clientes preparadas. Pidelo por chat: "publicación para [cliente]".</span></div>';
    box.querySelectorAll('[data-cliente-post-copy]').forEach(function(btn){
      btn.addEventListener('click',function(){
        const linea=btn.closest('[data-cliente-post-texto]');
        const texto=linea?linea.getAttribute('data-cliente-post-texto'):'';
        navigator.clipboard.writeText(texto||'').then(function(){
          btn.textContent='Copiado ✓';
          setTimeout(function(){ btn.textContent='Copiar texto'; },1500);
        });
      });
    });
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las publicaciones de clientes.</span></div>';
  }
}
function socialExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+escapeHtml(step.label||step.key||'Paso')+'</span><b class="'+escapeHtml(step.status||'pendiente')+'">'+escapeHtml(String(step.status||'pendiente').replaceAll('_',' '))+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+escapeHtml(worker.status||'pendiente')+'">'+escapeHtml(worker.name||worker.agent||'worker')+' · '+escapeHtml(String(worker.status||'pendiente').replaceAll('_',' '))+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+escapeHtml(item.id||'0')+' · '+escapeHtml(item.title||'Sin título')+'</div><div class="social-exec-meta">Por '+escapeHtml(item.author||'CEO')+' · Actualizado: '+escapeHtml(updated)+'</div></div><span class="social-badge '+escapeHtml(badgeClass)+'">'+escapeHtml(badgeClass.replaceAll('_',' '))+'</span></div><div class="social-exec-meta">'+escapeHtml(item.brief||'Sin brief')+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
function workExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+escapeHtml(step.label||step.key||'Paso')+'</span><b class="'+escapeHtml(step.status||'pendiente')+'">'+escapeHtml(String(step.status||'pendiente').replaceAll('_',' '))+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+escapeHtml(worker.status||'pendiente')+'">'+escapeHtml(worker.name||worker.agent||'worker')+' · '+escapeHtml(String(worker.status||'pendiente').replaceAll('_',' '))+'</span>').join('');
  const resources=(item.resources||[]).map(resource=>'<span class="resource-chip">'+escapeHtml(resource)+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+escapeHtml(item.id||'0')+' · '+escapeHtml(item.title||'Sin título')+'</div><div class="social-exec-meta">Grupo: '+escapeHtml(item.department||'general')+' · Por '+escapeHtml(item.author||'CEO')+' · Actualizado: '+escapeHtml(updated)+'</div></div><span class="social-badge '+escapeHtml(badgeClass)+'">'+escapeHtml(badgeClass.replaceAll('_',' '))+'</span></div><div class="social-exec-meta">'+escapeHtml(item.brief||'Sin brief')+'</div><div class="resource-list">'+resources+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
function euro(value){
  const num=Number(value||0);
  return new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(num);
}
function percent(part,total){
  if(!total || total<=0) return 0;
  return Math.max(0,Math.min(100,Math.round((part/total)*100)));
}
function pctSteps(steps){
  const list=steps||[];
  if(!list.length) return 0;
  const hechos=list.filter(s=>String(s.status)==='hecho').length;
  return percent(hechos,list.length);
}
function stepsBadge(steps){
  const pct=pctSteps(steps);
  return '<div class="steps-progress"><div class="steps-progress-bar"><span style="width:'+pct+'%"></span></div><b>'+pct+'% completado</b></div>';
}
function timeAgo(ms){
  if(!ms) return 'sin datos';
  const diff=Math.max(0,Date.now()-Number(ms));
  const min=Math.floor(diff/60000);
  if(min<1) return 'hace segundos';
  if(min<60) return 'hace '+min+'m';
  const h=Math.floor(min/60);
  if(h<24) return 'hace '+h+'h';
  const d=Math.floor(h/24);
  return 'hace '+d+'d';
}
function statusText(value){
  if(value==='error') return '<span class="status-error">Error</span>';
  if(value==='warn') return '<span class="status-warn">Aviso</span>';
  return '<span class="status-ok">OK</span>';
}
function renderBusinessMetrics(metrics){
  const top=document.getElementById('biz-top');
  const bars=document.getElementById('biz-bars');
  const note=document.getElementById('biz-note');
  if(!top||!bars||!note) return;
  const ventas=Number(metrics.ventas||0);
  const captaciones=Number(metrics.captaciones||0);
  const gastos=Number(metrics.gastos||0);
  const ganancias=Number(metrics.ganancias||0);
  const suscriptores=Number(metrics.suscriptores||0);
  const workflows=Number(metrics.n8n_workflows||0);
  const ejecuciones=Number(metrics.n8n_ejecuciones_hoy||0);
  const publicaciones=Number(metrics.n8n_publicaciones_hoy||0);
  top.innerHTML=[
    '<div class="kpi"><b>'+ventas+'</b><span>Ventas</span><small>captaciones: '+captaciones+'</small></div>',
    '<div class="kpi"><b>'+euro(ganancias)+'</b><span>Ganancias</span><small>gastos: '+euro(gastos)+'</small></div>',
    '<div class="kpi"><b>'+suscriptores+'</b><span>Suscriptores</span><small>n8n: '+statusText(metrics.n8n_status||'ok')+'</small></div>'
  ].join('');
  const totalDinero=Math.max(gastos+ganancias,1);
  const totalEmbudo=Math.max(captaciones,ventas,1);
  const totalN8n=Math.max(workflows,ejecuciones,publicaciones,1);
  bars.innerHTML=[
    '<div class="bar"><div class="bar-head"><strong>Conversión captación → venta</strong><span>'+ventas+' / '+captaciones+'</span></div><div class="bar-track"><div class="bar-fill" style="width:'+percent(ventas,totalEmbudo)+'%"></div></div></div>',
    '<div class="bar"><div class="bar-head"><strong>Ganancias frente a gastos</strong><span>'+euro(ganancias)+' / '+euro(gastos)+'</span></div><div class="bar-track"><div class="bar-fill" style="width:'+percent(ganancias,totalDinero)+'%"></div></div></div>',
    '<div class="bar"><div class="bar-head"><strong>Ritmo n8n</strong><span>WF '+workflows+' · Exec '+ejecuciones+' · Posts '+publicaciones+'</span></div><div class="bar-track"><div class="bar-fill" style="width:'+percent(publicaciones,totalN8n)+'%"></div></div></div>'
  ].join('');
  const updated=metrics?.updatedAt?new Date(metrics.updatedAt).toLocaleString('es-ES'):'sin sincronizacion';
  note.textContent=metrics.notes ? ('Notas: '+metrics.notes+' · Actualizado: '+updated) : ('Sin notas de negocio por ahora. Última actualización: '+updated);
  const setValue=(id,val)=>{ const el=document.getElementById(id); if(el) el.value = val ?? ''; };
  setValue('m-ventas',ventas);
  setValue('m-captaciones',captaciones);
  setValue('m-gastos',gastos);
  setValue('m-ganancias',ganancias);
  setValue('m-suscriptores',suscriptores);
  setValue('m-n8n-status',metrics.n8n_status||'ok');
  setValue('m-n8n-workflows',workflows);
  setValue('m-n8n-exec',ejecuciones);
  setValue('m-n8n-posts',publicaciones);
  setValue('m-notes',metrics.notes||'');
}
function renderMetrics(agents,data){
  const metrics=(data&&data.metrics)?data.metrics:null;
  const box=document.getElementById('metrics-list');
  const eventsBox=document.getElementById('events-list');
  if(!box||!eventsBox) return;
  if(!metrics){
    box.innerHTML=metricRow('Agentes',agents.length);
    eventsBox.innerHTML='<div class="event-line"><span>Sin metricas disponibles.</span></div>';
    return;
  }
  box.innerHTML=[
    metricRow('Agentes totales',metrics.total||0),
    metricRow('Activos',metrics.online||0),
    metricRow('Trabajando',metrics.working||0),
    metricRow('Pensando',metrics.detail.thinking||0),
    metricRow('Google Business',metrics.detail.gmb||0),
    metricRow('Redes sociales',metrics.detail.social||0),
    metricRow('Paid Media',metrics.detail.ads||0),
    metricRow('Vigilancia 24/7',metrics.detail.watchers||0),
    metricRow('Dirección',metrics.byDepartment.direccion||0),
    metricRow('Comerciales',metrics.byDepartment.comerciales||0),
    metricRow('SEO',metrics.byDepartment.seo||0),
    metricRow('Web + IA',((metrics.byDepartment.web||0)+(metrics.byDepartment.automatizacion||0)))
  ].join('');
  const recent=(metrics.recentEvents||[]);
  eventsBox.innerHTML=recent.length?recent.map(eventRow).join(''):'<div class="event-line"><span>Sin actividad reciente.</span></div>';
  renderBusinessMetrics(data.businessMetrics||{});
}
let OFFICE_AGENTS_CACHE=[];
let OFFICE_ACTIVE_FILTER='all';
function zoneCountLabel(items){
  const working=items.filter(agent=>agent.state==='working').length;
  return items.length+' trabajadores  '+working+' activos';
}
function buildOfficeFilters(grouped){
  const box=document.getElementById('office-filter');
  if(!box) return;
  const entries=[{key:'all',title:'Todos',count:OFFICE_AGENTS_CACHE.length}].concat(
    ZONES.map(zone=>({key:zone.key,title:zone.title,count:(grouped[zone.key]||[]).length}))
  );
  box.innerHTML=entries.map(entry=>'<button class="office-chip '+(OFFICE_ACTIVE_FILTER===entry.key?'active':'')+'" data-office-filter="'+entry.key+'">'+entry.title+' · '+entry.count+'</button>').join('');
  box.querySelectorAll('[data-office-filter]').forEach(btn=>{
    btn.onclick=()=>{
      OFFICE_ACTIVE_FILTER=btn.getAttribute('data-office-filter')||'all';
      renderOffice(OFFICE_AGENTS_CACHE);
    };
  });
}
function renderOffice(agents){
  OFFICE_AGENTS_CACHE=agents.slice();
  const office=document.getElementById('office');
  const grouped={};
  for(const zone of ZONES) grouped[zone.key]=[];
  for(const agent of agents){const dep=inferDepartment(agent);if(!grouped[dep]) grouped[dep]=[];grouped[dep].push(agent);}
  const statOnline=document.getElementById('stat-online');
  const statTotal=document.getElementById('stat-total');
  const statWorking=document.getElementById('stat-working');
  if(statOnline) statOnline.textContent=String(agents.filter(a=>a.state!=='offline').length);
  if(statTotal) statTotal.textContent=String(agents.length);
  if(statWorking) statWorking.textContent=String(agents.filter(a=>a.state==='working').length);
  buildOfficeFilters(grouped);
  // La pagina /ceo no tiene la cuadricula de agentes (seccion "office"
  // recortada para dejar la oficina limpia) -- sin este guard, escribir en
  // un elemento null aqui interrumpia el resto de refreshOffice() y por eso
  // el panel de metricas y el selector de trabajadores del CEO se quedaban
  // vacios en /ceo.
  if(!office) return;
  const visibleZones=(OFFICE_ACTIVE_FILTER==='all')?ZONES:ZONES.filter(zone=>zone.key===OFFICE_ACTIVE_FILTER);
  office.innerHTML=visibleZones.map(zone=>{
    const items=grouped[zone.key]||[];
    const isOpen=(OFFICE_ACTIVE_FILTER==='all') ? items.some(agent=>agent.state==='working') : true;
    return '<section class="panel zone"><details class="zone-details" '+(isOpen?'open':'')+'><summary class="zone-summary"><div class="zone-summary-main"><span class="pill">'+zone.tag+'</span><div><h4>'+zone.title+'</h4><div class="zone-count">'+zoneCountLabel(items)+'</div></div></div><span class="zone-count">'+(isOpen?'Ocultar':'Ver')+'</span></summary><div class="zone-body"><div class="desks">'+
      (items.length?items.map(agent=>{
        const agentName=agent.name||agent.agent||'Agente';
        const task=agent.task?String(agent.task):'Sin tarea visible en este momento.';
        const state=agent.state||'idle';
        return '<article class="desk" data-agent-card="'+escapeHtml(agent.agent||'')+'"><div class="desk-top"><div class="avatar">'+escapeHtml(initials(agentName))+'</div><div><div class="desk-name">'+escapeHtml(agentName)+'</div><div class="desk-role">'+escapeHtml(inferDepartment(agent))+'</div></div></div><div class="desk-status"><span class="dot '+escapeHtml(state)+'"></span>'+escapeHtml(stateLabel(state))+' · '+escapeHtml(timeAgo(agent.lastSeen))+'</div><div class="task">'+escapeHtml(task)+'</div></article>';
      }).join(''):'<div class="desk-empty">Zona preparada para nuevos agentes</div>')+'</div></div></details></section>';
  }).join('');
}
function renderTargetPicker(agents){
  const scopeEl=document.getElementById('scope');
  const groupSelect=document.getElementById('target-group');
  const grid=document.getElementById('target-grid');
  const target=document.getElementById('target');
  const helper=document.getElementById('target-helper');
  // La pagina /office no tiene la Consola del CEO (movida a /ceo para dejar
  // la oficina limpia) -- sin este guard antes de leer scopeEl.value, esto
  // lanzaba una excepcion que interrumpia refreshOffice() a mitad de camino
  // y el catch volvia a pintar la cuadricula de agentes vacia por encima de
  // la que ya se habia cargado bien.
  if(!scopeEl||!groupSelect||!grid||!target||!helper) return;
  const scope=scopeEl.value||'global';
  const grouped={};
  for(const zone of ZONES) grouped[zone.key]=[];
  for(const agent of agents){const dep=inferDepartment(agent);if(!grouped[dep]) grouped[dep]=[];grouped[dep].push(agent);}
  const fallbackGroup=(scope==='team' && target.value)?target.value:(groupSelect.value||'all');
  const options=['<option value="all">Toda la oficina</option>'].concat(ZONES.map(zone=>'<option value="'+zone.key+'" '+(zone.key===fallbackGroup?'selected':'')+'>'+zone.title+' · '+((grouped[zone.key]||[]).length)+'</option>'));
  groupSelect.innerHTML=options.join('');
  const selectedGroup=groupSelect.value||'all';
  const workers=selectedGroup==='all' ? agents.slice() : (grouped[selectedGroup]||[]);
  if(scope==='global'){
    target.value='all';
    helper.textContent='Modo global: la orden saldra a toda la oficina.';
    grid.innerHTML='<div class="desk-empty">La instruccion global no necesita elegir trabajador.</div>';
    return;
  }
  if(scope==='team'){
    target.value=selectedGroup;
    helper.textContent='Modo equipo: la orden se envia al grupo '+selectedGroup+'.';
    grid.innerHTML=workers.length ? workers.slice(0,12).map(agent=>{
      const agentName=agent.name||agent.agent||'Agente';
      return '<button class="target-card active" data-team-card="'+escapeHtml(selectedGroup)+'"><div class="target-card-head"><div class="avatar">'+escapeHtml(initials(agentName))+'</div><div><div class="target-card-name">'+escapeHtml(agentName)+'</div><div class="target-card-sub">'+escapeHtml(inferDepartment(agent))+'</div></div></div><div class="target-card-task">'+escapeHtml(String(agent.task||'Sin tarea visible').slice(0,120))+'</div></button>';
    }).join('') : '<div class="desk-empty">Sin trabajadores visibles en este equipo.</div>';
    return;
  }
  if(!target.value || !workers.some(agent=>String(agent.agent)===String(target.value))){
    target.value=workers[0]?.agent || '';
  }
  helper.textContent=target.value ? ('Trabajador elegido: '+target.value) : 'Elige un trabajador para enviar una orden directa.';
  grid.innerHTML=workers.length ? workers.map(agent=>{
    const agentName=agent.name||agent.agent||'Agente';
    const active=String(target.value)===String(agent.agent);
    return '<button class="target-card '+(active?'active':'')+'" data-worker-card="'+escapeHtml(agent.agent)+'"><div class="target-card-head"><div class="avatar">'+escapeHtml(initials(agentName))+'</div><div><div class="target-card-name">'+escapeHtml(agentName)+'</div><div class="target-card-sub">'+escapeHtml(agent.agent)+'</div></div></div><div class="target-card-task">'+escapeHtml(String(agent.task||'Sin tarea visible').slice(0,120))+'</div></button>';
  }).join('') : '<div class="desk-empty">No hay trabajadores activos en este grupo todavia.</div>';
  grid.querySelectorAll('[data-worker-card]').forEach(btn=>btn.onclick=()=>{target.value=btn.getAttribute('data-worker-card')||'';helper.textContent='Trabajador elegido: '+target.value;renderTargetPicker(agents);});
}
function renderReplyCard(execution,kind){
  const workers=execution.assigned||[];
  const lead=workers[0];
  const leadName=lead?(lead.name||lead.agent):(execution.department||'Equipo');
  const stepsHtml=(execution.steps||[]).map(step=>'<div class="reply-step"><span>'+escapeHtml(step.label||step.key||'Paso')+'</span><b class="'+escapeHtml(step.status||'pendiente')+'">'+escapeHtml(String(step.status||'pendiente').replaceAll('_',' '))+'</b></div>').join('');
  const otros=workers.slice(1).map(w=>w.name||w.agent).join(', ');
  return '<div class="reply-card"><div class="reply-card-head"><div class="reply-card-avatar">'+escapeHtml(initials(leadName))+'</div><div><div class="reply-card-name">'+escapeHtml(leadName)+' ha recibido la orden</div><div class="reply-card-sub">'+escapeHtml(execution.department?('Equipo: '+execution.department+(otros?' · con apoyo de '+otros:''))+' · '+kind:kind)+'</div></div></div>'+stepsBadge(execution.steps)+'<div class="reply-steps">'+stepsHtml+'</div></div>';
}
function renderCommandReply(data){
  const box=document.getElementById('command-reply');
  if(!box) return;
  const listaAuto=data.automatizacionReal||[];
  const todasOk=listaAuto.length>0&&listaAuto.every(function(r){return r.ok;});
  const algunaFallo=listaAuto.some(function(r){return !r.ok;});
  const ackBorder=algunaFallo?'#c0392b':'#2ecc71';
  const ackIcon=listaAuto.length?(todasOk?'✅':'⚠️'):'💬';
  const ackHtml=data.respuestaInmediata
    ? ('<div class="reply-card" style="border-color:'+ackBorder+'"><div class="reply-card-sub"><strong>'+ackIcon+'</strong> '+escapeHtml(data.respuestaInmediata)+'</div></div>')
    : '';
  // socialExecution/workExecutions ya no se fabrican (2026-09-08, ver
  // pushInstruction en el servidor) -- respuestaInmediata (mostrada en
  // ackHtml arriba) es la unica confirmacion real, no hace falta ninguna
  // tarjeta extra de "ejecucion" simulada.
  box.innerHTML=ackHtml||'<div class="reply-card"><div class="reply-card-sub">Instrucción guardada.</div></div>';
}
async function sendInstruction(){
  const scope=document.getElementById('scope').value||'global';
  const target=document.getElementById('target').value.trim()||'all';
  const author=document.getElementById('author').value.trim()||'CEO';
  const message=document.getElementById('message').value.trim()||'';
  const status=document.getElementById('command-status');
  const replyBox=document.getElementById('command-reply');
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!message){
    if(status) status.textContent='Escribe primero una instrucción.';
    return;
  }
  if(!token){
    if(status) status.textContent='Guarda primero el token privado del CEO.';
    return;
  }
  if(replyBox) replyBox.innerHTML='';
  try{
    const response=await fetch('/api/instructions',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ceo-token':token},
      body:JSON.stringify({scope,target,author,message})
    });
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Error enviando instrucción');
    if(status) status.textContent='Instrucción enviada correctamente.';
    renderCommandReply(data);
    document.getElementById('message').value='';
    await refreshOffice();
    await refreshInstructions();
  }catch(error){
    if(status) status.textContent='No se pudo enviar la instrucción.';
  }
}
async function refreshInstructions(){
  const box=document.getElementById('instruction-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){
    box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver y enviar instrucciones.</span></div>';
    return;
  }
  try{
    const response=await fetch('/api/instructions',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const semanaMs=7*24*60*60*1000;
    const list=(data.instructions||[]).filter(function(it){ return (Date.now()-Number(it.timestamp||0))<=semanaMs; });
    box.innerHTML=list.length?list.map(instructionRow).join(''):'<div class="instruction-line"><span>Sin instrucciones esta semana.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>Token no válido o sin acceso.</span></div>';
  }
}
let ceoChatHistorial = [];
function pintarCeoChat() {
  const log = document.getElementById('ceo-chat-log');
  if (!log) return;
  log.innerHTML = ceoChatHistorial.map(function(t) {
    const quien = t.role === 'ai' ? 'IA' : 'Tu';
    const clase = t.role === 'ai' ? 'color:var(--gold,#C9A227)' : 'color:#fff';
    return '<div class="event-line"><strong style="' + clase + '">' + quien + '</strong><span>' + String(t.content).replace(/</g,'&lt;') + '</span></div>';
  }).join('');
  log.scrollTop = log.scrollHeight;
}
async function enviarCeoChat() {
  const input = document.getElementById('ceo-chat-input');
  const status = document.getElementById('ceo-chat-status');
  const token = (localStorage.getItem('ceo-panel-token') || '').trim();
  const mensaje = (input.value || '').trim();
  if (!mensaje) return;
  if (!token) { status.textContent = 'Falta el token del CEO (guardalo arriba primero).'; return; }
  ceoChatHistorial.push({ role: 'user', content: mensaje });
  pintarCeoChat();
  input.value = '';
  status.textContent = 'Pensando...';
  try {
    const response = await fetch('/api/ceo-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ceo-token': token },
      body: JSON.stringify({ message: mensaje, historial: ceoChatHistorial.slice(0, -1) }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Error desconocido');
    ceoChatHistorial.push({ role: 'ai', content: data.respuesta });
    pintarCeoChat();
    status.textContent = 'Listo para hablar.';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}
function bindCeoChatPanel() {
  const btn = document.getElementById('ceo-chat-send');
  const input = document.getElementById('ceo-chat-input');
  if (btn) btn.addEventListener('click', enviarCeoChat);
  if (input) input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarCeoChat(); }
  });
  bindCeoMediaClip();
}
function leerArchivoComoBase64(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() { resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = function() { reject(new Error('no se pudo leer el archivo')); };
    reader.readAsDataURL(file);
  });
}
async function subirMediaCeo(file) {
  const status = document.getElementById('ceo-media-status');
  const token = (localStorage.getItem('ceo-panel-token') || '').trim();
  if (!token) { status.textContent = 'Falta el token del CEO (guardalo arriba primero).'; return; }
  if (!file) return;
  const maxBytes = 60 * 1024 * 1024;
  if (file.size > maxBytes) { status.textContent = 'Archivo demasiado grande (maximo 60MB).'; return; }
  status.textContent = 'Subiendo ' + file.name + '...';
  try {
    const b64 = await leerArchivoComoBase64(file);
    const response = await fetch('/api/media-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ceo-token': token },
      body: JSON.stringify({ media_b64: b64, mime_type: file.type || 'application/octet-stream', nombre: file.name }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Error desconocido subiendo el archivo');
    status.textContent = 'Listo: "' + file.name + '" subido -- ahora escribe algo como "publica esto" en el chat y envialo.';
  } catch (err) {
    status.textContent = 'Error subiendo el archivo: ' + err.message;
  }
}
async function subirMediaComandoPanel(file) {
  const status = document.getElementById('command-media-status');
  const token = (localStorage.getItem('ceo-panel-token') || '').trim();
  if (!token) { status.textContent = 'Falta el token del CEO (guardalo arriba primero).'; return; }
  if (!file) return;
  const maxBytes = 60 * 1024 * 1024;
  if (file.size > maxBytes) { status.textContent = 'Archivo demasiado grande (maximo 60MB).'; return; }
  status.textContent = 'Subiendo ' + file.name + '...';
  try {
    const b64 = await leerArchivoComoBase64(file);
    const response = await fetch('/api/media-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ceo-token': token },
      body: JSON.stringify({ media_b64: b64, mime_type: file.type || 'application/octet-stream', nombre: file.name }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Error desconocido subiendo el archivo');
    status.textContent = 'Listo: "' + file.name + '" subido.';
    const messageBox = document.getElementById('message');
    if (messageBox && !messageBox.value.trim()) messageBox.value = 'Publica esto en redes sociales.';
    if (messageBox) messageBox.focus();
  } catch (err) {
    status.textContent = 'Error subiendo el archivo: ' + err.message;
  }
}
function bindCommandMediaClip() {
  const clipBtn = document.getElementById('command-media-clip');
  const fileInput = document.getElementById('command-media-input');
  if (!clipBtn || !fileInput) return;
  clipBtn.addEventListener('click', function() { fileInput.click(); });
  fileInput.addEventListener('change', function() {
    const file = fileInput.files && fileInput.files[0];
    if (file) subirMediaComandoPanel(file);
    fileInput.value = '';
  });
}
function bindCeoMediaClip() {
  const clipBtn = document.getElementById('ceo-media-clip');
  const fileInput = document.getElementById('ceo-media-input');
  if (!clipBtn || !fileInput) return;
  clipBtn.addEventListener('click', function() { fileInput.click(); });
  fileInput.addEventListener('change', function() {
    const file = fileInput.files && fileInput.files[0];
    if (file) subirMediaCeo(file);
    fileInput.value = '';
  });
}
async function refreshSocialExecutions(){
  const box=document.getElementById('social-exec-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){
    box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver la ejecución operativa.</span></div>';
    return;
  }
  try{
    const response=await fetch('/api/social-executions',{cache:'no-store',headers:{'x-ceo-token':token,'Accept':'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data=await response.json();
    if(!data||!Array.isArray(data.socialExecutions)) throw new Error('Respuesta sin socialExecutions[]');
    const list=data.socialExecutions;
    box.innerHTML=list.length?list.slice(0,6).map(socialExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones reales de redes todavia.</span></div>';
    box.dataset.loaded='1';
  }catch(error){
    // No pisar datos ya cargados por un fallo puntual -- mismo criterio que refreshOffice().
    console.error('[operations:social]',{message:String(error&&error.message||error),at:new Date().toISOString()});
    if(box.dataset.loaded!=='1') box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones de redes.</span></div>';
  }
}
async function refreshReportes(){
  const box=document.getElementById('reportes-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  try{
    const response=await fetch('/api/reportes',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.reportes||[]);
    box.innerHTML=list.length?list.slice(0,10).map(reporteRow).join(''):'<div class="instruction-line"><span>Todavia no se ha generado ningun informe.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar los informes.</span></div>';
  }
}
async function refreshAuditorias(){
  const box=document.getElementById('auditorias-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  try{
    const response=await fetch('/api/inbox',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.conversaciones||[]).filter(c=>Array.isArray(c.etiquetas)&&c.etiquetas.includes('auditoria-solicitada'));
    box.innerHTML=list.length?list.slice(0,10).map(auditoriaRow).join(''):'<div class="instruction-line"><span>Todavia no han pedido ninguna auditoria por WhatsApp.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las auditorias.</span></div>';
  }
}
async function refreshFlyers(){
  const box=document.getElementById('flyers-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  try{
    const response=await fetch('/api/flyers',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.flyers||[]);
    box.innerHTML=list.length?list.slice(0,10).map(flyerRow).join(''):'<div class="instruction-line"><span>Todavia no hay flyers generados.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar los flyers.</span></div>';
  }
}
async function aprobarFlyer(id){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){ alert('Guarda primero el token privado del CEO.'); return; }
  try{
    const response=await fetch('/api/flyers/'+id+'/aprobar',{method:'POST',headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo aprobar');
    refreshFlyers();
  }catch(e){ alert('Error: '+(e.message||e)); }
}
async function descartarFlyer(id){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){ alert('Guarda primero el token privado del CEO.'); return; }
  try{
    const response=await fetch('/api/flyers/'+id+'/descartar',{method:'POST',headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo descartar');
    refreshFlyers();
  }catch(e){ alert('Error: '+(e.message||e)); }
}
async function updateSocialExecution(action, stepKey=''){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  const status=document.getElementById('social-exec-status');
  if(!token){
    if(status) status.textContent='Guarda primero el token privado del CEO.';
    return;
  }
  try{
    const current=await fetch('/api/social-executions',{headers:{'x-ceo-token':token}}).then(r=>r.json());
    const execution=(current.socialExecutions||[])[0];
    if(!execution){
      if(status) status.textContent='Todavía no hay una ejecución social creada.';
      return;
    }
    const response=await fetch('/api/social-executions/'+execution.id,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ceo-token':token},
      body:JSON.stringify({action,stepKey})
    });
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo actualizar la ejecución');
    if(status) status.textContent='Ejecución social actualizada.';
    await refreshOffice();
    await refreshSocialExecutions();
  }catch{
    if(status) status.textContent='No se pudo actualizar la ejecución social.';
  }
}
async function refreshWorkExecutions(){
  const box=document.getElementById('work-exec-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){
    box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver las ejecuciones generales.</span></div>';
    return;
  }
  try{
    const response=await fetch('/api/work-executions',{cache:'no-store',headers:{'x-ceo-token':token,'Accept':'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data=await response.json();
    if(!data||!Array.isArray(data.workExecutions)) throw new Error('Respuesta sin workExecutions[]');
    const list=data.workExecutions;
    box.innerHTML=list.length?list.slice(0,8).map(workExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones generales todavia.</span></div>';
    box.dataset.loaded='1';
  }catch(error){
    console.error('[operations:work]',{message:String(error&&error.message||error),at:new Date().toISOString()});
    if(box.dataset.loaded!=='1') box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones generales.</span></div>';
  }
}
async function seedGlobalWorkExecutions(){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  const status=document.getElementById('work-exec-status');
  if(!token){
    if(status) status.textContent='Guarda primero el token privado del CEO.';
    return;
  }
  try{
    const payload={
      scope:'global',
      target:'all',
      author:'CEO',
      message:'Generad trabajo operativo real por grupo: redes con publicaciones y hooks; ventas con seguimiento y auditorías; SEO con oportunidades accionables; web con mejoras de conversión; IA con automatizaciones; operaciones con control y reporting.'
    };
    const response=await fetch('/api/instructions',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ceo-token':token},
      body:JSON.stringify(payload)
    });
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo sembrar trabajo global');
    if(status) status.textContent='Trabajo global sembrado en todos los grupos.';
    await refreshOffice();
    await refreshInstructions();
    await refreshSocialExecutions();
    await refreshWorkExecutions();
  }catch{
    if(status) status.textContent='No se pudo sembrar trabajo global.';
  }
}
function bindCommandPanel(){
  const send=document.getElementById('send-command');
  const fillGlobal=document.getElementById('fill-global');
  const fillSocial=document.getElementById('fill-social');
  const fillTecnico=document.getElementById('fill-tecnico');
  const saveToken=document.getElementById('save-token');
  const tokenInput=document.getElementById('ceo-token');
  const quickCommunity=document.getElementById('quick-community');
  const quickSales=document.getElementById('quick-sales');
  const quickSeo=document.getElementById('quick-seo');
  const quickGmb=document.getElementById('quick-gmb');
  const quickWeb=document.getElementById('quick-web');
  const quickAudit=document.getElementById('quick-audit');
  const socialStartFirst=document.getElementById('social-start-first');
  const socialStepHook=document.getElementById('social-step-hook');
  const socialStepCopy=document.getElementById('social-step-copy');
  const socialStepCreative=document.getElementById('social-step-creative');
  const socialStepReview=document.getElementById('social-step-review');
  const workRefresh=document.getElementById('work-refresh');
  const workSeedGlobal=document.getElementById('work-seed-global');
  const scope=document.getElementById('scope');
  const groupSelect=document.getElementById('target-group');
  if(send) send.onclick=sendInstruction;
  if(scope) scope.onchange=()=>renderTargetPicker(OFFICE_AGENTS_CACHE);
  if(groupSelect) groupSelect.onchange=()=>{
    document.getElementById('target').value=groupSelect.value;
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(tokenInput) tokenInput.value=localStorage.getItem('ceo-panel-token')||'';
  if(saveToken) saveToken.onclick=()=>{
    const token=(tokenInput.value||'').trim();
    localStorage.setItem('ceo-panel-token',token);
    const status=document.getElementById('command-status');
    if(status) status.textContent=token?'Token guardado.':'Token borrado.';
    refreshInstructions();
  };
  if(fillGlobal) fillGlobal.onclick=()=>{
    document.getElementById('scope').value='global';
    document.getElementById('target').value='all';
    document.getElementById('message').value='Prioridad global del día: revisad oportunidades rápidas de ventas, bloqueos y mejoras de conversión antes de proponer nuevas tareas.';
  };
  if(fillSocial) fillSocial.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='community';
    document.getElementById('message').value='Equipo de redes: preparad una pieza prioritaria por marca con enfoque comercial, hook fuerte y CTA claro, evitando duplicidades.';
    document.getElementById('target-group').value='community';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(fillTecnico) fillTecnico.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='tecnico';
    document.getElementById('message').value='';
    document.getElementById('target-group').value='tecnico';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
    document.getElementById('message').focus();
  };
  bindCommandMediaClip();
  if(quickCommunity) quickCommunity.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='community';
    document.getElementById('message').value='Equipo de community: priorizad una publicacion fuerte hoy, con hook claro, beneficio visible y CTA a auditoria o contacto.';
    document.getElementById('target-group').value='community';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(quickSales) quickSales.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='comerciales';
    document.getElementById('message').value='Equipo comercial: revisad oportunidades calientes, seguid leads pendientes y moved hoy una accion clara de avance por cada oportunidad.';
    document.getElementById('target-group').value='comerciales';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(quickSeo) quickSeo.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='seo';
    document.getElementById('message').value='Equipo SEO: detectad hoy una mejora de alto impacto por marca en SEO, GEO o AEO y dejad una recomendacion priorizada.';
    document.getElementById('target-group').value='seo';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(quickGmb) quickGmb.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='operaciones';
    document.getElementById('message').value='Equipo Google Business: revisad publicaciones, categorias, preguntas y servicios de las fichas prioritarias y marcad el siguiente movimiento recomendado.';
    document.getElementById('target-group').value='operaciones';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(quickWeb) quickWeb.onclick=()=>{
    document.getElementById('scope').value='team';
    document.getElementById('target').value='web';
    document.getElementById('message').value='Equipo web: priorizad mejoras claras de conversion, CTA y estructura en las paginas clave, sin tocar nada accesorio.';
    document.getElementById('target-group').value='web';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(quickAudit) quickAudit.onclick=()=>{
    document.getElementById('scope').value='worker';
    document.getElementById('target').value='audit_intake_manager';
    document.getElementById('message').value='Revisa auditorias pendientes, confirma estados y coordina calendario, hoja y avisos para que no se pierda ninguna oportunidad.';
    renderTargetPicker(OFFICE_AGENTS_CACHE);
  };
  if(socialStartFirst) socialStartFirst.onclick=()=>updateSocialExecution('start');
  if(socialStepHook) socialStepHook.onclick=()=>updateSocialExecution('complete_step','hook');
  if(socialStepCopy) socialStepCopy.onclick=()=>updateSocialExecution('complete_step','copy');
  if(socialStepCreative) socialStepCreative.onclick=()=>updateSocialExecution('complete_step','creative');
  if(socialStepReview) socialStepReview.onclick=()=>updateSocialExecution('complete_step','review');
  if(workRefresh) workRefresh.onclick=refreshWorkExecutions;
  if(workSeedGlobal) workSeedGlobal.onclick=seedGlobalWorkExecutions;
  const saveMetrics=document.getElementById('save-metrics');
  const syncMetricsAuto=document.getElementById('sync-metrics-auto');
  if(saveMetrics) saveMetrics.onclick=saveBusinessMetrics;
  if(syncMetricsAuto) syncMetricsAuto.onclick=async()=>{
    const status=document.getElementById('metrics-status');
    if(status) status.textContent='Sincronizando metricas automticas de la oficina...';
    await refreshOffice();
    if(status) status.textContent='Métricas sincronizadas con actividad real de la oficina.';
  };
}
async function saveBusinessMetrics(){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  const status=document.getElementById('metrics-status');
  if(!token){
    if(status) status.textContent='Guarda primero el token privado del CEO.';
    return;
  }
  const payload={
    ventas: document.getElementById('m-ventas').value,
    captaciones: document.getElementById('m-captaciones').value,
    gastos: document.getElementById('m-gastos').value,
    ganancias: document.getElementById('m-ganancias').value,
    suscriptores: document.getElementById('m-suscriptores').value,
    n8n_status: document.getElementById('m-n8n-status').value,
    n8n_workflows: document.getElementById('m-n8n-workflows').value,
    n8n_ejecuciones_hoy: document.getElementById('m-n8n-exec').value,
    n8n_publicaciones_hoy: document.getElementById('m-n8n-posts').value,
    notes: document.getElementById('m-notes').value || ''
  };
  try{
    const response=await fetch('/api/business-metrics',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ceo-token':token},
      body:JSON.stringify(payload)
    });
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo guardar');
    if(status) status.textContent='Métricas actualizadas correctamente.';
    renderBusinessMetrics(data.businessMetrics||payload);
    await refreshOffice();
  }catch{
    if(status) status.textContent='No se pudieron actualizar las métricas.';
  }
}
let officeRefreshRunning=false;
let officeRefreshTimer=null;
async function refreshOffice(){
  if(officeRefreshRunning) return;
  officeRefreshRunning=true;
  const startedAt=Date.now();
  try{
    const officeToken=(localStorage.getItem('ceo-panel-token')||'').trim();
    const response=await fetch('/api/metrics',{cache:'no-store',headers:{'Accept':'application/json','x-ceo-token':officeToken}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const contentType=response.headers.get('content-type')||'';
    if(!contentType.includes('application/json')) throw new Error('Content-Type inesperado: '+contentType);
    const data=await response.json();
    if(!data||!Array.isArray(data.agents)) throw new Error('Respuesta sin agents[]');
    const agents=data.agents;
    renderOffice(agents);
    renderTargetPicker(agents);
    renderMetrics(agents,data);
  }catch(error){
    // Mantener el ultimo estado valido: un fallo de red o una extension no
    // debe convertir 149 agentes reales en cero en la pantalla.
    console.error('[office:refresh]',{
      message:String(error&&error.message||error),
      durationMs:Date.now()-startedAt,
      at:new Date().toISOString(),
      page:location.pathname
    });
  }finally{
    officeRefreshRunning=false;
  }
}
function scheduleOfficeRefresh(){
  clearTimeout(officeRefreshTimer);
  officeRefreshTimer=setTimeout(async()=>{
    await refreshOffice();
    scheduleOfficeRefresh();
  },5000);
}
refreshOffice();
bindCommandPanel();
bindCeoChatPanel();
refreshInstructions();
refreshSocialExecutions();
refreshWorkExecutions();
refreshReportes();
refreshAuditorias();
refreshFlyers();
refreshGmbPosts();
refreshClientePosts();
scheduleOfficeRefresh();
setInterval(refreshReportes,30000);
setInterval(refreshAuditorias,20000);
setInterval(refreshFlyers,20000);
setInterval(refreshGmbPosts,20000);
setInterval(refreshClientePosts,20000);
setInterval(refreshInstructions,10000);
setInterval(refreshSocialExecutions,10000);
setInterval(refreshWorkExecutions,10000);
(function initVmsTabs(){
  var bar = document.getElementById('vms-tabs-bar');
  var panels = Array.prototype.slice.call(document.querySelectorAll('.vms-tab-panel'));
  if (!bar || !panels.length) return;
  panels.forEach(function(panel, i){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vms-tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = panel.getAttribute('data-tab-label') || ('Sección ' + (i + 1));
    btn.addEventListener('click', function(){
      panels.forEach(function(p){ p.classList.remove('active'); });
      Array.prototype.forEach.call(bar.children, function(b){ b.classList.remove('active'); });
      panel.classList.add('active');
      btn.classList.add('active');
    });
    bar.appendChild(btn);
    if (i === 0) panel.classList.add('active');
  });
})();
</script>
</body>
</html>`;
}

function renderOperationsHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Operaciones · Oficina Virtual</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:linear-gradient(180deg,#0b0b0f 0%,#13131a 100%);color:#f3f3f5}
.shell{max-width:1320px;margin:0 auto;padding:24px}
.hero,.grid{display:grid;gap:18px}
.hero{grid-template-columns:1.1fr .9fr}
.grid{grid-template-columns:1fr 1fr}
.panel{background:rgba(20,20,27,.92);border:1px solid rgba(212,175,55,.20);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.28);padding:20px}
.eyebrow{color:#d4af37;font-size:12px;text-transform:uppercase;letter-spacing:.18em;margin-bottom:12px}
h1,h2,h3{margin:0 0 12px}
h1{font-size:42px;line-height:1}
p,span{color:#b8b8c3;line-height:1.6}
.button-row{display:flex;gap:10px;flex-wrap:wrap}
.btn-gold,.btn-dark{padding:12px 16px;border-radius:999px;font-weight:800;text-decoration:none;cursor:pointer}
.btn-gold{border:none;background:#d4af37;color:#121216}
.btn-dark{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#f4f4f7}
.instruction-line,.social-exec{padding:14px;border-radius:18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.instruction-line{margin-bottom:12px}
.social-exec-list,.work-exec-list{display:grid;gap:10px}
.social-exec-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.social-exec-title{font-size:14px;font-weight:800}
.social-exec-meta{font-size:12px;color:#a9a9b4}
.social-badge{display:inline-flex;align-items:center;justify-content:center;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}
.social-badge.pendiente{background:rgba(240,185,79,.12);color:#f0b94f}
.social-badge.en_proceso{background:rgba(87,199,255,.12);color:#57c7ff}
.social-badge.hecho{background:rgba(35,209,139,.12);color:#23d18b}
.social-steps{display:grid;gap:8px}
.steps-progress{display:flex;align-items:center;gap:10px;margin:8px 0}
.steps-progress-bar{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.steps-progress-bar span{display:block;height:100%;background:linear-gradient(90deg,#d4af37,#f0d97a);border-radius:999px;transition:width .3s ease}
.steps-progress b{font-size:11px;color:#d4af37;white-space:nowrap}
.social-step{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);font-size:12px}
.social-step b.pendiente{color:#f0b94f}.social-step b.en_proceso{color:#57c7ff}.social-step b.hecho{color:#23d18b}
.social-assigned,.resource-list{display:flex;flex-wrap:wrap;gap:8px}
.social-worker,.resource-chip{padding:7px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.06);font-size:11px}
.social-worker{background:rgba(255,255,255,.03);color:#d9dae2}
.social-worker.working{border-color:rgba(87,199,255,.4);color:#57c7ff}
.social-worker.hecho{border-color:rgba(35,209,139,.4);color:#23d18b}
.resource-chip{background:rgba(212,175,55,.08);border-color:rgba(212,175,55,.18);color:#f0d679}
.command-status{margin-top:12px;font-size:13px;color:#b8c7b0}
.reply-card{margin-top:12px;padding:14px 16px;border-radius:16px;background:rgba(35,209,139,.06);border:1px solid rgba(35,209,139,.25);animation:replyIn .25s ease}
.reply-card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.reply-card-avatar{width:34px;height:34px;border-radius:12px;background:rgba(35,209,139,.15);color:#23d18b;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:0 0 auto}
.reply-card-name{font-weight:800;color:#f3f3f5;font-size:13.5px}
.reply-card-sub{font-size:11.5px;color:#8a9a92}
.reply-steps{display:grid;gap:6px;margin-top:4px}
.reply-step{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:6px 10px;border-radius:10px;background:rgba(255,255,255,.03)}
.reply-step b{font-weight:700}
.reply-step b.pendiente{color:#f0b94f}.reply-step b.en_proceso{color:#57c7ff}.reply-step b.hecho{color:#23d18b}
@keyframes replyIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.token-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.token-row input{flex:1 1 240px;min-width:0;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:14px;padding:12px 14px}
@media (max-width:980px){.hero,.grid{grid-template-columns:1fr}}
${SIDEBAR_CSS}
</style>
</head>
<body>
${renderSidebarHtml('operations')}
<div class="shell">
  <section class="hero">
    <div class="panel">
      <div class="eyebrow">Operations HQ</div>
      <h1>Operaciones y motor real</h1>
      <p>Aquí vive el taller: ejecuciones sociales, motor general, pasos, responsables y acciones rápidas. La oficina principal se queda limpia y ejecutiva.</p>
      <div class="button-row" style="margin-top:14px">
        <a class="btn-gold" href="/office">Volver a oficina</a>
        <a class="btn-gold" href="/ceo">Consola del CEO</a>
        <a class="btn-gold" href="/manual">Manual operativo</a>
        <a class="btn-dark" href="/logout">Cerrar sesión</a>
      </div>
    </div>
    <div class="panel">
      <h3>Token del CEO</h3>
      <div class="token-row">
        <input id="ceo-token" placeholder="Token privado del CEO">
        <button class="btn-dark" id="save-token">Guardar token</button>
      </div>
      <div class="instruction-line"><span>Esta pantalla está pensada para controlar el motor operativo sin ensuciar la oficina principal.</span></div>
    </div>
  </section>
  <section class="grid">
    <div class="panel">
      <h3>Ejecución real · Redes</h3>
      <div class="instruction-line"><span>Las órdenes de redes aparecen aquí con pasos y responsables.</span></div>
      <div class="social-exec-list" id="social-exec-list"></div>
    </div>
    <div class="panel">
      <h3>Acciones rápidas · Redes</h3>
      <div class="button-row">
        <button class="btn-dark" id="social-start-first">Iniciar primera ejecución</button>
        <button class="btn-dark" id="social-step-hook">Completar hook</button>
        <button class="btn-dark" id="social-step-copy">Completar copy</button>
        <button class="btn-dark" id="social-step-creative">Completar creatividad</button>
        <button class="btn-gold" id="social-step-review">Marcar revisión hecha</button>
      </div>
      <div class="command-status" id="social-exec-status">Esperando una orden real para redes.</div>
    </div>
  </section>
  <section class="grid">
    <div class="panel">
      <h3>Motor general · Todos los grupos</h3>
      <div class="instruction-line"><span>Cada orden genera una ejecución por departamento con pasos, responsables y avance real.</span></div>
      <div class="work-exec-list" id="work-exec-list"></div>
    </div>
    <div class="panel">
      <h3>Acciones rápidas · Motor general</h3>
      <div class="button-row">
        <button class="btn-dark" id="work-refresh">Recargar ejecuciones</button>
        <button class="btn-gold" id="work-seed-global">Sembrar trabajo global</button>
      </div>
      <div class="command-status" id="work-exec-status">Motor general preparado para generar trabajo por grupos.</div>
    </div>
  </section>
</div>
<script>
function escapeHtml(value){
  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function percent(part,total){
  if(!total || total<=0) return 0;
  return Math.max(0,Math.min(100,Math.round((part/total)*100)));
}
function pctSteps(steps){
  const list=steps||[];
  if(!list.length) return 0;
  const hechos=list.filter(s=>String(s.status)==='hecho').length;
  return percent(hechos,list.length);
}
function stepsBadge(steps){
  const pct=pctSteps(steps);
  return '<div class="steps-progress"><div class="steps-progress-bar"><span style="width:'+pct+'%"></span></div><b>'+pct+'% completado</b></div>';
}
function timeAgo(ms){
  if(!ms) return 'sin datos';
  const diff=Math.max(0,Date.now()-Number(ms));
  const min=Math.floor(diff/60000);
  if(min<1) return 'hace segundos';
  if(min<60) return 'hace '+min+'m';
  const h=Math.floor(min/60);
  if(h<24) return 'hace '+h+'h';
  const d=Math.floor(h/24);
  return 'hace '+d+'d';
}
function socialExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+escapeHtml(step.label||step.key||'Paso')+'</span><b class="'+escapeHtml(step.status||'pendiente')+'">'+escapeHtml(String(step.status||'pendiente').replaceAll('_',' '))+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+escapeHtml(worker.status||'pendiente')+'">'+escapeHtml(worker.name||worker.agent||'worker')+' · '+escapeHtml(String(worker.status||'pendiente').replaceAll('_',' '))+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+escapeHtml(item.id||'0')+' · '+escapeHtml(item.title||'Sin título')+'</div><div class="social-exec-meta">Por '+escapeHtml(item.author||'CEO')+' · Actualizado: '+escapeHtml(updated)+'</div></div><span class="social-badge '+escapeHtml(badgeClass)+'">'+escapeHtml(badgeClass.replaceAll('_',' '))+'</span></div><div class="social-exec-meta">'+escapeHtml(item.brief||'Sin brief')+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
function workExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+escapeHtml(step.label||step.key||'Paso')+'</span><b class="'+escapeHtml(step.status||'pendiente')+'">'+escapeHtml(String(step.status||'pendiente').replaceAll('_',' '))+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+escapeHtml(worker.status||'pendiente')+'">'+escapeHtml(worker.name||worker.agent||'worker')+' · '+escapeHtml(String(worker.status||'pendiente').replaceAll('_',' '))+'</span>').join('');
  const resources=(item.resources||[]).map(resource=>'<span class="resource-chip">'+escapeHtml(resource)+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+escapeHtml(item.id||'0')+' · '+escapeHtml(item.title||'Sin título')+'</div><div class="social-exec-meta">Grupo: '+escapeHtml(item.department||'general')+' · Por '+escapeHtml(item.author||'CEO')+' · Actualizado: '+escapeHtml(updated)+'</div></div><span class="social-badge '+escapeHtml(badgeClass)+'">'+escapeHtml(badgeClass.replaceAll('_',' '))+'</span></div><div class="social-exec-meta">'+escapeHtml(item.brief||'Sin brief')+'</div><div class="resource-list">'+resources+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
async function refreshSocialExecutions(){
  const box=document.getElementById('social-exec-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){ box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver la ejecución operativa.</span></div>'; return; }
  try{
    const response=await fetch('/api/social-executions',{cache:'no-store',headers:{'x-ceo-token':token,'Accept':'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data=await response.json();
    if(!data||!Array.isArray(data.socialExecutions)) throw new Error('Respuesta sin socialExecutions[]');
    const list=data.socialExecutions;
    box.innerHTML=list.length?list.slice(0,12).map(socialExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones reales de redes todavia.</span></div>';
    box.dataset.loaded='1';
  }catch(error){
    console.error('[ceo:social]',{message:String(error&&error.message||error),at:new Date().toISOString()});
    if(box.dataset.loaded!=='1') box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones de redes.</span></div>';
  }
}
async function refreshWorkExecutions(){
  const box=document.getElementById('work-exec-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){ box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver las ejecuciones generales.</span></div>'; return; }
  try{
    const response=await fetch('/api/work-executions',{cache:'no-store',headers:{'x-ceo-token':token,'Accept':'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data=await response.json();
    if(!data||!Array.isArray(data.workExecutions)) throw new Error('Respuesta sin workExecutions[]');
    const list=data.workExecutions;
    box.innerHTML=list.length?list.slice(0,16).map(workExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones generales todavia.</span></div>';
    box.dataset.loaded='1';
  }catch(error){
    console.error('[ceo:work]',{message:String(error&&error.message||error),at:new Date().toISOString()});
    if(box.dataset.loaded!=='1') box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones generales.</span></div>';
  }
}
async function updateSocialExecution(action, stepKey=''){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  const status=document.getElementById('social-exec-status');
  if(!token){ if(status) status.textContent='Guarda primero el token privado del CEO.'; return; }
  try{
    const current=await fetch('/api/social-executions',{headers:{'x-ceo-token':token}}).then(r=>r.json());
    const execution=(current.socialExecutions||[])[0];
    if(!execution){ if(status) status.textContent='Todavía no hay una ejecución social creada.'; return; }
    const response=await fetch('/api/social-executions/'+execution.id,{method:'POST',headers:{'Content-Type':'application/json','x-ceo-token':token},body:JSON.stringify({action,stepKey})});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo actualizar la ejecución');
    if(status) status.textContent='Ejecución social actualizada.';
    await refreshSocialExecutions();
  }catch{
    if(status) status.textContent='No se pudo actualizar la ejecución social.';
  }
}
async function seedGlobalWorkExecutions(){
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  const status=document.getElementById('work-exec-status');
  if(!token){ if(status) status.textContent='Guarda primero el token privado del CEO.'; return; }
  try{
    const response=await fetch('/api/instructions',{method:'POST',headers:{'Content-Type':'application/json','x-ceo-token':token},body:JSON.stringify({scope:'global',target:'all',author:'CEO',message:'Generad trabajo operativo real por grupo: redes con publicaciones y hooks; ventas con seguimiento y auditorías; SEO con oportunidades accionables; web con mejoras de conversión; IA con automatizaciones; operaciones con control y reporting.'})});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No se pudo sembrar trabajo global');
    if(status) status.textContent='Trabajo global sembrado correctamente.';
    await refreshWorkExecutions();
    await refreshSocialExecutions();
  }catch{
    if(status) status.textContent='No se pudo sembrar trabajo global.';
  }
}
document.getElementById('save-token').addEventListener('click',()=>{
  const value=(document.getElementById('ceo-token').value||'').trim();
  if(value) localStorage.setItem('ceo-panel-token', value);
  refreshSocialExecutions();
  refreshWorkExecutions();
});
document.getElementById('ceo-token').value=localStorage.getItem('ceo-panel-token')||'';
document.getElementById('social-start-first').addEventListener('click',()=>updateSocialExecution('start'));
document.getElementById('social-step-hook').addEventListener('click',()=>updateSocialExecution('complete_step','hook'));
document.getElementById('social-step-copy').addEventListener('click',()=>updateSocialExecution('complete_step','copy'));
document.getElementById('social-step-creative').addEventListener('click',()=>updateSocialExecution('complete_step','creative'));
document.getElementById('social-step-review').addEventListener('click',()=>updateSocialExecution('complete_step','review'));
document.getElementById('work-refresh').addEventListener('click',refreshWorkExecutions);
document.getElementById('work-seed-global').addEventListener('click',seedGlobalWorkExecutions);
refreshSocialExecutions();
refreshWorkExecutions();
setInterval(refreshSocialExecutions,10000);
setInterval(refreshWorkExecutions,10000);
</script>
</body>
</html>`;
}

const DEPT_TITLES = {
  direccion: 'Dirección',
  operaciones: 'Operaciones y control',
  community: 'Community y redes',
  copy: 'Copy transversal',
  comerciales: 'Comerciales',
  auditorias: 'Auditorías',
  seo: 'SEO / GEO / AEO',
  gmb: 'Google Business',
  web: 'Web y conversión',
  automatizacion: 'IA y automatización',
  ads: 'Ads y analítica',
  research: 'Investigación y competencia',
  tecnico: 'Soporte técnico',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInboxHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Inbox unificado · Oficina Virtual</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:#0b0b0f;color:#f3f3f5;height:100vh;overflow:hidden}
.topbar{display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid rgba(212,175,55,.18);background:rgba(20,20,27,.96)}
.topbar h1{font-size:16px;margin:0;font-weight:800;flex:0 0 auto}
.topbar .nav{display:flex;gap:8px;flex-wrap:wrap}
.topbar .nav a{font-size:12px;padding:7px 12px;border-radius:999px;text-decoration:none;color:#d9dae2;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03)}
.topbar .nav a.gold{background:#d4af37;color:#121216;border-color:transparent;font-weight:800}
.topbar .token-wrap{margin-left:auto;display:flex;gap:8px;align-items:center}
.topbar input{border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:10px;padding:8px 10px;font-size:12px;width:190px}
.topbar button{border:none;border-radius:10px;padding:8px 12px;font-size:12px;font-weight:800;background:rgba(255,255,255,.06);color:#f4f4f7;cursor:pointer}
.status-line{font-size:11.5px;color:#8a8a95;padding:4px 20px 0}
.app{display:grid;grid-template-columns:340px 1fr;height:calc(100vh - 78px)}
.sidebar{border-right:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;min-height:0}
.filter-row{display:flex;gap:6px;flex-wrap:wrap;padding:12px 14px}
.filter-chip{padding:6px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#d9dae2;font-size:11.5px;cursor:pointer}
.filter-chip.active{background:rgba(212,175,55,.16);border-color:rgba(212,175,55,.4);color:#f0d679}
.conv-list{flex:1;overflow-y:auto;padding:0 8px 12px}
.conv-row{display:flex;gap:10px;align-items:flex-start;padding:11px 10px;border-radius:14px;cursor:pointer;margin-bottom:2px}
.conv-row:hover{background:rgba(255,255,255,.03)}
.conv-row.active{background:rgba(212,175,55,.12)}
.avatar{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#121216;flex-shrink:0}
.avatar.email{background:#57c7ff}
.avatar.whatsapp{background:#23d18b}
.avatar.instagram{background:#e055b7}
.avatar.web{background:#f0b94f}
.avatar.voz{background:#b28fff}
.conv-row-main{flex:1;min-width:0}
.conv-row-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.conv-row-name{font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv-row-time{font-size:10.5px;color:#8a8a95;flex-shrink:0}
.conv-row-preview{font-size:12px;color:#9b9ba6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.conv-row-tags{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap}
.mini-tag{font-size:9.5px;padding:2px 7px;border-radius:999px;background:rgba(212,175,55,.1);border:1px solid rgba(212,175,55,.25);color:#f0d679}
.conv-row-ai-dot{width:8px;height:8px;border-radius:50%;background:#23d18b;flex-shrink:0;margin-top:5px}
.empty-hint{color:#8a8a95;font-size:13px;padding:24px;text-align:center}
.thread{display:flex;flex-direction:column;min-height:0;background:radial-gradient(circle at 50% 0%,#141419 0%,#0b0b0f 60%)}
.thread-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#6f6f7a;font-size:14px;flex-direction:column;gap:10px}
.thread-view{display:none;flex-direction:column;height:100%;min-height:0}
.thread-header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
.thread-back{display:none;background:none;border:none;color:#f0d679;font-size:20px;cursor:pointer;padding:0 4px}
.thread-header-name{font-weight:800;font-size:15px}
.thread-header-meta{font-size:11.5px;color:#8a8a95}
.thread-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:10px}
.msg-row{display:flex}
.msg-row.out{justify-content:flex-end}
.msg-row.in{justify-content:flex-start}
.msg-bubble{max-width:62%;padding:9px 13px;border-radius:16px;font-size:13.5px;line-height:1.45;position:relative}
.msg-row.out .msg-bubble{background:linear-gradient(135deg,#d4af37,#b8952e);color:#121216;border-bottom-right-radius:4px}
.msg-row.in .msg-bubble{background:rgba(255,255,255,.06);color:#f0f0f3;border:1px solid rgba(255,255,255,.06);border-bottom-left-radius:4px}
.msg-time{font-size:9.5px;opacity:.65;margin-top:4px;display:block;text-align:right}
.thread-ai-suggestion{margin:0 20px 12px;padding:14px;border-radius:14px;background:rgba(35,209,139,.06);border:1px solid rgba(35,209,139,.25);flex-shrink:0}
.thread-ai-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#23d18b;font-weight:800;margin-bottom:6px}
.thread-ai-suggestion textarea{width:100%;min-height:60px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;padding:10px;font-family:inherit;font-size:13px}
.thread-ai-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.btn-gold,.btn-dark{padding:9px 14px;border-radius:999px;font-weight:800;text-decoration:none;cursor:pointer;border:none;font-size:12px}
.btn-gold{background:#d4af37;color:#121216}
.btn-dark{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#f4f4f7}
.thread-composer{display:flex;gap:8px;padding:14px 20px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0}
.thread-composer input{flex:1;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:999px;padding:11px 16px;font-size:13.5px}
.thread-tags{padding:0 20px 16px;flex-shrink:0}
.thread-tags-list{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.thread-tag{padding:4px 10px;border-radius:999px;background:rgba(212,175,55,.1);border:1px solid rgba(212,175,55,.25);color:#f0d679;font-size:11px}
.thread-add-tag{display:flex;gap:6px}
.thread-add-tag input{flex:1;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:10px;padding:8px 10px;font-size:12px}
@media (max-width:820px){
  .app{grid-template-columns:1fr}
  .sidebar{display:flex}
  .sidebar.hidden-mobile{display:none}
  .thread{display:none}
  .thread.active-mobile{display:flex}
  .thread-back{display:inline-block}
}
${SIDEBAR_CSS}
</style>
</head>
<body>
${renderSidebarHtml('inbox')}
<div class="topbar">
  <h1>Inbox unificado</h1>
  <div class="nav">
    <a href="/office">Oficina</a>
    <a href="/ceo">CEO</a>
    <a href="/operations">Operaciones</a>
  </div>
  <div class="token-wrap">
    <input id="ceo-token" placeholder="Token del CEO">
    <button id="save-token">Guardar</button>
    <a class="btn-dark" href="/logout" style="text-decoration:none;padding:8px 12px;border-radius:10px;font-size:12px">Salir</a>
  </div>
</div>
<div class="status-line" id="global-status">Guarda el token para aprobar/editar/descartar respuestas.</div>
<div class="app">
  <aside class="sidebar" id="sidebar">
    <div class="filter-row" id="filter-row">
      <div class="filter-chip active" data-canal="todos">Todos</div>
      <div class="filter-chip" data-canal="email">Email</div>
      <div class="filter-chip" data-canal="whatsapp">WhatsApp</div>
      <div class="filter-chip" data-canal="instagram">Instagram</div>
      <div class="filter-chip" data-canal="web">Web</div>
      <div class="filter-chip" data-canal="voz">Llamadas</div>
    </div>
    <div class="conv-list" id="conv-list"><div class="empty-hint">Cargando...</div></div>
  </aside>
  <main class="thread" id="thread">
    <div class="thread-empty" id="thread-empty">
      <div>💬</div>
      <div>Selecciona una conversación para verla</div>
    </div>
    <div class="thread-view" id="thread-view">
      <div class="thread-header">
        <button class="thread-back" id="thread-back">←</button>
        <div>
          <div class="thread-header-name" id="thread-header-name">-</div>
          <div class="thread-header-meta" id="thread-header-meta">-</div>
        </div>
      </div>
      <div class="thread-messages" id="thread-messages"></div>
      <div class="thread-ai-suggestion" id="thread-ai-suggestion" style="display:none">
        <div class="thread-ai-label">Sugerencia de la IA</div>
        <textarea id="ai-textarea"></textarea>
        <div class="thread-ai-actions">
          <button class="btn-gold" id="ai-aprobar">Aprobar y enviar</button>
          <button class="btn-dark" id="ai-editar">Enviar editado</button>
          <button class="btn-dark" id="ai-descartar">Descartar</button>
        </div>
      </div>
      <div class="thread-composer">
        <input id="composer-input" placeholder="Escribe una respuesta y pulsa Enter...">
        <button class="btn-gold" id="composer-send">Enviar</button>
      </div>
      <div class="thread-tags">
        <div class="thread-tags-list" id="thread-tags-list"></div>
        <div class="thread-add-tag">
          <input id="thread-tag-input" placeholder="Añadir etiqueta CRM...">
          <button class="btn-dark" id="thread-tag-add">+</button>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
function escapeHtml(value){
  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
const CANAL_LABEL={email:'Email',whatsapp:'WhatsApp',instagram:'Instagram',web:'Web',voz:'Llamada'};
let filtroActual='todos';
let ultimaLista=[];
let conversacionActivaId=null;
function getToken(){return (localStorage.getItem('ceo-panel-token')||'').trim();}
document.getElementById('save-token').addEventListener('click',function(){
  const val=document.getElementById('ceo-token').value.trim();
  if(val){localStorage.setItem('ceo-panel-token',val);document.getElementById('global-status').textContent='Token guardado.';refreshInbox();}
});
document.getElementById('ceo-token').value=getToken();
function timeAgo(ts){
  const diff=Math.max(0,Date.now()-ts);
  const min=Math.floor(diff/60000);
  if(min<1) return 'ahora';
  if(min<60) return min+'min';
  const h=Math.floor(min/60);
  if(h<24) return h+'h';
  return Math.floor(h/24)+'d';
}
function iniciales(nombre){
  const s=String(nombre||'?').trim();
  return s ? s[0].toUpperCase() : '?';
}
function convRow(c){
  const idNum=Number(c.id);
  const canal=c.canal||'web';
  const label=CANAL_LABEL[canal]||canal;
  const ultimo=c.ultimoMensaje?c.ultimoMensaje.texto:'(sin mensajes)';
  const tags=(c.etiquetas||[]).slice(0,3).map(function(t){return '<span class="mini-tag">'+escapeHtml(t)+'</span>';}).join('');
  const activeClass=idNum===conversacionActivaId?' active':'';
  const aiDot=c.sugerenciaIA?'<div class="conv-row-ai-dot" title="Sugerencia de IA pendiente"></div>':'';
  return '<div class="conv-row'+activeClass+'" data-id="'+idNum+'">'+
    '<div class="avatar '+escapeHtml(canal)+'">'+escapeHtml(iniciales(c.nombreContacto||c.identificador))+'</div>'+
    '<div class="conv-row-main">'+
    '<div class="conv-row-top"><span class="conv-row-name">'+escapeHtml(c.nombreContacto||c.identificador)+'</span><span class="conv-row-time">'+escapeHtml(timeAgo(c.updatedAt))+'</span></div>'+
    '<div class="conv-row-preview">'+escapeHtml(label)+' · '+escapeHtml(ultimo)+'</div>'+
    '<div class="conv-row-tags">'+tags+'</div>'+
    '</div>'+aiDot+
    '</div>';
}
function renderLista(){
  const box=document.getElementById('conv-list');
  const filtradas=filtroActual==='todos'?ultimaLista:ultimaLista.filter(function(c){return c.canal===filtroActual;});
  box.innerHTML=filtradas.length?filtradas.map(convRow).join(''):'<div class="empty-hint">Sin conversaciones todavia en este canal.</div>';
}
let inboxLoadedOk=false;
async function refreshInbox(){
  try{
    const response=await fetch('/api/inbox',{cache:'no-store',headers:{'Accept':'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data=await response.json();
    if(!data||!Array.isArray(data.conversaciones)) throw new Error('Respuesta sin conversaciones[]');
    ultimaLista=data.conversaciones;
    renderLista();
    inboxLoadedOk=true;
    if(conversacionActivaId!==null) cargarConversacion(conversacionActivaId,true);
  }catch(error){
    console.error('[inbox:refresh]',{message:String(error&&error.message||error),at:new Date().toISOString()});
    if(!inboxLoadedOk) document.getElementById('conv-list').innerHTML='<div class="empty-hint">No se pudo cargar el inbox.</div>';
  }
}
function renderMensajes(mensajes){
  const box=document.getElementById('thread-messages');
  const wasAtBottom=box.scrollTop+box.clientHeight>=box.scrollHeight-40;
  box.innerHTML=(mensajes||[]).map(function(m){
    const out=m.autor==='sistema';
    const hora=new Date(m.timestamp).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
    return '<div class="msg-row '+(out?'out':'in')+'"><div class="msg-bubble">'+escapeHtml(m.texto)+'<span class="msg-time">'+hora+'</span></div></div>';
  }).join('') || '<div class="empty-hint">Sin mensajes todavia.</div>';
  if(wasAtBottom) box.scrollTop=box.scrollHeight;
}
async function cargarConversacion(id,silencioso){
  try{
    const response=await fetch('/api/inbox/'+id,{cache:'no-store',headers:{'Accept':'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data=await response.json();
    const conv=data.conversacion;
    if(!conv) return;
    conversacionActivaId=id;
    document.getElementById('thread-empty').style.display='none';
    document.getElementById('thread-view').style.display='flex';
    document.getElementById('thread-header-name').textContent=conv.nombreContacto||conv.identificador;
    document.getElementById('thread-header-meta').textContent=(CANAL_LABEL[conv.canal]||conv.canal)+' · '+conv.identificador;
    renderMensajes(conv.mensajes);
    const sug=document.getElementById('thread-ai-suggestion');
    if(conv.sugerenciaIA){
      sug.style.display='block';
      document.getElementById('ai-textarea').value=conv.sugerenciaIA;
    } else {
      sug.style.display='none';
    }
    const tagsBox=document.getElementById('thread-tags-list');
    tagsBox.innerHTML=(conv.etiquetas||[]).map(function(t){return '<span class="thread-tag">'+escapeHtml(t)+'</span>';}).join('')||'<span style="color:#6f6f7a;font-size:11px">Sin etiquetas</span>';
    if(!silencioso){
      document.getElementById('sidebar').classList.add('hidden-mobile');
      document.getElementById('thread').classList.add('active-mobile');
    }
    renderLista();
  }catch(error){
    console.error('[inbox:conversacion]',{message:String(error&&error.message||error),at:new Date().toISOString()});
  }
}
document.getElementById('conv-list').addEventListener('click',function(e){
  const row=e.target.closest('.conv-row');
  if(!row) return;
  cargarConversacion(Number(row.getAttribute('data-id')));
});
document.getElementById('thread-back').addEventListener('click',function(){
  document.getElementById('sidebar').classList.remove('hidden-mobile');
  document.getElementById('thread').classList.remove('active-mobile');
});
async function enviarTexto(texto,accion){
  const token=getToken();
  if(!token){document.getElementById('global-status').textContent='Guarda el token del CEO primero.';return;}
  if(!conversacionActivaId) return;
  document.getElementById('global-status').textContent='Enviando...';
  try{
    const response=await fetch('/api/inbox/'+conversacionActivaId+'/respuesta',{method:'POST',headers:{'Content-Type':'application/json','x-ceo-token':token},body:JSON.stringify({accion:accion||'editar',texto:texto})});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Error al enviar');
    document.getElementById('global-status').textContent=accion==='descartar'?'Sugerencia descartada.':'Respuesta enviada.';
    refreshInbox();
    cargarConversacion(conversacionActivaId,true);
  }catch(e){
    document.getElementById('global-status').textContent='Error: '+e.message;
  }
}
document.getElementById('ai-aprobar').addEventListener('click',function(){enviarTexto(document.getElementById('ai-textarea').value,'aprobar');});
document.getElementById('ai-editar').addEventListener('click',function(){enviarTexto(document.getElementById('ai-textarea').value,'editar');});
document.getElementById('ai-descartar').addEventListener('click',function(){enviarTexto('','descartar');});
document.getElementById('composer-send').addEventListener('click',function(){
  const input=document.getElementById('composer-input');
  const texto=input.value.trim();
  if(!texto) return;
  input.value='';
  enviarTexto(texto,'editar');
});
document.getElementById('composer-input').addEventListener('keydown',function(e){
  if(e.key==='Enter'){document.getElementById('composer-send').click();}
});
document.getElementById('thread-tag-add').addEventListener('click',async function(){
  const token=getToken();
  if(!token){document.getElementById('global-status').textContent='Guarda el token del CEO primero.';return;}
  if(!conversacionActivaId) return;
  const input=document.getElementById('thread-tag-input');
  const etiqueta=(input.value||'').trim();
  if(!etiqueta) return;
  await fetch('/api/inbox/'+conversacionActivaId+'/etiquetas',{method:'POST',headers:{'Content-Type':'application/json','x-ceo-token':token},body:JSON.stringify({etiqueta:etiqueta})});
  input.value='';
  refreshInbox();
  cargarConversacion(conversacionActivaId,true);
});
document.getElementById('filter-row').addEventListener('click',function(e){
  const chip=e.target.closest('.filter-chip');
  if(!chip) return;
  document.querySelectorAll('.filter-chip').forEach(function(el){el.classList.remove('active');});
  chip.classList.add('active');
  filtroActual=chip.getAttribute('data-canal');
  renderLista();
});
refreshInbox();
setInterval(refreshInbox,15000);
</script>
</body>
</html>`;
}

function renderCalendarioSemanalHtml() {
  const diasLabel = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Calendario Semanal · Oficina Virtual</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:linear-gradient(180deg,#0b0b0f 0%,#13131a 100%);color:#f3f3f5}
.shell{max-width:1500px;margin:0 auto;padding:24px}
.panel{background:rgba(20,20,27,.92);border:1px solid rgba(212,175,55,.20);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.28);padding:20px;margin-bottom:18px}
.eyebrow{color:#d4af37;font-size:12px;text-transform:uppercase;letter-spacing:.18em;margin-bottom:12px}
h1,h2,h3{margin:0 0 12px}
h1{font-size:32px;line-height:1.1}
p,span{color:#b8b8c3;line-height:1.6}
.button-row{display:flex;gap:10px;flex-wrap:wrap}
.btn-gold{padding:12px 16px;border-radius:999px;font-weight:800;text-decoration:none;cursor:pointer;border:none;background:#d4af37;color:#121216;font-size:13px}
.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.tab-btn{padding:10px 18px;border-radius:999px;border:1px solid rgba(212,175,55,.3);background:rgba(255,255,255,.03);color:#f3f3f5;cursor:pointer;font-weight:700;font-size:13px}
.tab-btn.active{background:#d4af37;color:#121216}
.semana-grid-wrap{overflow-x:auto;padding-bottom:6px}
.semana-grid{display:grid;grid-template-columns:repeat(7,minmax(200px,1fr));gap:12px}
@media(max-width:600px){.semana-grid{grid-template-columns:repeat(7,minmax(180px,1fr))}}
.dia-col{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:200px;max-height:70vh;overflow-y:auto}
.dia-col .card .tipo{display:inline-block;background:rgba(255,255,255,.08);color:#d0d0d8;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px;text-transform:uppercase}

.empresa-tabla-wrap{overflow-x:auto;padding-bottom:6px}
.empresa-tabla{display:flex;flex-direction:column;gap:22px;min-width:1100px}
.empresa-bloque{display:flex;flex-direction:column;gap:8px}
.empresa-titulo{font-weight:800;color:#d4af37;font-size:15px;padding-bottom:6px;border-bottom:1px solid rgba(212,175,55,.25)}
.empresa-cabecera{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:8px}
.empresa-cabecera .dia-titulo{background:rgba(255,255,255,.04);border-radius:10px;padding:6px 8px;text-align:center;font-size:11px}
.empresa-fila{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:8px;align-items:start}
.dia-celda{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:6px;min-height:56px;overflow-x:hidden;display:flex;flex-direction:column;gap:4px}
.dia-celda .card{padding:6px 8px}
.dia-celda-vacia{opacity:.25;font-size:11px;text-align:center;padding-top:14px}
.dia-titulo{font-weight:800;color:#d4af37;font-size:14px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid rgba(212,175,55,.2);padding-bottom:6px;margin-bottom:2px}
.card{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 10px;font-size:12.5px}
.card .hora{display:inline-block;background:rgba(212,175,55,.15);color:#d4af37;border-radius:6px;padding:1px 6px;font-size:10.5px;font-weight:800;margin-bottom:4px}
.card .empresa{font-weight:700;color:#f3f3f5;margin-bottom:2px}
.card .tareas{color:#b8b8c3;white-space:pre-wrap}
.card .borrar{float:right;color:#ff6b6b;cursor:pointer;font-size:11px;font-weight:700}
.card .copiar{float:right;color:#8a8a95;cursor:pointer;font-size:11px;font-weight:700;margin-right:8px;background:none;border:none;padding:0;font-family:inherit}
.card .copiar:hover{color:#d4af37}
.card .copiar.copiado{color:#23d18b}
.leads-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:4px}
.lead-card{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px 12px;font-size:12.5px}
.lead-nombre{font-weight:700;color:#f3f3f5;margin-bottom:2px}
.lead-meta{color:#8a8a95;font-size:11px;margin-bottom:6px}
.lead-tel-row{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.lead-tel{color:#d4af37;font-weight:700}
.lead-tel-row .copiar{background:rgba(212,175,55,.12);border:1px solid rgba(212,175,55,.3);color:#d4af37;border-radius:6px;padding:2px 10px;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit}
.lead-tel-row .copiar:hover{background:rgba(212,175,55,.22)}
.lead-tel-row .copiar.copiado{color:#23d18b;border-color:rgba(35,209,139,.4);background:rgba(35,209,139,.12)}
.lead-dir{color:#b8b8c3;font-size:11.5px;margin-bottom:2px}
.lead-web{color:#8a8a95;font-size:11px;word-break:break-all}
.leads-paginacion{display:flex;align-items:center;gap:12px;justify-content:center;margin-top:14px;color:#b8b8c3;font-size:12.5px;flex-wrap:wrap}
.leads-paginacion button{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#f3f3f5;border-radius:8px;padding:6px 14px;cursor:pointer;font-family:inherit}
.leads-paginacion button:disabled{opacity:.35;cursor:default}
.check-item{display:flex;align-items:flex-start;gap:6px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:6px 8px;font-size:12.5px;cursor:pointer}
.check-item.hecho{opacity:.5}
.check-item.hecho .texto{text-decoration:line-through}
.check-box{width:15px;height:15px;border-radius:4px;border:2px solid #888;flex-shrink:0;margin-top:1px}
.check-item.hecho .check-box{background:#34C759;border-color:#34C759}
.form-mini{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.form-mini input,.form-mini textarea,.form-mini select{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 8px;color:#f3f3f5;font-size:12px;font-family:inherit}
.form-mini textarea{resize:vertical;min-height:40px}
.form-mini button{padding:6px;border-radius:8px;border:none;background:#d4af37;color:#121216;font-weight:700;font-size:11px;cursor:pointer}
.form-row{display:flex;gap:6px}
.form-row input[type=time]{width:90px;flex-shrink:0}
.hidden{display:none!important}
.precios-cat{margin-bottom:18px}
.precios-cat h3{color:#d4af37;font-size:14px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid rgba(212,175,55,.2);padding-bottom:6px}
.precios-tabla{width:100%;border-collapse:collapse;font-size:13px}
.precios-tabla td{padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.06)}
.precios-tabla input{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:5px 7px;color:#f3f3f5;font-size:12.5px;font-family:inherit;width:100%}
.precios-tabla .col-precio input{width:110px}
.precios-tabla .borrar{color:#ff6b6b;cursor:pointer;font-weight:700}
.add-servicio{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.add-servicio input{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;color:#f3f3f5;font-size:12.5px;font-family:inherit}
${SIDEBAR_CSS}
</style>
</head>
<body>
${renderSidebarHtml('calendario')}
<div class="shell">
  <div class="panel">
    <div class="eyebrow">Virtual Marketing Spain · Oficina Virtual</div>
    <h1>Calendario Semanal</h1>
    <p>Planifica qué trabaja la oficina cada día y a qué hora, controla tus tareas manuales, y consulta los precios reales de cada servicio.</p>
    <div class="button-row">
      <a class="btn-gold" href="/office" style="text-decoration:none">← Volver a la oficina</a>
      <a class="btn-gold" href="/manual" style="text-decoration:none">Manual operativo</a>
    </div>
  </div>

  <div class="panel">
    <div class="tabs">
      <button class="tab-btn active" data-tab="ia" onclick="cambiarTab('ia')">Trabajo para la oficina (IA)</button>
      <button class="tab-btn" data-tab="redes" onclick="cambiarTab('redes')">Redes sociales</button>
      <button class="tab-btn" data-tab="manual" onclick="cambiarTab('manual')">Mis tareas manuales</button>
      <button class="tab-btn" data-tab="precios" onclick="cambiarTab('precios')">Servicios y precios</button>
      <button class="tab-btn" data-tab="llamadas" onclick="cambiarTab('llamadas')">Llamadas</button>
    </div>

    <div id="tab-ia">
      <p>Asigna a la oficina qué empresa/marca trabajar cada día, a qué hora y qué tiene que hacer. Los trabajadores de la oficina lo usan como plan de trabajo real, ordenado por hora.</p>
      <div class="semana-grid-wrap"><div class="semana-grid" id="grid-ia"></div></div>
      <div class="panel" style="margin-top:14px">
        <h3 style="margin:0 0 10px;font-size:14px;color:#d4af37">+ Asignar tarea nueva</h3>
        <div class="form-mini" style="max-width:420px">
          <div class="form-row">
            <select id="dia-nuevo-ia">${DIAS_SEMANA.map((d) => `<option value="${d}">${diasLabel[d]}</option>`).join('')}</select>
            <input type="time" id="hora-nuevo-ia">
          </div>
          <input type="text" placeholder="Empresa/marca" id="empresa-nuevo-ia">
          <textarea placeholder="Qué hay que hacer" id="tareas-nuevo-ia"></textarea>
          <button onclick="anadirIA(document.getElementById('dia-nuevo-ia').value)">+ Asignar</button>
        </div>
      </div>
    </div>

    <div id="tab-redes" class="hidden">
      <p>Qué se publica en redes sociales cada día, a qué hora y en qué cuenta -- se rellena solo con lo que generan Reel/Flyer/Historia/Carrusel (hora real calculada por Investigación de Redes), ordenado por hora.</p>
      <div class="semana-grid-wrap"><div class="semana-grid" id="grid-redes"></div></div>
    </div>

    <div id="tab-manual" class="hidden">
      <p>Cosas que aún haces tú a mano (aún no automatizadas): revisar actualizaciones de páginas, publicaciones semanales de Google My Business por empresa, llamadas, etc. Se marcan como hechas y quedan guardadas, ordenadas por hora.</p>
      <div class="semana-grid-wrap"><div class="semana-grid" id="grid-manual"></div></div>
    </div>

    <div id="tab-precios" class="hidden">
      <p>Precios reales y actuales de todos los servicios (sacados de virtualmarketingspain.com/presupuesto). Editables aquí mismo si cambian — así los trabajadores de la oficina y tú siempre veis el precio correcto.</p>
      <div id="lista-precios"></div>
      <div class="add-servicio">
        <input type="text" placeholder="Categoría" id="nueva-categoria" style="width:140px">
        <input type="text" placeholder="Servicio" id="nuevo-servicio" style="flex:1;min-width:160px">
        <input type="text" placeholder="Precio (ej: 250€ o 300€/mes)" id="nuevo-precio" style="width:180px">
        <button class="btn-gold" onclick="anadirServicio()">+ Añadir servicio</button>
      </div>
    </div>

    <div id="tab-llamadas" class="hidden">
      <p>Todos los leads reales del scraper (Nombre, teléfono, dirección), organizados por categoría y ciudad, para llamar sin salir de la oficina.</p>
      <div class="form-row" style="margin-bottom:12px;gap:10px">
        <input type="text" id="leads-categoria" list="leads-categorias-lista" placeholder="Buscar categoría (ej: inmobiliaria)..." autocomplete="off" oninput="cargarCiudadesLeads();buscarLeads(1)" style="flex:1;min-width:220px">
        <datalist id="leads-categorias-lista"></datalist>
        <select id="leads-ciudad" onchange="buscarLeads(1)" style="flex:1;min-width:180px"><option value="">Todas las ciudades</option></select>
      </div>
      <div id="leads-resultados" class="leads-grid"></div>
      <div id="leads-paginacion" class="leads-paginacion"></div>
    </div>
  </div>
</div>

<script>
const DIAS = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];
const LABEL = ${JSON.stringify(diasLabel)};
let DATA = { planSemanalIA: {}, planSemanalRedes: {}, tareasManuales: {} };
let PRECIOS = [];

let leadsInicializado = false;
function cambiarTab(t) {
  document.getElementById('tab-ia').classList.toggle('hidden', t !== 'ia');
  document.getElementById('tab-redes').classList.toggle('hidden', t !== 'redes');
  document.getElementById('tab-manual').classList.toggle('hidden', t !== 'manual');
  document.getElementById('tab-precios').classList.toggle('hidden', t !== 'precios');
  document.getElementById('tab-llamadas').classList.toggle('hidden', t !== 'llamadas');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  if (t === 'llamadas' && !leadsInicializado) {
    leadsInicializado = true;
    cargarCategoriasLeads().then(() => buscarLeads(1));
  }
}

async function cargarCategoriasLeads() {
  const r = await fetch('/api/leads/categorias');
  if (!r.ok) return;
  const d = await r.json();
  const lista = document.getElementById('leads-categorias-lista');
  lista.innerHTML = d.categorias.map(c => '<option value="' + esc(c.categoria) + '">' + esc(c.categoria) + ' (' + c.count + ')</option>').join('');
  const input = document.getElementById('leads-categoria');
  input.placeholder = 'Buscar categoría (ej: inmobiliaria)... -- ' + d.total + ' leads en total';
}

async function cargarCiudadesLeads() {
  const categoria = document.getElementById('leads-categoria').value;
  const r = await fetch('/api/leads/ciudades?categoria=' + encodeURIComponent(categoria));
  if (!r.ok) return;
  const d = await r.json();
  const sel = document.getElementById('leads-ciudad');
  sel.innerHTML = '<option value="">Todas las ciudades</option>' +
    d.ciudades.map(c => '<option value="' + esc(c.ciudad) + '">' + esc(c.ciudad) + ' (' + c.count + ')</option>').join('');
}

async function buscarLeads(pagina) {
  const categoria = document.getElementById('leads-categoria').value;
  const ciudad = document.getElementById('leads-ciudad').value;
  const params = new URLSearchParams({ categoria, ciudad, page: String(pagina || 1), limit: '50' });
  const r = await fetch('/api/leads?' + params.toString());
  if (!r.ok) return;
  const d = await r.json();
  pintarLeads(d);
}

function pintarLeads(d) {
  const cont = document.getElementById('leads-resultados');
  if (!d.leads.length) {
    cont.innerHTML = '<p style="color:#6b6b78">Sin resultados para este filtro.</p>';
    document.getElementById('leads-paginacion').innerHTML = '';
    return;
  }
  cont.innerHTML = d.leads.map(l => '<div class="lead-card">' +
    '<div class="lead-nombre">' + esc(l.nombre) + '</div>' +
    '<div class="lead-meta">' + esc(l.categoria) + ' · ' + esc(l.ciudad) + '</div>' +
    '<div class="lead-tel-row"><span class="lead-tel">' + esc(l.telefono) + '</span>' +
    '<button type="button" class="copiar" data-texto="' + esc(l.telefono) + '" onclick="copiarTexto(this)">Copiar</button></div>' +
    (l.direccion ? '<div class="lead-dir">' + esc(l.direccion) + '</div>' : '') +
    (l.web ? '<a class="lead-web" href="' + esc(l.web) + '" target="_blank" rel="noopener">' + esc(l.web) + '</a>' : '') +
    '</div>').join('');
  const totalPaginas = Math.max(1, Math.ceil(d.total / d.limit));
  document.getElementById('leads-paginacion').innerHTML =
    '<button' + (d.page <= 1 ? ' disabled' : '') + ' onclick="buscarLeads(' + (d.page - 1) + ')">← Anterior</button>' +
    '<span>Página ' + d.page + ' de ' + totalPaginas + ' (' + d.total + ' resultados)</span>' +
    '<button' + (d.page >= totalPaginas ? ' disabled' : '') + ' onclick="buscarLeads(' + (d.page + 1) + ')">Siguiente →</button>';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function cargar() {
  const r = await fetch('/api/plan-semanal');
  if (r.ok) { DATA = await r.json(); pintarIA(); pintarRedes(); pintarManual(); }
  const r2 = await fetch('/api/servicios-precios');
  if (r2.ok) { const d2 = await r2.json(); PRECIOS = d2.serviciosPrecios || []; pintarPrecios(); }
}

function nombresUnicos(planPorDia, campo) {
  const set = new Set();
  DIAS.forEach(dia => (planPorDia[dia] || []).forEach(it => { if (it[campo]) set.add(it[campo]); }));
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

function cabeceraDias() {
  return \`<div class="empresa-cabecera">\${DIAS.map(dia => \`<div class="dia-titulo">\${LABEL[dia]}</div>\`).join('')}</div>\`;
}

async function copiarTexto(btn) {
  const texto = btn.getAttribute('data-texto') || '';
  let ok = false;
  try {
    await navigator.clipboard.writeText(texto);
    ok = true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); ok = true; } catch (e2) { ok = false; }
    document.body.removeChild(ta);
  }
  if (!ok) return;
  const original = btn.textContent;
  btn.textContent = 'Copiado';
  btn.classList.add('copiado');
  setTimeout(() => { btn.textContent = original; btn.classList.remove('copiado'); }, 1200);
}

function pintarIA() {
  const grid = document.getElementById('grid-ia');
  const plan = DATA.planSemanalIA || {};
  const empresas = nombresUnicos(plan, 'empresa');
  const bloques = empresas.map(empresa => {
    const celdas = DIAS.map(dia => {
      const items = (plan[dia] || []).filter(it => it.empresa === empresa);
      const cards = items.map(it => \`<div class="card">
        <span class="borrar" onclick="borrarIA('\${dia}',\${it.id})">✕</span>
        <button type="button" class="copiar" data-texto="\${esc(it.tareas)}" onclick="copiarTexto(this)">Copiar</button>
        \${it.hora ? '<span class="hora">' + esc(it.hora) + '</span>' : ''}
        <div class="tareas">\${esc(it.tareas)}</div>
      </div>\`).join('');
      return \`<div class="dia-celda">\${cards || '<div class="dia-celda-vacia">—</div>'}</div>\`;
    }).join('');
    return \`<div class="empresa-bloque">
      <div class="empresa-titulo">\${esc(empresa)} · Calendario</div>
      <div class="empresa-fila">\${celdas}</div>
    </div>\`;
  }).join('');
  grid.innerHTML = \`<div class="empresa-tabla">\${empresas.length ? cabeceraDias() : ''}\${bloques || '<p style="color:#6b6b78">Nada asignado todavía.</p>'}</div>\`;
}

const TIPO_LABEL = { reel: 'Reel', flyer: 'Flyer', historia: 'Historia', carrusel: 'Carrusel' };
function pintarRedes() {
  const grid = document.getElementById('grid-redes');
  const plan = DATA.planSemanalRedes || {};
  const marcas = nombresUnicos(plan, 'marca');
  const bloques = marcas.map(marca => {
    const celdas = DIAS.map(dia => {
      const items = (plan[dia] || []).filter(it => it.marca === marca);
      const cards = items.map(it => \`<div class="card">
        <span class="borrar" onclick="borrarRedes('\${dia}',\${it.id})">✕</span>
        <button type="button" class="copiar" data-texto="\${esc(it.resumen)}" onclick="copiarTexto(this)">Copiar</button>
        \${it.hora ? '<span class="hora">' + esc(it.hora) + '</span>' : ''}\${it.tipo ? '<span class="tipo">' + esc(TIPO_LABEL[it.tipo] || it.tipo) + '</span>' : ''}
        \${it.cuenta ? '<div style="color:#8a8a95;font-size:10.5px">' + esc(it.cuenta) + '</div>' : ''}
        <div class="tareas">\${esc(it.resumen)}</div>
      </div>\`).join('');
      return \`<div class="dia-celda">\${cards || '<div class="dia-celda-vacia">—</div>'}</div>\`;
    }).join('');
    return \`<div class="empresa-bloque">
      <div class="empresa-titulo">\${esc(marca)} · Calendario</div>
      <div class="empresa-fila">\${celdas}</div>
    </div>\`;
  }).join('');
  grid.innerHTML = \`<div class="empresa-tabla">\${marcas.length ? cabeceraDias() : ''}\${bloques || '<p style="color:#6b6b78">Nada programado todavía.</p>'}</div>\`;
}

async function borrarRedes(dia, id) {
  await fetch('/api/plan-semanal/redes/borrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dia, id }) });
  cargar();
}

function pintarManual() {
  const grid = document.getElementById('grid-manual');
  grid.innerHTML = DIAS.map(dia => {
    const items = (DATA.tareasManuales && DATA.tareasManuales[dia]) || [];
    const cards = items.map(it => \`<div class="check-item \${it.hecho ? 'hecho' : ''}" onclick="toggleManual('\${dia}',\${it.id})">
      <div class="check-box"></div>
      <div style="flex:1">\${it.hora ? '<span class="hora">' + esc(it.hora) + '</span> ' : ''}<span class="texto">\${esc(it.texto)}</span></div>
      <span class="borrar" onclick="event.stopPropagation();borrarManual('\${dia}',\${it.id})">✕</span>
    </div>\`).join('');
    return \`<div class="dia-col">
      <div class="dia-titulo">\${LABEL[dia]}</div>
      \${cards}
      <div class="form-mini">
        <div class="form-row">
          <input type="time" id="hora-manual-\${dia}">
          <input type="text" placeholder="Nueva tarea" id="manual-\${dia}">
        </div>
        <button onclick="anadirManual('\${dia}')">+ Añadir</button>
      </div>
    </div>\`;
  }).join('');
}

function pintarPrecios() {
  const cont = document.getElementById('lista-precios');
  const categorias = [...new Set(PRECIOS.map(p => p.categoria))];
  if (!categorias.length) { cont.innerHTML = '<p>Sin servicios cargados todavía.</p>'; return; }
  cont.innerHTML = categorias.map(cat => {
    const filas = PRECIOS.filter(p => p.categoria === cat).map(p => \`<tr>
      <td><input value="\${esc(p.servicio)}" onchange="editarServicio(\${p.id},'servicio',this.value)"></td>
      <td class="col-precio"><input value="\${esc(p.precio)}" onchange="editarServicio(\${p.id},'precio',this.value)"></td>
      <td><span class="borrar" onclick="borrarServicio(\${p.id})">✕</span></td>
    </tr>\`).join('');
    return \`<div class="precios-cat">
      <h3>\${esc(cat)}</h3>
      <table class="precios-tabla"><tbody>\${filas}</tbody></table>
    </div>\`;
  }).join('');
}

async function anadirIA(dia) {
  const hora = document.getElementById('hora-nuevo-ia').value;
  const empresa = document.getElementById('empresa-nuevo-ia').value.trim();
  const tareas = document.getElementById('tareas-nuevo-ia').value.trim();
  if (!empresa) return;
  await fetch('/api/plan-semanal/ia', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dia, hora, empresa, tareas }) });
  cargar();
}

async function borrarIA(dia, id) {
  await fetch('/api/plan-semanal/ia/borrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dia, id }) });
  cargar();
}

async function anadirManual(dia) {
  const hora = document.getElementById('hora-manual-' + dia).value;
  const texto = document.getElementById('manual-' + dia).value.trim();
  if (!texto) return;
  await fetch('/api/plan-semanal/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dia, hora, texto }) });
  cargar();
}

async function toggleManual(dia, id) {
  await fetch('/api/plan-semanal/manual/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dia, id }) });
  cargar();
}

async function borrarManual(dia, id) {
  await fetch('/api/plan-semanal/manual/borrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dia, id }) });
  cargar();
}

async function anadirServicio() {
  const categoria = document.getElementById('nueva-categoria').value.trim();
  const servicio = document.getElementById('nuevo-servicio').value.trim();
  const precio = document.getElementById('nuevo-precio').value.trim();
  if (!categoria || !servicio) return;
  await fetch('/api/servicios-precios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoria, servicio, precio }) });
  document.getElementById('nueva-categoria').value = '';
  document.getElementById('nuevo-servicio').value = '';
  document.getElementById('nuevo-precio').value = '';
  cargar();
}

async function editarServicio(id, campo, valor) {
  await fetch('/api/servicios-precios/editar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, [campo]: valor }) });
}

async function borrarServicio(id) {
  await fetch('/api/servicios-precios/borrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  cargar();
}

cargar();
</script>
</body>
</html>`;
}

function renderEstadoSistemaHtml() {
  const logsDir = '/app/autoheal-logs';
  let alerta = '';
  let logTail = '(sin datos todavia -- el chequeo automatico corre cada 4h desde las 20:00)';
  let ultimaEjecucion = '';

  try {
    const alertaPath = path.join(logsDir, 'ALERTAS_PENDIENTES.txt');
    if (fs.existsSync(alertaPath)) {
      const contenido = fs.readFileSync(alertaPath, 'utf8').trim();
      if (contenido) alerta = contenido;
    }
  } catch (e) { /* sin permiso o no montado todavia */ }

  try {
    const files = fs.readdirSync(logsDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
      .reverse();
    if (files.length) {
      const full = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
      const lineas = full.trim().split('\n');
      logTail = lineas.slice(-200).join('\n');
      const inicios = lineas.filter((l) => l.includes('inicio run.sh'));
      if (inicios.length) ultimaEjecucion = inicios[inicios.length - 1];
    }
  } catch (e) { /* sin permiso o no montado todavia */ }

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Estado del sistema · Oficina Virtual</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:linear-gradient(180deg,#0b0b0f 0%,#13131a 100%);color:#f3f3f5}
.shell{max-width:1100px;margin:0 auto;padding:24px}
.panel{background:rgba(20,20,27,.92);border:1px solid rgba(212,175,55,.20);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.28);padding:20px;margin-bottom:18px}
.eyebrow{color:#d4af37;font-size:12px;text-transform:uppercase;letter-spacing:.18em;margin-bottom:12px}
h1,h2,h3{margin:0 0 12px}
h1{font-size:28px;line-height:1.1}
p,span{color:#b8b8c3;line-height:1.6}
.btn-gold{padding:12px 16px;border-radius:999px;font-weight:800;text-decoration:none;cursor:pointer;border:none;background:#d4af37;color:#121216;font-size:13px;display:inline-flex;align-items:center}
.banner-ok{background:rgba(52,199,89,.12);border:1px solid rgba(52,199,89,.4);color:#34C759;border-radius:14px;padding:14px 16px;font-weight:700}
.banner-alerta{background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.4);color:#ff6b6b;border-radius:14px;padding:14px 16px;font-weight:700;white-space:pre-wrap;font-family:monospace;font-size:12.5px}
.log{background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap;max-height:520px;overflow-y:auto;color:#d0d0d8}
.meta{font-size:12px;color:#888;margin-top:8px}
${SIDEBAR_CSS}
</style>
</head>
<body>
${renderSidebarHtml('estado')}
<div class="shell">
  <div class="panel">
    <div class="eyebrow">Virtual Marketing Spain · Oficina Virtual</div>
    <h1>Estado del sistema</h1>
    <p>Vigilancia automática del VPS (n8n, Ollama, panel) — se revisa sola cada 4 horas desde las 20:00. Si algo se arregla solo, aparece aquí igual; si algo no se puede arreglar solo, sale en rojo.</p>
    <a class="btn-gold" href="/office">&larr; Volver a la oficina</a>
  </div>
  <div class="panel">
    ${alerta ? `<div class="banner-alerta">⚠ Hay algo que revisar a mano:\n\n${alerta.replace(/</g, '&lt;')}</div>` : '<div class="banner-ok">✔ Todo en orden — nada pendiente de revisar a mano.</div>'}
    ${ultimaEjecucion ? `<div class="meta">Última comprobación: ${ultimaEjecucion.replace(/</g, '&lt;')}</div>` : ''}
  </div>
  <div class="panel">
    <h3>Registro de hoy (últimas líneas)</h3>
    <div class="log">${logTail.replace(/</g, '&lt;')}</div>
  </div>
  <div class="panel">
    <h3>Tickets al equipo técnico</h3>
    <p style="margin-top:0">Cosas que el chat de la oficina no ha podido resolver solo y quedan anotadas para revisión técnica (Claude Code).</p>
    <div id="tickets-list">Cargando...</div>
  </div>
</div>
<script>
async function cargarTickets(){
  try{
    const r = await fetch('/api/tickets');
    const data = await r.json();
    const list = document.getElementById('tickets-list');
    const tickets = data.tickets || [];
    if (!tickets.length) { list.innerHTML = '<p>Sin tickets pendientes.</p>'; return; }
    list.innerHTML = tickets.map(function(t){
      const fecha = new Date(t.timestamp).toLocaleString('es-ES');
      const color = t.estado === 'resuelto' ? '#34C759' : '#ff6b6b';
      return '<div style="border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;gap:10px"><b style="color:'+color+'">'+t.estado+'</b><span class="meta">'+fecha+' &middot; '+ (t.origen||'') +'</span></div>' +
        '<p style="margin:8px 0 0">'+String(t.mensaje||'').replace(/</g,'&lt;')+'</p>' +
        (t.estado !== 'resuelto' ? '<button class="btn-gold" style="margin-top:8px" onclick="resolverTicket('+t.id+')">Marcar resuelto</button>' : '') +
      '</div>';
    }).join('');
  } catch(e) { document.getElementById('tickets-list').innerHTML = '<p>No se pudieron cargar los tickets.</p>'; }
}
async function resolverTicket(id){
  await fetch('/api/tickets/'+id+'/resolver', { method:'POST' });
  cargarTickets();
}
cargarTickets();
</script>
</body>
</html>`;
}

function renderManualHtml() {
  const porDepartamento = {};
  for (const [id, info] of Object.entries(MISSION_DATA.agentes)) {
    if (!porDepartamento[info.dept]) porDepartamento[info.dept] = [];
    porDepartamento[info.dept].push({ id, ...info });
  }

  const deptOrder = Object.keys(DEPT_TITLES).filter((d) => porDepartamento[d]);

  const seccionesHtml = deptOrder.map((dept) => {
    const workers = porDepartamento[dept];
    const filas = workers.map((w) => `
      <tr data-agent="${escapeHtml(w.id)}">
        <td class="w-name">${escapeHtml(w.id)}${w.prioridad ? `<span class="prio-badge prio-${escapeHtml(w.prioridad)}">${escapeHtml(w.prioridad)}</span>` : ''}${w.leaderEquivalente ? `<div class="reinforces">refuerza a ${escapeHtml(w.leaderEquivalente)}</div>` : ''}</td>
        <td class="live-status" data-status-cell><span class="dot"></span>cargando…</td>
        <td>${escapeHtml(w.mission)}</td>
        <td>${escapeHtml(w.diaria)}</td>
        <td>${escapeHtml(w.semanal)}</td>
        <td>${escapeHtml(w.kpi)}</td>
        <td>${(w.marcas || []).map((m) => `<span class="brand-chip">${escapeHtml(m)}</span>`).join('')}</td>
        <td>${w.acceso ? escapeHtml(w.acceso.join(' · ')) : '<span class="no-data">—</span>'}</td>
      </tr>`).join('');
    return `
    <details class="dept-block">
      <summary><h3>${escapeHtml(DEPT_TITLES[dept])} <span class="count">${workers.length}</span></h3>
        <span class="tools">${escapeHtml(MISSION_DATA.herramientasPorDepartamento[dept] || '')}</span>
      </summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Trabajador</th><th>Estado real</th><th>Misión</th><th>Diario</th><th>Semanal</th><th>KPI</th><th>Marcas</th><th>Acceso real</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');

  const ritmoDiarioHtml = MISSION_DATA.ritmoDiario.map((r) => `<div class="ritmo-item"><strong>${escapeHtml(r.hora)}</strong><span>${escapeHtml(r.accion)}</span></div>`).join('');
  const ritmoSemanalHtml = Object.entries(MISSION_DATA.ritmoSemanal).map(([dia, tema]) => `<div class="ritmo-item"><strong>${escapeHtml(dia)}</strong><span>${escapeHtml(tema)}</span></div>`).join('');
  const reglaMadreHtml = MISSION_DATA.reglaMadre.map((r) => `<li>${escapeHtml(r)}</li>`).join('');


  const ejemplosDept = {
    direccion: 'Revisa las prioridades de la semana y dime en que deberiamos enfocarnos primero.',
    operaciones: 'Controla que todas las automatizaciones esten funcionando y avisame si algo falla.',
    community: 'Quiero un feed en todas las cuentas de Instagram y Facebook esta semana.',
    copy: 'Escribe 3 variantes de copy para el proximo Reel, con gancho fuerte al principio.',
    comerciales: 'Haz seguimiento a los leads nuevos de esta semana y priorizalos por interes.',
    auditorias: 'Prepara una auditoria de la web de [cliente] antes del viernes.',
    seo: 'Revisa el posicionamiento SEO de nuestras webs propias y dime que prioriza esta semana.',
    gmb: 'Prepara 3 publicaciones nuevas para la ficha de Google Business de [negocio].',
    web: 'Revisa la conversion de la landing y dime que cambiarias primero.',
    automatizacion: 'Revisa que las automatizaciones de n8n esten funcionando bien.',
    ads: 'Dame un resumen del rendimiento de los anuncios activos esta semana.',
    research: 'Investiga que estan haciendo bien nuestros competidores esta semana.',
  };
  const ejemplosDeptHtml = deptOrder.map((dept) => `
    <div class="plantilla-item">
      <div class="plantilla-label">${escapeHtml(DEPT_TITLES[dept])}</div>
      <div class="plantilla-texto" data-copy>${escapeHtml(ejemplosDept[dept] || 'Cuentame que necesitas de este equipo.')}</div>
    </div>`).join('');

  const ejemplosAutomatizacion = {
    publicar_instagram: 'Publica ya el contenido nuevo en Instagram.',
    publicar_flyer: 'Genera y publica el flyer de hoy.',
    publicar_reel: 'Publica un reel nuevo hoy en Instagram y Facebook.',
    publicar_historia: 'Publica una historia nueva hoy.',
    auditoria_seo: 'Hazme la auditoria SEO de nuestras webs.',
    auditoria_web: 'Audita la conversion de nuestra web.',
    pentest_seguridad: 'Haz una auditoria de seguridad tecnica ahora.',
    generar_contenido: 'Genera contenido nuevo para redes de las 4 marcas.',
    ideas_virales: 'Dame ideas virales con gancho y guion.',
    gmb_contenido: 'Prepara publicaciones para Google Business.',
    gmb_resumen_diario: 'Mandame el resumen diario de Google Business de todas las empresas.',
    reporte_diario: 'Genera el reporte diario del CEO.',
    revisar_correos: 'Revisa los correos de Gmail pendientes.',
    plugfyguard_vigilancia: 'Revisa la vigilancia de PlugfyGuard.',
    vigilancia_alertas: 'Revisa alertas y vigilancia general.',
    revisar_errores_n8n: 'Revisa si hay errores en n8n ahora mismo.',
    auditoria_empresa: 'Prepara una auditoria para el cliente [nombre].',
    auditoria_web_cliente: 'Audita si la web de [cliente] funciona bien y esta adaptada a movil.',
    investigacion_redes: 'Investiga a la competencia en redes sociales.',
    briefing_web: 'Genera un briefing para una web nueva.',
    generar_imagen: 'Genera la imagen del siguiente contenido pendiente.',
    reenviar_factura: 'Reenvia la ultima factura de [cliente].',
    estado_ventas: 'Como van las ventas y llamadas ahora mismo?',
    propuesta_auditoria: 'Convierte la ultima auditoria en una propuesta de venta.',
    copy_con_investigacion: 'Escribe un copy sobre [tema] con datos reales de investigacion.',
    propuesta_lead: 'Escribe un mensaje de primer contacto para el siguiente lead.',
    copy_bajo_demanda: 'Escribeme un titular/hook para [tema].',
    investigar_competidor: 'Investiga al competidor [nombre] y dame fortalezas y debilidades.',
    estado_auditorias: 'Cuantas auditorias gratuitas hay pendientes y cuantas con cita?',
    lanzar_llamadas: 'Lanza ya el lote de llamadas de ventas.',
    metricas_redes: 'Dame las metricas reales de las ultimas publicaciones.',
    publicar_media_subida: 'Publica el video/foto que acabo de subir.',
  };
  const CATEGORIAS_AUTOMATIZACION = [
    { titulo: 'Publicar contenido', intentos: ['publicar_instagram', 'publicar_flyer', 'publicar_reel', 'publicar_historia', 'publicar_media_subida', 'generar_contenido', 'generar_imagen', 'ideas_virales'] },
    { titulo: 'Google Business', intentos: ['gmb_contenido', 'gmb_resumen_diario'] },
    { titulo: 'Auditorías y seguridad', intentos: ['auditoria_seo', 'auditoria_web', 'auditoria_web_cliente', 'auditoria_empresa', 'pentest_seguridad', 'plugfyguard_vigilancia'] },
    { titulo: 'Vigilancia y errores', intentos: ['revisar_errores_n8n', 'vigilancia_alertas', 'revisar_correos'] },
    { titulo: 'Ventas y llamadas', intentos: ['estado_ventas', 'lanzar_llamadas', 'estado_auditorias', 'propuesta_lead'] },
    { titulo: 'Investigación y copy', intentos: ['investigacion_redes', 'investigar_competidor', 'copy_bajo_demanda', 'copy_con_investigacion', 'propuesta_auditoria', 'briefing_web', 'metricas_redes'] },
    { titulo: 'Informes y administración', intentos: ['reporte_diario', 'reenviar_factura'] },
  ];
  const reglasPorIntento = Object.fromEntries(REGLAS_AUTOMATIZACION_REAL.map((r) => [r.intento, r]));
  const intentosCategorizados = new Set(CATEGORIAS_AUTOMATIZACION.flatMap((c) => c.intentos));
  const sinCategoria = REGLAS_AUTOMATIZACION_REAL.filter((r) => !intentosCategorizados.has(r.intento));
  const categoriasFinal = sinCategoria.length ? [...CATEGORIAS_AUTOMATIZACION, { titulo: 'Otras', intentos: sinCategoria.map((r) => r.intento) }] : CATEGORIAS_AUTOMATIZACION;
  const ejemplosAutomatizacionHtml = categoriasFinal.map((cat) => {
    const items = cat.intentos.map((intento) => {
      const r = reglasPorIntento[intento];
      if (!r) return '';
      return `<div class="plantilla-item">
        <div class="plantilla-label">${escapeHtml(r.intento)}</div>
        <div class="plantilla-texto" data-copy>${escapeHtml(ejemplosAutomatizacion[r.intento] || r.descripcion)}</div>
      </div>`;
    }).join('');
    return `<h4 style="margin:16px 0 8px;color:#B8A35A">${escapeHtml(cat.titulo)}</h4><div class="plantilla-grid">${items}</div>`;
  }).join('');

  const ejemplosOficinaHtml = [
    'Generad trabajo operativo real por grupo: redes, ventas, SEO, web, IA y operaciones.',
    'Dame un resumen de que esta pasando ahora mismo en toda la oficina.',
  ].map((t) => `
    <div class="plantilla-item">
      <div class="plantilla-label">Toda la oficina</div>
      <div class="plantilla-texto" data-copy>${escapeHtml(t)}</div>
    </div>`).join('');

  const guionesComerciales = [
    {
      label: 'WhatsApp - pedir cita (lead interesado sin fecha)',
      texto: 'Hola, buenos dias 👋 Mi nombre es Enrique, de Virtual Marketing Spain.\n\nLe llamamos hace unos dias con nuestra automatizacion con IA y nos comento que le interesaba conocer un poco mas como podemos ayudarle a conseguir mas clientes con automatizacion.\n\nNos gustaria concretar una breve llamada o auditoria gratuita, sin compromiso, para enseñarle exactamente como aplicarlo a su negocio.\n\n¿Que dia y hora le vendria bien esta semana?',
    },
  ];
  const guionesComercialesHtml = guionesComerciales.map((g) => `
    <div class="plantilla-item" style="grid-column:1 / -1">
      <div class="plantilla-label">${escapeHtml(g.label)}</div>
      <div class="plantilla-texto" data-copy style="white-space:pre-wrap">${escapeHtml(g.texto)}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Manual operativo · Oficina Virtual</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:linear-gradient(180deg,#0b0b0f 0%,#13131a 100%);color:#f3f3f5}
.shell{max-width:1320px;margin:0 auto;padding:24px}
.panel{background:rgba(20,20,27,.92);border:1px solid rgba(212,175,55,.20);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.28);padding:20px;margin-bottom:18px}
.eyebrow{color:#d4af37;font-size:12px;text-transform:uppercase;letter-spacing:.18em;margin-bottom:12px}
h1,h2,h3{margin:0 0 12px}
h1{font-size:36px;line-height:1.1}
p,span{color:#b8b8c3;line-height:1.6}
.button-row{display:flex;gap:10px;flex-wrap:wrap}
.btn-gold{padding:12px 16px;border-radius:999px;font-weight:800;text-decoration:none;cursor:pointer;border:none;background:#d4af37;color:#121216}
.regla-madre{margin:0;padding-left:20px}
.regla-madre li{color:#f3f3f5;margin-bottom:6px;font-weight:600}
.ritmo-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px}
.ritmo-item{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px 12px}
.ritmo-item strong{display:block;color:#d4af37;font-size:13px;margin-bottom:4px;text-transform:capitalize}
.ritmo-item span{font-size:12px}
.dept-block{background:rgba(20,20,27,.92);border:1px solid rgba(212,175,55,.20);border-radius:18px;margin-bottom:14px;overflow:hidden}
.dept-block summary{cursor:pointer;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;list-style:none}
.dept-block summary::-webkit-details-marker{display:none}
.dept-block summary h3{margin:0;display:flex;align-items:center;gap:10px}
.count{background:rgba(212,175,55,.15);color:#d4af37;font-size:12px;padding:3px 9px;border-radius:999px;font-weight:800}
.tools{font-size:12px;color:#8f8f99}
.table-wrap{overflow-x:auto;border-top:1px solid rgba(255,255,255,.06)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;padding:10px 14px;color:#d4af37;background:rgba(212,175,55,.06);white-space:nowrap;position:sticky;top:0}
td{padding:10px 14px;border-top:1px solid rgba(255,255,255,.05);vertical-align:top}
.w-name{font-weight:700;color:#f3f3f5;white-space:nowrap;font-family:monospace;font-size:11.5px}
.brand-chip{display:inline-block;background:rgba(212,175,55,.1);color:#e8c96b;border:1px solid rgba(212,175,55,.22);border-radius:999px;padding:2px 8px;font-size:10.5px;margin:2px 3px 2px 0;white-space:nowrap}
.no-data{color:#55555f}
.prio-badge{display:block;margin-top:3px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.prio-badge.prio-alta{color:#ff6467}
.prio-badge.prio-media{color:#f0b94f}
.prio-badge.prio-refuerzo{color:#8794ff}
.reinforces{margin-top:2px;font-size:9.5px;color:#6b6b76;font-style:italic;font-family:Inter,sans-serif}
.live-status{white-space:nowrap;font-size:11.5px}
.live-status .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#55555f}
.live-status .dot.working{background:#23d18b}
.live-status .dot.thinking{background:#57c7ff}
.live-status .dot.sleeping{background:#8794ff}
.live-status .dot.offline{background:#55555f}
.live-status .dot.waiting{background:#f0b94f}
.live-status .ago{display:block;color:#6b6b76;font-size:10px;margin-top:2px}
@media (max-width:780px){h1{font-size:28px}}
${SIDEBAR_CSS}
</style>
</head>
<body>
${renderSidebarHtml('manual')}
<div class="shell">
  <div class="panel">
    <div class="eyebrow">Manual operativo maestro</div>
    <h1>Misión, ritmo y KPI de los 142 trabajadores</h1>
    <p>Regla madre — vale para todos, siempre:</p>
    <ul class="regla-madre">${reglaMadreHtml}</ul>
    <div class="button-row" style="margin-top:14px">
      <a class="btn-gold" href="/office">Volver a oficina</a>
      <a class="btn-gold" href="/operations">Ir a operaciones</a>
      <a class="btn-dark" href="/logout">Cerrar sesión</a>
    </div>
  </div>
  <div class="panel">
    <h2>Ritmo diario obligatorio</h2>
    <div class="ritmo-row">${ritmoDiarioHtml}</div>
    <h2 style="margin-top:20px">Ritmo semanal obligatorio</h2>
    <div class="ritmo-row">${ritmoSemanalHtml}</div>
  </div>

  <div class="panel">
    <h2>Plantilla: que pedirle a cada departamento (copiar y pegar)</h2>
    <p>Estas frases funcionan directamente en la Instruccion de la Consola del CEO. Las de "Automatizaciones reales" ejecutan una accion de verdad; las de departamento generan una tarea de seguimiento en la oficina.</p>
    <h3 style="margin-top:16px">Automatizaciones reales (accion garantizada)</h3>
    ${ejemplosAutomatizacionHtml}
    <h3 style="margin-top:20px">Por departamento</h3>
    <div class="plantilla-grid">${ejemplosDeptHtml}</div>
    <h3 style="margin-top:20px">Toda la oficina</h3>
    <div class="plantilla-grid">${ejemplosOficinaHtml}</div>
  </div>
  <div class="panel">
    <h2>Guiones y mensajes para comerciales (copiar y pegar)</h2>
    <p>Plantillas listas para usar en llamadas y WhatsApp con leads reales.</p>
    <div class="plantilla-grid">${guionesComercialesHtml}</div>
  </div>
  ${seccionesHtml}
</div>
<script>
document.addEventListener('click', function(e){
  const item = e.target.closest('[data-copy]');
  if(!item) return;
  const texto = item.textContent;
  navigator.clipboard.writeText(texto).then(function(){
    item.parentElement.classList.add('copiado');
    setTimeout(function(){ item.parentElement.classList.remove('copiado'); }, 1200);
  });
});
function timeAgoManual(ms){
  if(!ms) return 'sin datos';
  const diff=Math.max(0,Date.now()-Number(ms));
  const min=Math.floor(diff/60000);
  if(min<1) return 'hace segundos';
  if(min<60) return 'hace '+min+'m';
  const h=Math.floor(min/60);
  if(h<24) return 'hace '+h+'h';
  const d=Math.floor(h/24);
  return 'hace '+d+'d';
}
const MANUAL_STATE_LABEL={working:'Trabajando',idle:'En espera',thinking:'Pensando',speaking:'Hablando',sleeping:'Pausado',error:'Con incidencia',offline:'Desconectado',collaborating:'Colaborando',waiting:'Esperando',listening:'Escuchando'};
async function refreshManualEstado(){
  try{
    const res=await fetch('/api/agents');
    const data=await res.json();
    const porId={};
    (data.agents||[]).forEach(a=>{ porId[a.agent]=a; });
    document.querySelectorAll('tr[data-agent]').forEach(row=>{
      const id=row.getAttribute('data-agent');
      const agent=porId[id];
      const cell=row.querySelector('[data-status-cell]');
      if(!cell) return;
      if(!agent){ cell.innerHTML='<span class="dot"></span>sin datos'; return; }
      const state=agent.state||'idle';
      const label=MANUAL_STATE_LABEL[state]||state;
      cell.innerHTML='<span class="dot '+state+'"></span>'+label+'<span class="ago">'+timeAgoManual(agent.lastSeen)+'</span>';
    });
  }catch(e){}
}
refreshManualEstado();
setInterval(refreshManualEstado,15000);
</script>
</body>
</html>`;
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function renderWordpressEmbedJs() {
  return `(function(){
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('page') !== 'vmsdash_gastos') return;
    if (document.getElementById('vms-office-premium-panel')) return;
    const officeUrl = '${publicOfficeUrl}/office';
    const metricsUrl = '${publicOfficeUrl}/api/metrics';
    const businessUrl = '${publicOfficeUrl}/api/business-metrics';
    if (!officeUrl.startsWith('http')) return;
    const style = document.createElement('style');
    style.id = 'vms-office-premium-style';
    style.textContent = '.vms-office-wrap{margin-top:18px;display:grid;gap:16px}.vms-office-card{background:var(--vm-surface);border:1px solid var(--vm-border);border-radius:14px;padding:22px 26px;color:var(--vm-white)}.vms-office-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.vms-office-top h2{margin:0;font-size:18px;color:var(--vm-white)}.vms-office-top p{margin:6px 0 0;color:var(--vm-muted);font-size:13px;max-width:760px}.vms-office-actions{display:flex;gap:10px;flex-wrap:wrap}.vms-office-btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;border:1px solid var(--vm-border);background:var(--vm-surface2);color:var(--vm-white)}.vms-office-btn.gold{background:var(--vm-gold-dim);color:var(--vm-gold-light);border-color:rgba(184,163,90,.35)}.vms-office-mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}.vms-office-stat{background:rgba(255,255,255,.03);border:1px solid var(--vm-border);border-radius:12px;padding:14px}.vms-office-stat-label{font-size:12px;color:var(--vm-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}.vms-office-stat-value{font-size:24px;font-weight:800;color:var(--vm-white)}.vms-office-stat-sub{font-size:12px;color:var(--vm-muted-dim);margin-top:4px}.vms-office-iframe{width:100%;min-height:1550px;border:1px solid var(--vm-border);border-radius:14px;background:#0b0b0d}.vms-office-note{font-size:12px;color:var(--vm-muted-dim);margin-top:10px}@media (max-width:900px){.vms-office-iframe{min-height:1950px}}';
    document.head.appendChild(style);
    const host = document.querySelector('.vmsdash-wrap') || document.querySelector('#wpbody-content .wrap') || document.querySelector('#wpbody-content');
    if (!host) return;
    const panel = document.createElement('section');
    panel.id = 'vms-office-premium-panel';
    panel.className = 'vms-office-wrap';
    panel.innerHTML = '<div class="vms-office-card"><div class="vms-office-top"><div><h2>Oficina Premium</h2><p>Dirección, redes, comerciales, SEO, auditorías, automatización y reporting dentro del mismo ecosistema visual. Este bloque amplifica Gastos IA y lo convierte en centro de mando.</p></div><div class="vms-office-actions"><a class="vms-office-btn gold" href="'+officeUrl+'" target="_blank" rel="noopener noreferrer">Abrir oficina completa</a><a class="vms-office-btn" href="'+metricsUrl+'" target="_blank" rel="noopener noreferrer">API métricas</a></div></div><div class="vms-office-mini" id="vms-office-mini-stats"><div class="vms-office-stat"><div class="vms-office-stat-label">Estado</div><div class="vms-office-stat-value">Cargando</div><div class="vms-office-stat-sub">Sincronizando oficina...</div></div></div><div class="vms-office-note">La consola completa sigue estando dentro de la oficina. Aquí la integras dentro del dashboard premium de WordPress.</div></div><div class="vms-office-card"><iframe class="vms-office-iframe" src="'+officeUrl+'" loading="lazy"></iframe></div>';
    host.appendChild(panel);
    Promise.all([fetch(metricsUrl).then(r => r.json()).catch(() => null), fetch(businessUrl).then(r => r.json()).catch(() => null)]).then(([metricsData, businessData]) => {
      const box = document.getElementById('vms-office-mini-stats');
      if (!box) return;
      const metrics = metricsData && metricsData.metrics ? metricsData.metrics : {};
      const biz = businessData && businessData.businessMetrics ? businessData.businessMetrics : {};
      const fmt = n => Number(n || 0).toLocaleString('es-ES');
      const eur = n => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(Number(n || 0));
      const cards = [
        ['Agentes activos', fmt(metrics.online), 'Total: ' + fmt(metrics.total)],
        ['Trabajando', fmt(metrics.working), 'Social: ' + fmt((metrics.detail||{}).social || 0)],
        ['Ventas', fmt(biz.ventas), 'Captaciones: ' + fmt(biz.captaciones)],
        ['Ganancias', eur(biz.ganancias), 'Gastos: ' + eur(biz.gastos)],
        ['n8n workflows', fmt(biz.n8n_workflows), 'Posts hoy: ' + fmt(biz.n8n_publicaciones_hoy)],
        ['Suscriptores', fmt(biz.suscriptores), 'Estado n8n: ' + String(biz.n8n_status || 'ok')]
      ];
      box.innerHTML = cards.map(item => '<div class="vms-office-stat"><div class="vms-office-stat-label">'+item[0]+'</div><div class="vms-office-stat-value">'+item[1]+'</div><div class="vms-office-stat-sub">'+item[2]+'</div></div>').join('');
    });
  } catch (e) {
    console.error('VMS Office Premium error', e);
  }
})();`;
}


function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  if (!ceoPanelToken) return false;
  return req.headers['x-ceo-token'] === ceoPanelToken;
}

function isHeartbeatAuthorized(req) {
  if (!heartbeatToken) return false;
  return req.headers['x-heartbeat-token'] === heartbeatToken;
}

// Proteccion tipo PlugfyGuard (bloqueo por fuerza bruta) para los endpoints
// protegidos por token de este servidor: no hay login de usuario aqui, asi
// que en vez de intentos de contrasena se cuentan respuestas 401 por IP.
const failedAuthAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const rec = failedAuthAttempts.get(ip);
  return !!(rec && rec.blockedUntil && Date.now() < rec.blockedUntil);
}

function recordFailedAuth(ip) {
  const now = Date.now();
  let rec = failedAuthAttempts.get(ip);
  if (!rec || now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
    rec = { count: 0, windowStart: now, blockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= RATE_LIMIT_MAX) rec.blockedUntil = now + RATE_LIMIT_WINDOW_MS;
  failedAuthAttempts.set(ip, rec);
}

// SOLO /login participa en el bloqueo por IP (fuerza bruta real: contraseña
// humana, tecleada, adivinable). Las rutas de API server-a-servidor
// (heartbeat, instructions, business-metrics, social/work-executions) estan
// protegidas por tokens largos aleatorios que no son adivinables en 5
// intentos -- meterlas en el mismo contador de IP causaba un fallo real
// en produccion (2026-08-22): TODAS las llamadas de n8n a la oficina
// comparten la misma IP aparente (el propio VPS), asi que un unico 401
// transitorio en CUALQUIER workflow (o el propio usuario probando el token
// del panel) bloqueaba 30 minutos las escrituras de TODOS los demas
// workflows reales (heartbeats/informes perdidos en cascada, confirmado
// con 57/156 ejecuciones en error en un solo dia). Cada ruta de API sigue
// comprobando su propio token de forma independiente (401 si no coincide)
// -- lo unico que cambia es que ese fallo ya no bloquea a nadie mas.
function isTokenProtectedPath(pathname) {
  if (pathname === '/login') return true;
  return false;
}

const server = http.createServer(async (req, res) => {
 try {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const clientIp = getClientIp(req);
  const protectedPath = isTokenProtectedPath(url.pathname);
  if (protectedPath && isRateLimited(clientIp)) {
    json(res, 429, { error: 'Demasiados intentos fallidos, reintenta mas tarde' });
    return;
  }
  if (protectedPath) {
    res.on('finish', () => {
      if (res.statusCode === 401) recordFailedAuth(clientIp);
    });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Heartbeat-Token, X-CEO-Token');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderStatusHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/login') {
    // Login automatico por token (para la app/APK privada del CEO): si la
    // URL trae ?token=CEO_PANEL_TOKEN se crea sesion de navegador directamente,
    // sin pedir email/contraseña. Mismo token que ya usa la API (isAuthorized).
    const tokenParam = url.searchParams.get('token');
    if (tokenParam && ceoPanelToken && tokenParam === ceoPanelToken) {
      const sessionId = createSession();
      res.writeHead(302, {
        Location: '/office',
        'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderLoginHtml(url.searchParams.get('error')));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    try {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const email = (params.get('email') || '').trim().toLowerCase();
      const password = params.get('password') || '';
      const ok = adminEmail && adminPasswordHash
        && email === adminEmail.toLowerCase()
        && verifyPassword(password, adminPasswordHash);
      if (!ok) {
        recordFailedAuth(clientIp);
        res.writeHead(302, { Location: '/login?error=1' });
        res.end();
        return;
      }
      const sessionId = createSession();
      res.writeHead(302, {
        Location: '/office',
        'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      res.end();
    } catch {
      res.writeHead(302, { Location: '/login?error=1' });
      res.end();
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/setup') {
    if (isAdminConfigured()) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderSetupHtml(url.searchParams.get('error')));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/setup') {
    if (isAdminConfigured()) {
      json(res, 403, { error: 'Ya existe un usuario administrador -- no se pueden crear mas.' });
      return;
    }
    try {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const email = (params.get('email') || '').trim().toLowerCase();
      const password = params.get('password') || '';
      if (!email || password.length < 8) {
        res.writeHead(302, { Location: '/setup?error=' + encodeURIComponent('Email valido y contraseña de al menos 8 caracteres.') });
        res.end();
        return;
      }
      saveAdminToFile(email, hashPasswordForStorage(password));
      const sessionId = createSession();
      res.writeHead(302, {
        Location: '/office',
        'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      res.end();
    } catch {
      res.writeHead(302, { Location: '/setup?error=' + encodeURIComponent('Algo fallo, intentalo de nuevo.') });
      res.end();
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logout') {
    const cookies = parseCookies(req);
    if (cookies[SESSION_COOKIE]) { sessions.delete(cookies[SESSION_COOKIE]); saveSessions(); }
    res.writeHead(302, {
      Location: '/login',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/office' || url.pathname === '/ceo' || url.pathname === '/operations' || url.pathname === '/manual' || url.pathname === '/inbox' || url.pathname === '/calendario-semanal' || url.pathname === '/estado-sistema')) {
    if (!isLoggedIn(req)) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/office') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(stripMarkedSection(renderOfficeHtml(), 'CEO_CONSOLE', '<section class="metrics-grid"><div class="panel metrics-card"><h3>Consola del CEO</h3><div class="events-list"><div class="event-line"><strong>Movida a su propia página</strong><span>Da órdenes de trabajo y controla las métricas desde la Consola del CEO, separada para que la oficina se vea limpia.</span></div></div><div class="button-row" style="margin-top:14px"><a class="btn-gold" href="/ceo" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">Abrir Consola del CEO</a></div></div></section>'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ceo') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(stripMarkedSection(renderOfficeHtml(), 'AGENT_GRID', ''));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/operations') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderOperationsHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/manual') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderManualHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/inbox') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderInboxHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/calendario-semanal') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderCalendarioSemanalHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/estado-sistema') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderEstadoSistemaHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/embed/wordpress-office.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(renderWordpressEmbedJs());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const list = publicAgents();
    const metrics = computeMetrics(list);
    json(res, 200, {
      miniverse: true,
      version: '1.0.0',
      agents: {
        online: metrics.online,
        total: metrics.total,
      },
      office: '/office',
      metrics,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const list = publicAgents();
    json(res, 200, { agents: list, metrics: computeMetrics(list), businessMetrics: publicBusinessMetrics() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/business-metrics') {
    json(res, 200, { businessMetrics: publicBusinessMetrics() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/leads/recargar') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    cargarLeads();
    json(res, 200, { ok: true, total: leadsData.length });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ads-borradores') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.negocio || !payload.plataforma) {
        json(res, 400, { error: 'faltan campos: negocio, plataforma' });
        return;
      }
      const borrador = {
        id: nextAdsBorradorId++,
        plataforma: String(payload.plataforma).slice(0, 20),
        negocio: String(payload.negocio).slice(0, 120),
        objetivo: String(payload.objetivo || '').slice(0, 300),
        estrategia: payload.estrategia || {},
        keywords: payload.keywords || null,
        audiencias: payload.audiencias || null,
        copy: payload.copy || {},
        creativo: payload.creativo || {},
        presupuesto: payload.presupuesto || {},
        estado: 'pendiente_revision',
        createdAt: Date.now(),
      };
      adsBorradores.unshift(borrador);
      if (adsBorradores.length > 200) adsBorradores.length = 200;
      saveState();
      json(res, 200, { ok: true, borrador });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ads-borradores') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { adsBorradores });
    return;
  }

  if (req.method === 'POST' && /^\/api\/ads-borradores\/\d+\/(aprobar|rechazar)$/.test(url.pathname)) {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const match = url.pathname.match(/^\/api\/ads-borradores\/(\d+)\/(aprobar|rechazar)$/);
    const id = Number(match[1]);
    const accion = match[2];
    const borrador = adsBorradores.find((b) => b.id === id);
    if (!borrador) {
      json(res, 404, { error: 'Borrador no encontrado' });
      return;
    }
    borrador.estado = accion === 'aprobar' ? 'aprobado' : 'rechazado';
    borrador.decididoAt = Date.now();
    saveState();
    json(res, 200, { ok: true, borrador });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leads/categorias') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const cuenta = {};
    for (const l of leadsData) cuenta[l.categoria] = (cuenta[l.categoria] || 0) + 1;
    const categorias = Object.entries(cuenta)
      .map(([categoria, count]) => ({ categoria, count }))
      .sort((a, b) => b.count - a.count);
    json(res, 200, { categorias, total: leadsData.length });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leads/ciudades') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const categoria = (url.searchParams.get('categoria') || '').toLowerCase();
    const cuenta = {};
    for (const l of leadsData) {
      if (categoria && !l.categoria.toLowerCase().includes(categoria)) continue;
      cuenta[l.ciudad] = (cuenta[l.ciudad] || 0) + 1;
    }
    const ciudades = Object.entries(cuenta)
      .map(([ciudad, count]) => ({ ciudad, count }))
      .sort((a, b) => b.count - a.count);
    json(res, 200, { ciudades });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leads') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const categoria = (url.searchParams.get('categoria') || '').toLowerCase();
    const ciudad = url.searchParams.get('ciudad') || '';
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    let filtrados = leadsData;
    if (categoria) filtrados = filtrados.filter((l) => l.categoria.toLowerCase().includes(categoria));
    if (ciudad) filtrados = filtrados.filter((l) => l.ciudad === ciudad);
    const total = filtrados.length;
    const start = (page - 1) * limit;
    const leads = filtrados.slice(start, start + limit);
    json(res, 200, { leads, total, page, limit });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/social-executions') {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { socialExecutions: publicSocialExecutions() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/work-executions') {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { workExecutions: publicWorkExecutions() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/reportes') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { reportes: reportes.slice(-60).reverse() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reportes') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req, 20 * 1024 * 1024);
      const payload = JSON.parse(body || '{}');
      if (!payload.fecha || !payload.html) {
        json(res, 400, { error: 'Missing required fields: fecha, html' });
        return;
      }
      fs.mkdirSync(reportesDir, { recursive: true });
      const id = nextReporteId++;
      fs.writeFileSync(path.join(reportesDir, id + '.html'), String(payload.html));
      let tienePdf = false;
      if (payload.pdf_b64) {
        fs.writeFileSync(path.join(reportesDir, id + '.pdf'), Buffer.from(String(payload.pdf_b64), 'base64'));
        tienePdf = true;
      }
      const registro = {
        id,
        fecha: String(payload.fecha),
        resumen: truncate(String(payload.resumen || ''), 400),
        tienePdf,
        createdAt: Date.now(),
      };
      reportes.push(registro);
      saveState();
      json(res, 200, { ok: true, reporte: registro });
    } catch (error) {
      json(res, 400, { error: 'Invalid body: ' + (error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && /^\/reportes\/\d+\.(html|pdf)$/.test(url.pathname)) {
    if (!isLoggedIn(req)) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    const match = url.pathname.match(/^\/reportes\/(\d+)\.(html|pdf)$/);
    const id = match[1];
    const ext = match[2];
    const filePath = path.join(reportesDir, id + '.' + ext);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Informe no encontrado');
      return;
    }
    const registro = reportes.find((r) => String(r.id) === String(id));
    const nombre = 'informe-' + (registro ? registro.fecha.replace(/[^\d]/g, '-') : id) + '.' + ext;
    res.writeHead(200, {
      'Content-Type': ext === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${nombre}"`,
      ...(ext === 'html' ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'" } : {}),
    });
    res.end(fs.readFileSync(filePath));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auditorias/marcar-enviado') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const item = auditorias.find((a) => a.id === Number(payload.id));
      if (!item) {
        json(res, 404, { error: 'no encontrado' });
        return;
      }
      item.emailEnviado = true;
      saveState();
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auditorias') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const limite = Math.min(Number(url.searchParams.get('limit')) || 200, 5000);
    json(res, 200, { auditorias: auditorias.slice(-limite).reverse() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auditorias') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req, 5 * 1024 * 1024);
      const payload = JSON.parse(body || '{}');
      if (!payload.empresa || !payload.html) {
        json(res, 400, { error: 'Missing required fields: empresa, html' });
        return;
      }
      fs.mkdirSync(auditoriasDir, { recursive: true });
      const id = nextAuditoriaId++;
      fs.writeFileSync(path.join(auditoriasDir, id + '.html'), String(payload.html));
      const registro = {
        id,
        empresa: String(payload.empresa),
        categoria: String(payload.categoria || ''),
        telefono: String(payload.telefono || ''),
        email: String(payload.email || ''),
        origen: String(payload.origen || 'scraper'),
        puntuacion: Number.isFinite(Number(payload.puntuacion)) ? Number(payload.puntuacion) : null,
        resumen: truncate(String(payload.resumen || ''), 400),
        emailEnviado: Boolean(payload.email_enviado),
        createdAt: Date.now(),
      };
      auditorias.push(registro);
      saveState();
      json(res, 200, { ok: true, auditoria: registro });
    } catch (error) {
      json(res, 400, { error: 'Invalid body: ' + (error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/clientes') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { clientes });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tickets') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { tickets: ticketsTecnicos });
    return;
  }

  if (req.method === 'POST' && /^\/api\/tickets\/\d+\/resolver$/.test(url.pathname)) {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.match(/^\/api\/tickets\/(\d+)\/resolver$/)[1]);
    const ticket = ticketsTecnicos.find((t) => t.id === id);
    if (!ticket) {
      json(res, 404, { error: 'Ticket no encontrado' });
      return;
    }
    ticket.estado = 'resuelto';
    ticket.resueltoAt = Date.now();
    saveState();
    json(res, 200, { ok: true, ticket });
    return;
  }

  if (req.method === 'GET' && /^\/auditorias\/\d+\.html$/.test(url.pathname)) {
    if (!isLoggedIn(req) && !isAuthorized(req) && !(heartbeatToken && req.headers['x-heartbeat-token'] === heartbeatToken)) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    const match = url.pathname.match(/^\/auditorias\/(\d+)\.html$/);
    const id = match[1];
    const filePath = path.join(auditoriasDir, id + '.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Auditoria no encontrada');
      return;
    }
    const registro = auditorias.find((a) => String(a.id) === String(id));
    const nombreArchivo = 'auditoria-' + (registro ? registro.empresa.replace(/[^a-zA-Z0-9]+/g, '-') : id) + '.html';
    const descargar = url.searchParams.get('descargar') === '1';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `${descargar ? 'attachment' : 'inline'}; filename="${nombreArchivo}"`,
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",
    });
    res.end(fs.readFileSync(filePath));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { conversaciones: publicConversaciones() });
    return;
  }

  if (req.method === 'GET' && /^\/api\/inbox\/\d+$/.test(url.pathname)) {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/').pop());
    const conv = conversaciones.find((c) => c.id === id);
    if (!conv) { json(res, 404, { error: 'No encontrada' }); return; }
    json(res, 200, { conversacion: conv });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/inbox/mensaje') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const conv = agregarMensajeInbox(payload);
      json(res, 200, { ok: true, conversacion: conv });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && /^\/api\/inbox\/\d+\/etiquetas$/.test(url.pathname)) {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const conv = conversaciones.find((c) => c.id === id);
    if (!conv) { json(res, 404, { error: 'No encontrada' }); return; }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (payload.accion === 'quitar') {
        conv.etiquetas = conv.etiquetas.filter((e) => e !== payload.etiqueta);
      } else if (payload.etiqueta) {
        const limpia = sanitizeSpanishText(String(payload.etiqueta)).slice(0, 40);
        if (!conv.etiquetas.includes(limpia)) conv.etiquetas.push(limpia);
      }
      saveState();
      json(res, 200, { ok: true, conversacion: conv });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && /^\/api\/inbox\/\d+\/auditoria$/.test(url.pathname)) {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const conv = conversaciones.find((c) => c.id === id);
    if (!conv) { json(res, 404, { error: 'No encontrada' }); return; }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const fechaCitaMs = Date.parse(String(payload.fechaHoraIso || ''));
      conv.auditoria = {
        nombre: sanitizeSpanishText(String(payload.nombre || '')).slice(0, 120),
        telefono: String(payload.telefono || '').slice(0, 40),
        email: String(payload.email || '').slice(0, 160),
        tipoServicio: sanitizeSpanishText(String(payload.tipoServicio || '')).slice(0, 200),
        fecha: Date.now(),
        fechaCitaIso: Number.isFinite(fechaCitaMs) ? new Date(fechaCitaMs).toISOString() : null,
      };
      if (!conv.etiquetas.includes('auditoria-solicitada')) conv.etiquetas.push('auditoria-solicitada');
      conv.updatedAt = Date.now();
      saveState();
      json(res, 200, { ok: true, conversacion: conv });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/calendario') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.fecha || !payload.marca || !Array.isArray(payload.formatos)) {
        json(res, 400, { error: 'faltan campos: fecha, marca, formatos[]' });
        return;
      }
      const formatosValidos = payload.formatos.filter((f) => ['reel', 'feed', 'story'].includes(f));
      const entrada = {
        id: nextCalendarioId++,
        fecha: String(payload.fecha).slice(0, 10),
        marca: String(payload.marca).slice(0, 60),
        formatos: formatosValidos,
        mejorHora: String(payload.mejorHora || '').slice(0, 100),
        resumen: sanitizeSpanishText(String(payload.resumen || '')).slice(0, 1000),
        createdAt: Date.now(),
      };
      const idx = calendario.findIndex((c) => c.fecha === entrada.fecha);
      if (idx >= 0) calendario[idx] = entrada; else calendario.unshift(entrada);
      if (calendario.length > 120) calendario.length = 120;
      saveState();
      json(res, 200, { ok: true, entrada });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/calendario') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { calendario });
    return;
  }

  if (req.method === 'GET' && /^\/api\/calendario\/[\w-]+$/.test(url.pathname)) {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const fechaParam = decodeURIComponent(url.pathname.split('/')[3]);
    const fecha = fechaParam === 'hoy'
      ? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
      : fechaParam;
    const entrada = calendario.find((c) => c.fecha === fecha) || null;
    json(res, 200, { fecha, entrada });
    return;
  }

  // Endpoint de solo lectura, con token de automatizacion, para que los
  // workflows de revision de copy (Copy Social Senior) puedan leer el
  // contenido real programado de hoy sin necesitar sesion de login.
  if (req.method === 'GET' && url.pathname === '/api/plan-semanal/redes-hoy') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const dia = DIAS_SEMANA[(new Date().getDay() + 6) % 7];
    const hoyStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const items = (planSemanalRedes[dia] || []).filter((it) => it.fechaDia === hoyStr);
    json(res, 200, { items });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/plan-semanal') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { planSemanalIA, planSemanalRedes, tareasManuales });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/redes') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      if (!DIAS_SEMANA.includes(dia) || !payload.marca) {
        json(res, 400, { error: 'faltan campos: dia valido, marca' });
        return;
      }
      const entrada = {
        id: nextPlanRedesId++,
        hora: String(payload.hora || '').slice(0, 5),
        marca: String(payload.marca).slice(0, 60),
        tipo: String(payload.tipo || '').slice(0, 30),
        cuenta: String(payload.cuenta || '').slice(0, 160),
        resumen: String(payload.resumen || '').slice(0, 500),
        fechaDia: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
        createdAt: Date.now(),
      };
      // Mismo bug que en /api/plan-semanal/ia (ver comentario alli):
      // se reemplaza la entrada previa de esa marca+tipo en ese dia de la
      // semana (de cualquier semana anterior) en vez de acumularla -- una
      // marca puede tener un reel y un flyer el mismo dia (tipos distintos),
      // asi que la clave de reemplazo es marca+tipo, no solo marca.
      planSemanalRedes[dia] = planSemanalRedes[dia].filter((it) => !(it.marca === entrada.marca && it.tipo === entrada.tipo));
      planSemanalRedes[dia].push(entrada);
      planSemanalRedes[dia].sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
      saveState();
      json(res, 200, { ok: true, entrada });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/redes/borrar') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      const id = Number(payload.id);
      if (!DIAS_SEMANA.includes(dia)) {
        json(res, 400, { error: 'dia invalido' });
        return;
      }
      planSemanalRedes[dia] = planSemanalRedes[dia].filter((it) => it.id !== id);
      saveState();
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  // Subida manual de imagen/video (avatar Gemini, foto propia, etc.) desde el
  // panel del CEO -- sube al mismo sitio real que ya usan los 4 generadores
  // (vmscontent/v1/imagen-directa en WordPress, URL publica real), y queda
  // guardado en mediaSubida[] para poder pedirle a la oficina que lo publique
  // despues sin tener que volver a subirlo.
  if (req.method === 'POST' && url.pathname === '/api/media-upload') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!VMSCONTENT_KEY) {
      json(res, 500, { error: 'VMSCONTENT_KEY no configurada en el .env -- no se puede subir a WordPress' });
      return;
    }
    try {
      const body = await readBody(req, 90 * 1024 * 1024);
      const payload = JSON.parse(body || '{}');
      if (!payload.media_b64) {
        json(res, 400, { error: 'falta media_b64' });
        return;
      }
      const mimeType = String(payload.mime_type || 'application/octet-stream').slice(0, 60);
      const nombre = 'manual-' + Date.now() + '-' + String(payload.nombre || 'archivo').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60);
      const wpRes = await fetch('https://virtualmarketingspain.com/wp-json/vmscontent/v1/imagen-directa', {
        method: 'POST',
        headers: { 'X-VMSCONTENT-KEY': VMSCONTENT_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: payload.media_b64, mime_type: mimeType, nombre_asset: nombre }),
      });
      const wpData = await wpRes.json().catch(() => ({}));
      if (!wpRes.ok || !wpData.url) {
        json(res, 502, { error: 'WordPress no devolvio una URL real', detalle: wpData });
        return;
      }
      const entrada = {
        id: nextMediaSubidaId++,
        url: wpData.url,
        mimeType,
        tipo: mimeType.startsWith('video/') ? 'video' : 'imagen',
        nombreOriginal: String(payload.nombre || '').slice(0, 200),
        publicado: false,
        createdAt: Date.now(),
      };
      mediaSubida.unshift(entrada);
      if (mediaSubida.length > 50) mediaSubida.pop();
      saveState();
      json(res, 200, { ok: true, entrada });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/media-subida') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { mediaSubida: mediaSubida.slice(0, 20) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/ia') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      if (!DIAS_SEMANA.includes(dia) || !payload.empresa) {
        json(res, 400, { error: 'faltan campos: dia valido, empresa' });
        return;
      }
      const entrada = {
        id: nextPlanIaId++,
        hora: String(payload.hora || '').slice(0, 5),
        empresa: String(payload.empresa).slice(0, 120),
        tareas: String(payload.tareas || '').slice(0, 2000),
        createdAt: Date.now(),
      };
      // Bug real corregido (2026-09-16): este endpoint solo empujaba,
      // nunca reemplazaba -- el generador semanal (GMBContenidoSemanal001)
      // lo llama una vez por semana para cada dia+empresa, y como el array
      // esta indexado por NOMBRE de dia de la semana (se repite cada
      // semana), cada ejecucion se sumaba a las anteriores en vez de
      // sustituirlas. Ahora se quita cualquier entrada previa de esa
      // empresa en ese dia de la semana antes de anadir la nueva.
      planSemanalIA[dia] = planSemanalIA[dia].filter((it) => it.empresa !== entrada.empresa);
      planSemanalIA[dia].push(entrada);
      planSemanalIA[dia].sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
      saveState();
      json(res, 200, { ok: true, entrada });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/ia/borrar') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      const id = Number(payload.id);
      if (!DIAS_SEMANA.includes(dia)) {
        json(res, 400, { error: 'dia invalido' });
        return;
      }
      planSemanalIA[dia] = planSemanalIA[dia].filter((it) => it.id !== id);
      saveState();
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/manual') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      if (!DIAS_SEMANA.includes(dia) || !payload.texto) {
        json(res, 400, { error: 'faltan campos: dia valido, texto' });
        return;
      }
      const entrada = {
        id: nextTareaManualId++,
        hora: String(payload.hora || '').slice(0, 5),
        texto: String(payload.texto).slice(0, 300),
        hecho: false,
        createdAt: Date.now(),
      };
      tareasManuales[dia].push(entrada);
      tareasManuales[dia].sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
      saveState();
      json(res, 200, { ok: true, entrada });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/manual/toggle') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      const id = Number(payload.id);
      if (!DIAS_SEMANA.includes(dia)) {
        json(res, 400, { error: 'dia invalido' });
        return;
      }
      const item = tareasManuales[dia].find((it) => it.id === id);
      if (!item) {
        json(res, 404, { error: 'no encontrado' });
        return;
      }
      item.hecho = !item.hecho;
      saveState();
      json(res, 200, { ok: true, item });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan-semanal/manual/borrar') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dia = String(payload.dia || '');
      const id = Number(payload.id);
      if (!DIAS_SEMANA.includes(dia)) {
        json(res, 400, { error: 'dia invalido' });
        return;
      }
      tareasManuales[dia] = tareasManuales[dia].filter((it) => it.id !== id);
      saveState();
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/servicios-precios') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { serviciosPrecios });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/servicios-precios') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.categoria || !payload.servicio) {
        json(res, 400, { error: 'faltan campos: categoria, servicio' });
        return;
      }
      const entrada = {
        id: nextServicioId++,
        categoria: String(payload.categoria).slice(0, 60),
        servicio: String(payload.servicio).slice(0, 150),
        precio: String(payload.precio || '').slice(0, 60),
        createdAt: Date.now(),
      };
      serviciosPrecios.push(entrada);
      saveState();
      json(res, 200, { ok: true, entrada });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/servicios-precios/editar') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const item = serviciosPrecios.find((s) => s.id === Number(payload.id));
      if (!item) {
        json(res, 404, { error: 'no encontrado' });
        return;
      }
      if (payload.precio !== undefined) item.precio = String(payload.precio).slice(0, 60);
      if (payload.servicio !== undefined) item.servicio = String(payload.servicio).slice(0, 150);
      if (payload.categoria !== undefined) item.categoria = String(payload.categoria).slice(0, 60);
      saveState();
      json(res, 200, { ok: true, item });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/servicios-precios/borrar') {
    if (!isLoggedIn(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const id = Number(payload.id);
      const idx = serviciosPrecios.findIndex((s) => s.id === id);
      if (idx >= 0) serviciosPrecios.splice(idx, 1);
      saveState();
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/flyers') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.marca || !payload.imagenUrl || !payload.caption) {
        json(res, 400, { error: 'faltan campos: marca, imagenUrl, caption' });
        return;
      }
      const flyer = {
        id: nextFlyerId++,
        marca: String(payload.marca).slice(0, 60),
        formato: payload.formato === 'story' ? 'story' : 'post',
        imagenUrl: String(payload.imagenUrl).slice(0, 500),
        caption: sanitizeSpanishText(String(payload.caption)).slice(0, 2200),
        estado: 'pendiente',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      flyers.unshift(flyer);
      if (flyers.length > 300) flyers.length = 300;
      saveState();
      json(res, 200, { ok: true, flyer });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/flyers') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { flyers });
    return;
  }

  if (req.method === 'POST' && /^\/api\/flyers\/\d+\/aprobar$/.test(url.pathname)) {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const flyer = flyers.find((f) => f.id === id);
    if (!flyer) { json(res, 404, { error: 'No encontrado' }); return; }
    if (flyer.estado !== 'pendiente') { json(res, 409, { error: 'Ya procesado' }); return; }
    try {
      await publicarFlyerInstagram(flyer);
      flyer.estado = 'publicado';
      flyer.updatedAt = Date.now();
      saveState();
      json(res, 200, { ok: true, flyer });
    } catch (error) {
      json(res, 502, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && /^\/api\/flyers\/\d+\/descartar$/.test(url.pathname)) {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const flyer = flyers.find((f) => f.id === id);
    if (!flyer) { json(res, 404, { error: 'No encontrado' }); return; }
    try {
      flyer.estado = 'descartado';
      flyer.updatedAt = Date.now();
      saveState();
      json(res, 200, { ok: true, flyer });
    } catch (error) {
      json(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  // Mientras no haya API real de Google Business conectada, esto es el panel
  // manual: n8n genera el texto real (GMBResumenDiario001) y lo guarda aqui;
  // el CEO copia el texto y lo pega el mismo en la ficha de Google, y marca
  // publicado -- asi al menos queda visible en la oficina, no solo en un email.
  if (req.method === 'POST' && url.pathname === '/api/gmb-posts') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.negocio || !payload.texto) {
        json(res, 400, { error: 'faltan campos: negocio, texto' });
        return;
      }
      const fecha = payload.fecha || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      // Si ya existe un post pendiente de este negocio para hoy, se reemplaza
      // en vez de duplicar (por si el resumen diario se relanza a mano).
      const existente = gmbPosts.find((p) => p.negocio === payload.negocio && p.fecha === fecha && p.estado === 'pendiente');
      const post = existente || { id: nextGmbPostId++, negocio: String(payload.negocio).slice(0, 120), fecha, createdAt: Date.now() };
      post.titulo = String(payload.titulo || '').slice(0, 120);
      post.texto = sanitizeSpanishText(String(payload.texto)).slice(0, 1600);
      post.ctaBoton = String(payload.ctaBoton || '').slice(0, 40);
      post.ideaFoto = String(payload.ideaFoto || '').slice(0, 300);
      post.estado = post.estado || 'pendiente';
      post.updatedAt = Date.now();
      if (!existente) {
        gmbPosts.unshift(post);
        if (gmbPosts.length > 300) gmbPosts.length = 300;
      }
      saveState();
      upsertPlanSemanalIA(post.negocio, `${post.titulo}\n\n${post.texto}\n📷 ${post.ideaFoto}`);
      json(res, 200, { ok: true, post });
    } catch (error) {
      json(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/gmb-posts') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { gmbPosts });
    return;
  }

  if (req.method === 'POST' && /^\/api\/gmb-posts\/\d+\/publicado$/.test(url.pathname)) {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const post = gmbPosts.find((p) => p.id === id);
    if (!post) { json(res, 404, { error: 'No encontrado' }); return; }
    post.estado = 'publicado';
    post.updatedAt = Date.now();
    saveState();
    json(res, 200, { ok: true, post });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/cliente-posts') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { clientePosts });
    return;
  }

  if (req.method === 'POST' && /^\/api\/cliente-posts\/\d+\/publicado$/.test(url.pathname)) {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const post = clientePosts.find((p) => p.id === id);
    if (!post) { json(res, 404, { error: 'No encontrado' }); return; }
    post.estado = 'publicado';
    post.updatedAt = Date.now();
    saveState();
    json(res, 200, { ok: true, post });
    return;
  }

  if (req.method === 'POST' && /^\/api\/inbox\/\d+\/respuesta$/.test(url.pathname)) {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const conv = conversaciones.find((c) => c.id === id);
    if (!conv) { json(res, 404, { error: 'No encontrada' }); return; }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (payload.accion === 'descartar') {
        conv.sugerenciaIA = null;
        saveState();
        json(res, 200, { ok: true, conversacion: conv });
        return;
      }
      const texto = String(payload.texto || conv.sugerenciaIA || '').trim();
      if (!texto) { json(res, 400, { error: 'Sin texto que enviar' }); return; }
      await enviarRespuestaInbox(conv, texto);
      conv.mensajes.push({ id: nextMensajeId++, autor: 'sistema', texto, timestamp: Date.now() });
      conv.sugerenciaIA = null;
      conv.updatedAt = Date.now();
      saveState();
      json(res, 200, { ok: true, conversacion: conv });
    } catch (error) {
      json(res, 502, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agents') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { agents: publicAgents() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!isLoggedInOrAutomation(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { events, lastEventId: events.at(-1)?.id || 0 });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/instructions') {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { instructions: publicInstructions() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.agent) {
        json(res, 400, { error: 'Missing required field: agent' });
        return;
      }
      const agent = heartbeat(payload);
      pushEvent(payload.agent, {
        type: 'status',
        state: agent.state,
        task: truncate(agent.task || ''),
      });
      const source = payload.metadata && payload.metadata.source;
      if (source && AUTOMATION_COMPLETION_SOURCES.has(source) && payload.task) {
        buildCompletedAutomationExecution(agent, payload.task);
      }
      json(res, 200, { ok: true, agent: { ...agent, lastSeen: undefined } });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  // Endpoint dedicado para que automatizaciones reales (ej. el vigilante de
  // errores de n8n, RevisarErroresN8N001) creen un ticket tecnico real
  // directamente, sin pasar por el chat del CEO ni depender de que la IA
  // clasifique el mensaje -- asi un error real de cualquier flujo llega
  // siempre al equipo tecnico (Claude Code) de forma automatica, no solo
  // por email. Mismo token que el heartbeat, ya usado por estas mismas
  // automatizaciones.
  if (req.method === 'POST' && url.pathname === '/api/tickets/crear') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.mensaje) {
        json(res, 400, { error: 'Missing required field: mensaje' });
        return;
      }
      const ticket = await crearTicketTecnico(payload.mensaje, payload.origen || 'automatizacion');
      json(res, 200, { ok: true, ticket });
    } catch (err) {
      json(res, 400, { error: 'Invalid JSON body: ' + String(err && err.message || err) });
    }
    return;
  }

  // Endpoints gemelos a /api/tickets/crear (mismo token de heartbeat) para que
  // la rutina automatica de reparacion (cloud, sin sesion de login) pueda leer
  // los tickets pendientes y marcarlos resueltos sin depender de isLoggedIn.
  if (req.method === 'GET' && url.pathname === '/api/tickets/pendientes') {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const pendientes = ticketsTecnicos.filter((t) => t.estado !== 'resuelto');
    json(res, 200, { tickets: pendientes });
    return;
  }

  if (req.method === 'POST' && /^\/api\/tickets\/\d+\/resolver-auto$/.test(url.pathname)) {
    if (!isHeartbeatAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const id = Number(url.pathname.match(/^\/api\/tickets\/(\d+)\/resolver-auto$/)[1]);
    const ticket = ticketsTecnicos.find((t) => t.id === id);
    if (!ticket) {
      json(res, 404, { error: 'Ticket no encontrado' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      ticket.estado = 'resuelto';
      ticket.resueltoAt = Date.now();
      if (payload.notaResolucion) ticket.notaResolucion = String(payload.notaResolucion).slice(0, 4000);
      saveState();
      json(res, 200, { ok: true, ticket });
    } catch (err) {
      json(res, 400, { error: 'Invalid JSON body: ' + String(err && err.message || err) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/remove') {
    if (!isAuthorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (payload.agent) {
        agents.delete(payload.agent);
        pushEvent(payload.agent, { type: 'remove' });
        saveState();
        broadcastAgents();
      }
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/instructions') {
    try {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.message) {
        json(res, 400, { error: 'Missing required field: message' });
        return;
      }
      const result = await pushInstruction(payload);
      broadcastAgents();
      json(res, 200, { ok: true, instruction: result.instruction, socialExecution: result.socialExecution, workExecutions: result.workExecutions, automatizacionReal: result.automatizacionReal, respuestaInmediata: result.respuestaInmediata });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ceo-chat') {
    try {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.message) {
        json(res, 400, { error: 'Missing required field: message' });
        return;
      }
      // El chat primero comprueba si el mensaje coincide con una automatizacion
      // real ya conectada (mismo catalogo/motor que la Consola del CEO) -- si
      // coincide, se ejecuta de verdad. Ademas, si el mensaje va dirigido a un
      // trabajador o equipo concreto (por nombre/id o palabra clave de
      // departamento), se responde en su nombre de forma honesta (pushInstruction
      // -> responderComoTrabajador) en vez de una respuesta generica de oficina.
      // Solo si no hay automatizacion Y el mensaje es generico (toda la oficina)
      // cae al chat conversacional normal de soporte.
      let intentosDetectados = [];
      try {
        intentosDetectados = await clasificarAutomatizacionesConIA(payload.message);
      } catch {
        intentosDetectados = REGLAS_AUTOMATIZACION_REAL.filter((r) => r.re.test(payload.message)).map((r) => r.intento);
      }
      const destinatario = detectarDestinatarioChat(payload.message);
      if (intentosDetectados.length || destinatario.scope !== 'global') {
        const resultado = await pushInstruction({ scope: destinatario.scope, target: destinatario.target, message: payload.message, author: 'CEO (chat)' });
        json(res, 200, { ok: true, respuesta: resultado.respuestaInmediata });
        return;
      }
      const respuesta = await responderChatCEO(payload.message, payload.historial);
      json(res, 200, { ok: true, respuesta });
    } catch (err) {
      json(res, 500, { error: 'No se pudo generar respuesta', detalle: String(err && err.message || err) });
    }
    return;
  }

  if (req.method === 'POST' && /^\/api\/social-executions\/\d+$/.test(url.pathname)) {
    try {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const executionId = Number(url.pathname.split('/').pop());
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      let execution = null;
      if (payload.action === 'start') execution = startSocialExecution(executionId);
      if (payload.action === 'complete_step') execution = completeSocialExecutionStep(executionId, payload.stepKey);
      if (!execution) {
        json(res, 404, { error: 'Social execution not found or invalid action' });
        return;
      }
      broadcastAgents();
      json(res, 200, { ok: true, socialExecution: execution });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  if (req.method === 'POST' && /^\/api\/work-executions\/\d+$/.test(url.pathname)) {
    try {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const executionId = Number(url.pathname.split('/').pop());
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const execution = updateWorkExecution(executionId, payload.action, payload.stepKey);
      if (!execution) {
        json(res, 404, { error: 'Work execution not found or invalid action' });
        return;
      }
      broadcastAgents();
      json(res, 200, { ok: true, workExecution: execution });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/business-metrics') {
    try {
      if (!isAuthorized(req) && !isHeartbeatAuthorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const metrics = setBusinessMetrics(payload);
      broadcastAgents();
      json(res, 200, { ok: true, businessMetrics: metrics });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
 } catch (error) {
  console.error('[http:unhandled]', { message: String(error && error.message || error), path: req.url, at: new Date().toISOString() });
  if (!res.headersSent) {
    json(res, 500, { error: 'Error interno' });
  } else if (!res.writableEnded) {
    res.end();
  }
 }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  if (!isLoggedIn(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'agents', agents: publicAgents() }));
  ws.on('close', () => clients.delete(ws));
});

loadState();
loadSessions();
loadAdminFromFile();
setInterval(sweepAgents, 5000);

server.listen(port, () => {
  console.log(`Miniverse Office listo en http://localhost:${port}`);
});
