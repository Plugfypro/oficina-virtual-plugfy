# Instalación

## Requisitos

- Docker + Docker Compose (recomendado), o Node.js 22+ si lo corres sin Docker.
- Un token privado para el panel del CEO (cualquier cadena larga y aleatoria).

## Con Docker (recomendado)

```bash
git clone <tu-fork-o-este-repo>
cd miniverse-office
cp .env.example .env
```

Edita `.env` y pon valores reales (cualquier cadena larga y aleatoria, por
ejemplo generada con `openssl rand -hex 32`, o con el comando de Node que
indica cada comentario en `.env.example`):

- `CEO_PANEL_TOKEN` — para la consola de órdenes.
- `HEARTBEAT_TOKEN` — para que tus automatizaciones puedan reportar estado real
  (sin esto, `POST /api/heartbeat` responde 401 a propósito).

`ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` puedes dejarlos vacíos — se configuran
desde el navegador en el primer arranque (ver más abajo).

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Abre `http://localhost:4321/setup` y crea tu único usuario administrador
(email + contraseña) — es un registro de un solo uso, se bloquea después. A
partir de ahí entras por `http://localhost:4321/login`.

### Publicarlo con tu dominio (HTTPS)

`docker-compose.example.yml` trae comentada una configuración de ejemplo para
Traefik. Si usas otro reverse proxy (Nginx, Caddy...), simplemente apunta tu
proxy al puerto que hayas mapeado (por defecto `4321`).

## Sin Docker (desarrollo local)

```bash
npm install
cp .env.example .env
npm start
```

## Variables de entorno

| Variable             | Por defecto             | Qué hace                                   |
|----------------------|--------------------------|---------------------------------------------|
| `PORT`                | `4321`                  | Puerto donde escucha el servidor            |
| `OFFLINE_TIMEOUT_MS`  | `900000` (15 min)       | Tras cuánto tiempo sin heartbeat un trabajador pasa a "dormido", y el doble a "desconectado" |
| `CEO_PANEL_TOKEN`     | *(vacío — obligatorio)* | Token privado para la consola de órdenes    |
| `HEARTBEAT_TOKEN`     | *(vacío — obligatorio)* | Token que deben mandar tus automatizaciones en `POST /api/heartbeat` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` | *(vacío)* | Credenciales del único admin — mejor dejarlos vacíos y crear el usuario desde `/setup` en el navegador |
| `DATA_FILE`           | `/app/data/state.json`  | Dónde se guarda el estado persistente (y, junto a él, `admin.json` si usaste `/setup`) |

## Primer arranque: ¿con o sin trabajadores?

Si existe `config/mission-data.json` (ver
[personalización](personalizacion.md)), la oficina arranca con tu propio equipo.
Si no existe, usa el ejemplo genérico incluido
(`config/mission-data.example.json`, 8 trabajadores) para que puedas ver cómo
funciona antes de configurar el tuyo.

## Verificar que funciona

```bash
curl -o /dev/null -s -w "%{http_code}\n" http://localhost:4321/setup
```

Debe devolver `200` (pantalla de registro) si es tu primer arranque, o `302`
(redirige a `/login`) si ya creaste tu usuario. `/api/info` y `/api/metrics`
ahora exigen sesión iniciada — para probarlos hazlo desde el navegador ya
logueado, no con `curl` suelto.
