# Backup y restauración

## Qué hay que respaldar

Todo el estado real vive en dos sitios:

1. **`data/state.json`** — agentes, instrucciones, ejecuciones, métricas de
   negocio. Se reescribe en cada cambio.
2. **`config/mission-data.json`** — tu equipo real (si lo has configurado).
3. **`data/admin.json`** — solo existe si creaste tu usuario desde `/setup`
   (en vez de por variables de entorno). Guarda el email y el hash de la
   contraseña del único admin — sin este archivo (y sin `ADMIN_EMAIL`/
   `ADMIN_PASSWORD_HASH` en `.env`), perderías el acceso y tendrías que volver
   a pasar por `/setup`. Haz backup de él junto a `state.json`.

Todo lo demás (`server.js`, `docker-compose.yml`...) es código, no estado — vive
en tu propio control de versiones o copia local, no necesita backup aparte del
repo en sí.

## Backup manual rápido

```bash
# Con el contenedor corriendo:
docker cp miniverse-office:/app/data/state.json ./backup-state-$(date +%Y%m%d-%H%M%S).json
cp config/mission-data.json ./backup-mission-data-$(date +%Y%m%d-%H%M%S).json
```

O, si tienes acceso directo al volumen montado (`./data:/app/data` en tu
`docker-compose.yml`), basta con copiar la carpeta `data/` local — no hace falta
entrar al contenedor.

## Backup automático (recomendado en producción)

Un cron simple que copie `data/state.json` a una carpeta con fecha, con
retención de los últimos N días, es suficiente para el volumen de datos de este
sistema (no es una base de datos de alto tráfico). Ejemplo mínimo:

```bash
#!/bin/sh
# backup-diario.sh
FECHA=$(date +%Y%m%d)
mkdir -p /ruta/de/backups
cp /ruta/al/proyecto/data/state.json "/ruta/de/backups/state-$FECHA.json"
# Borra backups de mas de 30 dias
find /ruta/de/backups -name "state-*.json" -mtime +30 -delete
```

Prográmalo con `cron` (Linux) o el Programador de tareas (Windows) según dónde
corra tu servidor.

## Restaurar

1. Para el contenedor: `docker compose stop miniverse-office`.
2. Sustituye `data/state.json` por el backup elegido.
3. Vuelve a arrancar: `docker compose up -d`.

El servidor carga el estado desde `data/state.json` al arrancar
(`loadState()` en `server.js`) — no hace falta ningún paso extra de
"importación".

## Antes de un cambio delicado (despliegue de código, no de datos)

Si vas a desplegar un cambio grande en `server.js` (o en la estructura de
`config/mission-data.json`), haz una copia de ambos archivos primero. Restaurar
código es tan simple como volver a copiar la versión anterior y reconstruir la
imagen (`docker compose build --no-cache && docker compose up -d`).
