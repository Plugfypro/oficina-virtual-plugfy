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
cp .env.example .env          # pon tu propio CEO_PANEL_TOKEN y HEARTBEAT_TOKEN
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Abre `http://localhost:4321/setup` — es la pantalla de registro, solo se puede
usar una vez: crea tu único usuario administrador (email + contraseña) y a
partir de ahí queda bloqueada. Desde entonces entras por `/login`.

Sin Docker, en local:

```bash
npm install
cp .env.example .env
npm start
```

## Este repo NO trae automatizaciones reales conectadas

Importante para no llevarte a engaño: lo que instalas aquí es el **panel** — la
oficina visual, el login, la API de heartbeat. No incluye ningún bot de
llamadas, chatbot, generador de contenido con IA, ni scraper de leads ya
funcionando. Esas son piezas que tú (o quien las construya) tiene que montar
por separado y conectarlas a `POST /api/heartbeat` — ver
[`docs/ejemplo-n8n-workflow.json`](docs/ejemplo-n8n-workflow.json) para un
ejemplo genérico funcional de cómo una automatización real (en este caso, en
n8n) reporta su estado al panel.

Si quieres ver el panel funcionando con automatizaciones reales detrás (no una
maqueta), estos dos sitios lo usan en producción ahora mismo:
- **[plugfy.pro](https://plugfy.pro)** — SaaS de automatización con IA, 100%
  autónomo (sin intervención manual en el día a día).
- **[virtualmarketingspain.com](https://virtualmarketingspain.com)** — agencia
  de marketing digital y automatización con IA que combina trabajo humano y
  automatizaciones reales en el mismo panel.

Si no quieres montar tú mismo las automatizaciones, **Virtual Marketing
Spain** las construye como servicio (n8n, IA, integración con tus APIs
reales) — contacta a través de [virtualmarketingspain.com](https://virtualmarketingspain.com).

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
- [Escalado a más de un cliente/negocio](docs/escalado.md)

## Ejemplo de heartbeat (reportar estado real de un trabajador)

Cualquier automatización que reporte estado real debe mandar la cabecera
`X-Heartbeat-Token` con el valor de tu `HEARTBEAT_TOKEN` — sin eso, el
endpoint responde 401 (a propósito, para que nadie pueda escribir datos falsos
en tu panel).

```bash
curl -X POST http://localhost:4321/api/heartbeat \
  -H "Content-Type: application/json" \
  -H "X-Heartbeat-Token: TU_HEARTBEAT_TOKEN" \
  -d '{
    "agent": "director_general",
    "name": "Director General",
    "state": "working",
    "task": "Revisando prioridades del día"
  }'
```

Para un ejemplo completo de cómo conectar esto desde una automatización real
en n8n (guion + llamada a la IA + heartbeat), ver
[`docs/ejemplo-n8n-workflow.json`](docs/ejemplo-n8n-workflow.json) — se puede
importar directamente en n8n (Import from File) para verlo funcionando.

Estados soportados: `working`, `idle`, `thinking`, `speaking`, `sleeping`, `error`,
`offline`.

## Licencia

MIT — úsalo, adáptalo, despliégalo donde quieras.
