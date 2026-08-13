# Arquitectura

## Piezas

```
┌─────────────────────────────────────────────────────────────┐
│  miniverse-office (server.js, un único proceso Node)         │
│                                                                │
│  /office        oficina visual + consola de órdenes           │
│  /operations    taller: ejecuciones, pasos, métricas negocio  │
│  /manual        manual operativo maestro (misión/KPI/acceso)  │
│  /api/*         REST (agentes, instrucciones, métricas...)    │
│  /ws            WebSocket (estado en vivo)                    │
│                                                                │
│  estado en memoria + persistido en data/state.json            │
└─────────────────────────────────────────────────────────────┘
                          ▲
                          │ POST /api/heartbeat (JSON)
                          │
        ┌─────────────────┴──────────────────┐
        │                                     │
  trabajador con automatización real    trabajador sin automatización
  (ej. un servicio que lee tu n8n       (mission fija cargada al arrancar
  y llama a heartbeat cada 5 min)       desde config/mission-data.json)
```

## El "trabajador" (agent)

Cada trabajador es un registro simple:

```json
{
  "agent": "id-unico",
  "name": "Nombre para mostrar",
  "state": "working | idle | thinking | speaking | sleeping | error | offline",
  "task": "Qué está haciendo ahora mismo",
  "metadata": { "source": "...", "static": true }
}
```

`metadata.static: true` significa "este trabajador tiene una misión fija, no una
señal de actividad real que vigilar" — el sistema nunca lo pasa automáticamente a
`sleeping`/`offline` por falta de heartbeat, porque no tendría sentido (una misión
permanente no caduca). Los trabajadores SIN ese flag sí decaen a `sleeping` tras
`OFFLINE_TIMEOUT_MS` sin reportar, y a `offline` al doble de ese tiempo — así el
estado refleja de verdad si la automatización sigue viva.

## Departamentos

La asignación a departamento se infiere del `agent`/`name` por patrones (ver
`inferDepartment()` en `server.js`) — no hace falta declararlo aparte, basta con
nombrar bien al agente (`ventas_01`, `seo_lead`, `web_dev`...).

## La consola de órdenes (`/office`)

Envía una instrucción real (`POST /api/instructions`, requiere
`x-ceo-token`) con tres alcances posibles:

- **`worker`** — un trabajador concreto.
- **`team`** — un departamento entero.
- **`global`** — toda la oficina.

Cada instrucción genera automáticamente una **ejecución rastreada** (pasos tipo
hook → copy → creatividad → revisión, definidos en `TEAM_EXECUTION_TEMPLATES`
dentro de `server.js`) asignada a los trabajadores del equipo correspondiente. La
API devuelve esa ejecución en la misma respuesta, así que el panel puede mostrar
al momento "quién la recibió y con qué pasos" — sin inventar una respuesta de IA,
solo reflejando lo que de verdad se acaba de crear.

## `office-reality-sync/` (opcional, servicio aparte)

Un proceso independiente pensado para leer datos REALES de tus automatizaciones
(el ejemplo incluido lee una base de datos sqlite de n8n) y traducirlos en
heartbeats honestos — sin usar IA, sin coste por ejecución. Es opcional: si no
tienes automatizaciones que conectar, no hace falta desplegarlo, la oficina
funciona igual con las misiones fijas de `config/mission-data.json`.

Principio: **solo conecta lo que sea real**. No dupliques este patrón para
inventar actividad falsa — si un trabajador no tiene una automatización real
detrás, mejor dejar su misión fija que fabricarle una tarea "en vivo" ficticia.

## Persistencia

Todo el estado (agentes, instrucciones, ejecuciones, métricas de negocio) se
guarda en `data/state.json` en cada cambio. No hay base de datos externa — para
un volumen mayor de datos históricos, sería el primer punto a extraer a una BD
real, pero para el caso de uso (una oficina, no miles de eventos/segundo) un
archivo JSON es suficiente y trivial de respaldar.
