import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 4321);
const offlineTimeout = Number(process.env.OFFLINE_TIMEOUT_MS || 30000);
const ceoPanelToken = String(process.env.CEO_PANEL_TOKEN || '');
const dataFile = String(process.env.DATA_FILE || '/app/data/state.json');
// URL publica de esta oficina, solo para el widget opcional de WordPress
// (renderWordpressEmbedJs) — sin configurar, ese widget no funciona pero el
// resto de la oficina va igual. Nunca hardcodear un dominio real aqui.
const publicOfficeUrl = String(process.env.PUBLIC_OFFICE_URL || '').replace(/\/$/, '');

const agents = new Map();
const events = [];
const instructions = [];
const socialExecutions = [];
const workExecutions = [];
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
let nextEventId = 1;
let nextInstructionId = 1;
let nextSocialExecutionId = 1;
let nextWorkExecutionId = 1;

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

function loadState() {
  try {
    ensureDataDir();
    if (!fs.existsSync(dataFile)) return;
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw || '{}');
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
    console.error('No se pudo cargar el estado:', error.message || error);
  }
}

function saveState() {
  try {
    ensureDataDir();
    fs.writeFileSync(dataFile, JSON.stringify({
      agents: publicAgents(),
      instructions,
      socialExecutions,
      workExecutions,
      businessMetrics,
    }, null, 2), 'utf8');
  } catch (error) {
    console.error('No se pudo guardar el estado:', error.message || error);
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
    state: payload.state || existing.state || 'idle',
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
  const departments = ['community', 'comerciales', 'seo', 'web', 'automatizacion', 'operaciones'];
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
  return {
    ...businessMetrics,
    ...automatic,
    notes: automatic.notes || businessMetrics.notes || '',
    updatedAt: automatic.updatedAt || businessMetrics.updatedAt || null,
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
  if (payload.n8n_status !== undefined) businessMetrics.n8n_status = String(payload.n8n_status || 'ok');
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

function pushInstruction(payload) {
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
  const socialExecution = maybeCreateSocialExecution(entry);
  const workExecutions = maybeCreateWorkExecutions(entry);
  return { instruction: entry, socialExecution: socialExecution || null, workExecutions: workExecutions || [] };
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
  if (/(director|ceo|gerencia|admin)/.test(text)) return 'direccion';
  if (/(community|social|redes|instagram|tiktok|youtube|content)/.test(text)) return 'community';
  if (/(comercial|ventas|sales|closer|lead)/.test(text)) return 'comerciales';
  if (/(seo|geo|aeo|sem|posicionamiento)/.test(text)) return 'seo';
  if (/(web|developer|dev|frontend|backend|wordpress|diseño|design)/.test(text)) return 'web';
  if (/(automat|n8n|bot|chatbot|ia|ai|workflow)/.test(text)) return 'automatizacion';
  return 'operaciones';
}

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
.command-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}
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
.instruction-list{display:grid;gap:10px}
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
.picker-layout{display:grid;grid-template-columns:.95fr 1.05fr;gap:12px}
.target-panel{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.target-panel h5{margin:0 0 10px;font-size:13px;color:#d9d9e2}
.target-select{width:100%;border:1px solid rgba(255,255,255,.08);background:rgba(10,10,14,.88);color:#f4f4f7;border-radius:14px;padding:12px 14px;font:inherit}
.target-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-height:270px;overflow:auto;padding-right:4px}
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
</style>
</head>
<body>
<div class="shell">
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
      <div class="button-row" style="margin-top:14px">
        <a class="btn-gold" href="/operations" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">Abrir operaciones</a>
        <a class="btn-gold" href="/manual" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">Manual operativo</a>
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
        <textarea id="message" placeholder="Ej: prepara 3 ideas para Google Business de Terapia de Masajes y prioriza una publicación esta semana"></textarea>
      </div>
      <div class="button-row">
        <button class="btn-gold" id="send-command">Enviar instrucción</button>
        <button class="btn-dark" id="fill-global">Prioridad global</button>
        <button class="btn-dark" id="fill-social">Orden a redes</button>
      </div>
      <div class="command-status" id="command-status">Listo para enviar órdenes.</div>
      <div id="command-reply"></div>
    </div>
    <div class="panel command-card">
      <h3>Últimas instrucciones</h3>
      <div class="instruction-list" id="instruction-list"></div>
    </div>
  </section>
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
  <div class="office-toolbar">
    <div class="office-toolbar-left" id="office-filter"></div>
    <div class="hint">Pulsa un grupo para ver solo ese equipo y hablar más rápido con quien toque.</div>
  </div>
  <section class="office" id="office"></section>
  <div class="footer-note">Usa nombres como director_general, cm_vms, ventas_01, seo_lead o web_dev para que la oficina organice mejor a cada agente.</div>
</div>
<script>
const ZONES=[
  {key:'direccion',title:'Dirección',tag:'CEO / Control'},
  {key:'community',title:'Community & Redes',tag:'Contenido'},
  {key:'comerciales',title:'Comerciales',tag:'Ventas'},
  {key:'seo',title:'SEO / GEO / AEO',tag:'Tráfico'},
  {key:'web',title:'Páginas Web',tag:'Conversión'},
  {key:'automatizacion',title:'IA & Automatización',tag:'Escala'},
  {key:'operaciones',title:'Operaciones',tag:'Soporte'}
];
function inferDepartment(agent){
  const text=(String(agent.agent||'')+' '+String(agent.name||'')).toLowerCase();
  if (/(director|ceo|gerencia|admin)/.test(text)) return 'direccion';
  if (/(community|social|redes|instagram|tiktok|youtube|content)/.test(text)) return 'community';
  if (/(comercial|ventas|sales|closer|lead)/.test(text)) return 'comerciales';
  if (/(seo|geo|aeo|sem|posicionamiento)/.test(text)) return 'seo';
  if (/(web|developer|dev|frontend|backend|wordpress|diseño|design)/.test(text)) return 'web';
  if (/(automat|n8n|bot|chatbot|ia|ai|workflow)/.test(text)) return 'automatizacion';
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
  return '<div class="event-line"><strong>'+String(item.agentId||'agente')+' · '+type+(state?' · '+state:'')+'</strong><span>'+task+'</span></div>';
}
function instructionRow(item){
  return '<div class="instruction-line"><strong>'+String(item.author||'CEO')+' → '+String(item.target||'all')+' · '+String(item.scope||'global')+'</strong><span>'+String(item.message||'Sin mensaje')+'</span></div>';
}
function socialExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+String(step.label||step.key||'Paso')+'</span><b class="'+String(step.status||'pendiente')+'">'+String(step.status||'pendiente').replaceAll('_',' ')+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+String(worker.status||'pendiente')+'">'+String(worker.name||worker.agent||'worker')+' · '+String(worker.status||'pendiente').replaceAll('_',' ')+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+String(item.id||'0')+' · '+String(item.title||'Sin título')+'</div><div class="social-exec-meta">Por '+String(item.author||'CEO')+' · Actualizado: '+updated+'</div></div><span class="social-badge '+badgeClass+'">'+badgeClass.replaceAll('_',' ')+'</span></div><div class="social-exec-meta">'+String(item.brief||'Sin brief')+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
function workExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+String(step.label||step.key||'Paso')+'</span><b class="'+String(step.status||'pendiente')+'">'+String(step.status||'pendiente').replaceAll('_',' ')+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+String(worker.status||'pendiente')+'">'+String(worker.name||worker.agent||'worker')+' · '+String(worker.status||'pendiente').replaceAll('_',' ')+'</span>').join('');
  const resources=(item.resources||[]).map(resource=>'<span class="resource-chip">'+String(resource)+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+String(item.id||'0')+' · '+String(item.title||'Sin título')+'</div><div class="social-exec-meta">Grupo: '+String(item.department||'general')+' · Por '+String(item.author||'CEO')+' · Actualizado: '+updated+'</div></div><span class="social-badge '+badgeClass+'">'+badgeClass.replaceAll('_',' ')+'</span></div><div class="social-exec-meta">'+String(item.brief||'Sin brief')+'</div><div class="resource-list">'+resources+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
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
  document.getElementById('stat-online').textContent=String(agents.filter(a=>a.state!=='offline').length);
  document.getElementById('stat-total').textContent=String(agents.length);
  document.getElementById('stat-working').textContent=String(agents.filter(a=>a.state==='working').length);
  buildOfficeFilters(grouped);
  const visibleZones=(OFFICE_ACTIVE_FILTER==='all')?ZONES:ZONES.filter(zone=>zone.key===OFFICE_ACTIVE_FILTER);
  office.innerHTML=visibleZones.map(zone=>{
    const items=grouped[zone.key]||[];
    const isOpen=(OFFICE_ACTIVE_FILTER==='all') ? items.some(agent=>agent.state==='working') : true;
    return '<section class="panel zone"><details class="zone-details" '+(isOpen?'open':'')+'><summary class="zone-summary"><div class="zone-summary-main"><span class="pill">'+zone.tag+'</span><div><h4>'+zone.title+'</h4><div class="zone-count">'+zoneCountLabel(items)+'</div></div></div><span class="zone-count">'+(isOpen?'Ocultar':'Ver')+'</span></summary><div class="zone-body"><div class="desks">'+
      (items.length?items.map(agent=>{
        const agentName=agent.name||agent.agent||'Agente';
        const task=agent.task?String(agent.task):'Sin tarea visible en este momento.';
        const state=agent.state||'idle';
        return '<article class="desk" data-agent-card="'+String(agent.agent||'')+'"><div class="desk-top"><div class="avatar">'+initials(agentName)+'</div><div><div class="desk-name">'+agentName+'</div><div class="desk-role">'+inferDepartment(agent)+'</div></div></div><div class="desk-status"><span class="dot '+state+'"></span>'+stateLabel(state)+' · '+timeAgo(agent.lastSeen)+'</div><div class="task">'+task+'</div></article>';
      }).join(''):'<div class="desk-empty">Zona preparada para nuevos agentes</div>')+'</div></div></details></section>';
  }).join('');
}
function renderTargetPicker(agents){
  const scope=document.getElementById('scope').value||'global';
  const groupSelect=document.getElementById('target-group');
  const grid=document.getElementById('target-grid');
  const target=document.getElementById('target');
  const helper=document.getElementById('target-helper');
  if(!groupSelect||!grid||!target||!helper) return;
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
      return '<button class="target-card active" data-team-card="'+selectedGroup+'"><div class="target-card-head"><div class="avatar">'+initials(agentName)+'</div><div><div class="target-card-name">'+agentName+'</div><div class="target-card-sub">'+inferDepartment(agent)+'</div></div></div><div class="target-card-task">'+String(agent.task||'Sin tarea visible').slice(0,120)+'</div></button>';
    }).join('') : '<div class="desk-empty">Sin trabajadores visibles en este equipo.</div>';
    return;
  }
  if(!target.value || !workers.some(agent=>String(agent.agent)===String(target.value))){
    target.value=workers[0].agent || '';
  }
  helper.textContent=target.value ? ('Trabajador elegido: '+target.value) : 'Elige un trabajador para enviar una orden directa.';
  grid.innerHTML=workers.length ? workers.map(agent=>{
    const agentName=agent.name||agent.agent||'Agente';
    const active=String(target.value)===String(agent.agent);
    return '<button class="target-card '+(active?'active':'')+'" data-worker-card="'+String(agent.agent)+'"><div class="target-card-head"><div class="avatar">'+initials(agentName)+'</div><div><div class="target-card-name">'+agentName+'</div><div class="target-card-sub">'+String(agent.agent)+'</div></div></div><div class="target-card-task">'+String(agent.task||'Sin tarea visible').slice(0,120)+'</div></button>';
  }).join('') : '<div class="desk-empty">No hay trabajadores activos en este grupo todavia.</div>';
  grid.querySelectorAll('[data-worker-card]').forEach(btn=>btn.onclick=()=>{target.value=btn.getAttribute('data-worker-card')||'';helper.textContent='Trabajador elegido: '+target.value;renderTargetPicker(agents);});
}
function renderReplyCard(execution,kind){
  const workers=execution.assigned||[];
  const lead=workers[0];
  const leadName=lead?(lead.name||lead.agent):(execution.department||'Equipo');
  const stepsHtml=(execution.steps||[]).map(step=>'<div class="reply-step"><span>'+String(step.label||step.key||'Paso')+'</span><b class="'+String(step.status||'pendiente')+'">'+String(step.status||'pendiente').replaceAll('_',' ')+'</b></div>').join('');
  const otros=workers.slice(1).map(w=>w.name||w.agent).join(', ');
  return '<div class="reply-card"><div class="reply-card-head"><div class="reply-card-avatar">'+initials(leadName)+'</div><div><div class="reply-card-name">'+leadName+' ha recibido la orden</div><div class="reply-card-sub">'+(execution.department?('Equipo: '+execution.department+(otros?' · con apoyo de '+otros:''))+' · '+kind:kind)+'</div></div></div>'+stepsBadge(execution.steps)+'<div class="reply-steps">'+stepsHtml+'</div></div>';
}
function renderCommandReply(data){
  const box=document.getElementById('command-reply');
  if(!box) return;
  const executions=[];
  if(data.socialExecution) executions.push({exec:data.socialExecution,kind:'Ejecución de redes'});
  (data.workExecutions||[]).forEach(exec=>executions.push({exec,kind:'Ejecución de equipo'}));
  if(!executions.length){
    box.innerHTML='<div class="reply-card"><div class="reply-card-sub">Instrucción guardada, pero no coincide con ningún equipo con ejecución activa todavía.</div></div>';
    return;
  }
  box.innerHTML=executions.map(({exec,kind})=>renderReplyCard(exec,kind)).join('');
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
    const list=(data.instructions||[]);
    box.innerHTML=list.length?list.slice(0,6).map(instructionRow).join(''):'<div class="instruction-line"><span>Sin instrucciones recientes.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>Token no válido o sin acceso.</span></div>';
  }
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
    const response=await fetch('/api/social-executions',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.socialExecutions||[]);
    box.innerHTML=list.length?list.slice(0,6).map(socialExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones reales de redes todavia.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones de redes.</span></div>';
  }
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
    const response=await fetch('/api/work-executions',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.workExecutions||[]);
    box.innerHTML=list.length?list.slice(0,8).map(workExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones generales todavia.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones generales.</span></div>';
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
  if(groupSelect) groupSelect.onchange=()=>renderTargetPicker(OFFICE_AGENTS_CACHE);
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
async function refreshOffice(){
  try{
    const response=await fetch('/api/metrics');
    const data=await response.json();
    const agents=(data.agents||[]);
    renderOffice(agents);
    renderTargetPicker(agents);
    renderMetrics(agents,data);
  }catch{
    renderOffice([]);
    renderTargetPicker([]);
    renderMetrics([],null);
  }
}
refreshOffice();
bindCommandPanel();
refreshInstructions();
refreshSocialExecutions();
refreshWorkExecutions();
setInterval(refreshOffice,5000);
setInterval(refreshInstructions,10000);
setInterval(refreshSocialExecutions,10000);
setInterval(refreshWorkExecutions,10000);
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
</style>
</head>
<body>
<div class="shell">
  <section class="hero">
    <div class="panel">
      <div class="eyebrow">Operations HQ</div>
      <h1>Operaciones y motor real</h1>
      <p>Aquí vive el taller: ejecuciones sociales, motor general, pasos, responsables y acciones rápidas. La oficina principal se queda limpia y ejecutiva.</p>
      <div class="button-row" style="margin-top:14px">
        <a class="btn-gold" href="/office">Volver a oficina</a>
        <a class="btn-gold" href="/manual">Manual operativo</a>
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
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+String(step.label||step.key||'Paso')+'</span><b class="'+String(step.status||'pendiente')+'">'+String(step.status||'pendiente').replaceAll('_',' ')+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+String(worker.status||'pendiente')+'">'+String(worker.name||worker.agent||'worker')+' · '+String(worker.status||'pendiente').replaceAll('_',' ')+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+String(item.id||'0')+' · '+String(item.title||'Sin título')+'</div><div class="social-exec-meta">Por '+String(item.author||'CEO')+' · Actualizado: '+updated+'</div></div><span class="social-badge '+badgeClass+'">'+badgeClass.replaceAll('_',' ')+'</span></div><div class="social-exec-meta">'+String(item.brief||'Sin brief')+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
function workExecutionRow(item){
  const badgeClass=String(item.status||'pendiente');
  const updated=item?.updatedAt?new Date(item.updatedAt).toLocaleString('es-ES'):'sin fecha';
  const steps=(item.steps||[]).map(step=>'<div class="social-step"><span>'+String(step.label||step.key||'Paso')+'</span><b class="'+String(step.status||'pendiente')+'">'+String(step.status||'pendiente').replaceAll('_',' ')+'</b></div>').join('');
  const assigned=(item.assigned||[]).map(worker=>'<span class="social-worker '+String(worker.status||'pendiente')+'">'+String(worker.name||worker.agent||'worker')+' · '+String(worker.status||'pendiente').replaceAll('_',' ')+'</span>').join('');
  const resources=(item.resources||[]).map(resource=>'<span class="resource-chip">'+String(resource)+'</span>').join('');
  return '<article class="social-exec"><div class="social-exec-top"><div><div class="social-exec-title">#'+String(item.id||'0')+' · '+String(item.title||'Sin título')+'</div><div class="social-exec-meta">Grupo: '+String(item.department||'general')+' · Por '+String(item.author||'CEO')+' · Actualizado: '+updated+'</div></div><span class="social-badge '+badgeClass+'">'+badgeClass.replaceAll('_',' ')+'</span></div><div class="social-exec-meta">'+String(item.brief||'Sin brief')+'</div><div class="resource-list">'+resources+'</div>'+stepsBadge(item.steps)+'<div class="social-steps">'+steps+'</div><div class="social-assigned">'+assigned+'</div></article>';
}
async function refreshSocialExecutions(){
  const box=document.getElementById('social-exec-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){ box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver la ejecución operativa.</span></div>'; return; }
  try{
    const response=await fetch('/api/social-executions',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.socialExecutions||[]);
    box.innerHTML=list.length?list.slice(0,12).map(socialExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones reales de redes todavia.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones de redes.</span></div>';
  }
}
async function refreshWorkExecutions(){
  const box=document.getElementById('work-exec-list');
  if(!box) return;
  const token=(localStorage.getItem('ceo-panel-token')||'').trim();
  if(!token){ box.innerHTML='<div class="instruction-line"><span>Guarda el token del CEO para ver las ejecuciones generales.</span></div>'; return; }
  try{
    const response=await fetch('/api/work-executions',{headers:{'x-ceo-token':token}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'No autorizado');
    const list=(data.workExecutions||[]);
    box.innerHTML=list.length?list.slice(0,16).map(workExecutionRow).join(''):'<div class="instruction-line"><span>Sin ejecuciones generales todavia.</span></div>';
  }catch{
    box.innerHTML='<div class="instruction-line"><span>No se pudieron cargar las ejecuciones generales.</span></div>';
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
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
</style>
</head>
<body>
<div class="shell">
  <div class="panel">
    <div class="eyebrow">Manual operativo maestro</div>
    <h1>Misión, ritmo y KPI de los 142 trabajadores</h1>
    <p>Regla madre — vale para todos, siempre:</p>
    <ul class="regla-madre">${reglaMadreHtml}</ul>
    <div class="button-row" style="margin-top:14px">
      <a class="btn-gold" href="/office">Volver a oficina</a>
      <a class="btn-gold" href="/operations">Ir a operaciones</a>
    </div>
  </div>
  <div class="panel">
    <h2>Ritmo diario obligatorio</h2>
    <div class="ritmo-row">${ritmoDiarioHtml}</div>
    <h2 style="margin-top:20px">Ritmo semanal obligatorio</h2>
    <div class="ritmo-row">${ritmoSemanalHtml}</div>
  </div>
  ${seccionesHtml}
</div>
<script>
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
      const metrics = metricsData && metricsData.metrics  metricsData.metrics : {};
      const biz = businessData && businessData.businessMetrics  businessData.businessMetrics : {};
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


function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  if (!ceoPanelToken) return false;
  return req.headers['x-ceo-token'] === ceoPanelToken;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderStatusHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/office') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderOfficeHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/operations') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderOperationsHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/manual') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderManualHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/embed/wordpress-office.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(renderWordpressEmbedJs());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
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
    const list = publicAgents();
    json(res, 200, { agents: list, metrics: computeMetrics(list), businessMetrics: publicBusinessMetrics() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/business-metrics') {
    json(res, 200, { businessMetrics: publicBusinessMetrics() });
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

  if (req.method === 'GET' && url.pathname === '/api/agents') {
    json(res, 200, { agents: publicAgents() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
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

  if (req.method === 'POST' && url.pathname === '/api/agents/remove') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (payload.agent) {
        agents.delete(payload.agent);
        pushEvent(payload.agent, { type: 'remove' });
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
      const result = pushInstruction(payload);
      broadcastAgents();
      json(res, 200, { ok: true, instruction: result.instruction, socialExecution: result.socialExecution, workExecutions: result.workExecutions });
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
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
      if (!isAuthorized(req)) {
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
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'agents', agents: publicAgents() }));
  ws.on('close', () => clients.delete(ws));
});

loadState();
setInterval(sweepAgents, 5000);

server.listen(port, () => {
  console.log(`Miniverse Office listo en http://localhost:${port}`);
});
