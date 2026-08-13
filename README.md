# Miniverse Office

Una oficina virtual para visualizar y coordinar tu equipo (humano, automatizado, o
mixto) como si fuera un espacio de trabajo real: cada "trabajador" tiene un puesto,
una misión, una tarea del día y un estado en vivo.

No es una maqueta. Los agentes conectados a automatizaciones reales (n8n, APIs,
lo que sea) reportan su estado real vía una API sencilla — sin inventar actividad
para los que no tienen automatización detrás, sin gastar recursos de más.

## Por qué existe

La mayoría de paneles de "agentes IA" o dashboards de equipo son o bien un mockup
bonito sin datos reales, o una tabla aburrida sin contexto. Miniverse Office es lo
de en medio: una representación visual honesta de quién hace qué, con datos reales
donde los hay, y sin fabricar actividad donde no los hay.

## Qué incluye

- **`/office`** — la oficina: departamentos, puestos, estado en vivo de cada
  trabajador, y una consola para dar instrucciones directas (a un trabajador
  concreto, a un equipo, o a toda la oficina) con confirmación real de qué se creó.
- **`/operations`** — el taller operativo: ejecuciones en curso con pasos
  (hook → copy → creatividad → revisión, o el flujo que definas), métricas de
  negocio editables, motor general por departamento.
- **`/manual`** — manual operativo maestro: misión, tarea diaria, tarea semanal,
  KPI, marcas y acceso real de cada trabajador, agrupado por departamento.
- **API REST + WebSocket** para reportar estado real (`/api/heartbeat`), dar
  órdenes (`/api/instructions`), consultar métricas (`/api/metrics`) y más.
- **Capa de sincronización real opcional** (`office-reality-sync/`): un servicio
  aparte, sin coste de IA, que lee tus automatizaciones reales (ej. una base de
  datos de n8n) y actualiza el estado de los trabajadores conectados cada pocos
  minutos — sin inventar nada para los que no tienen automatización real.

## Principio de diseño: no fabricar actividad

Si un trabajador no tiene una automatización real detrás, muestra su misión fija
(qué hace, en general) en vez de un estado inventado que cambia solo. Si la tiene,
muestra su estado real. Nunca al revés.

## Arranque rápido

```bash
cp .env.example .env          # y pon tu propio CEO_PANEL_TOKEN
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Abre `http://localhost:4321/office`.

Sin Docker, en local:

```bash
npm install
cp .env.example .env
npm start
```

## Personalización

Este repo trae un ejemplo genérico de 8 trabajadores
(`config/mission-data.example.json`). Para tu propio equipo, crea
`config/mission-data.json` (se carga automáticamente si existe, nunca se sube al
repo — ver [`docs/personalizacion.md`](docs/personalizacion.md)).

## Documentación

- [Instalación](docs/instalacion.md)
- [Arquitectura](docs/arquitectura.md)
- [Seguridad](docs/seguridad.md)
- [Personalización](docs/personalizacion.md)
- [Backup y restauración](docs/backup-restore.md)

## Ejemplo de heartbeat (reportar estado real de un trabajador)

```bash
curl -X POST http://localhost:4321/api/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "director_general",
    "name": "Director General",
    "state": "working",
    "task": "Revisando prioridades del día"
  }'
```

Estados soportados: `working`, `idle`, `thinking`, `speaking`, `sleeping`, `error`,
`offline`.

## Licencia

MIT — úsalo, adáptalo, despliégalo donde quieras.
