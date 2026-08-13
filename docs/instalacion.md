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

Edita `.env` y pon un `CEO_PANEL_TOKEN` real (cualquier cadena larga, por ejemplo
generada con `openssl rand -hex 32`). Este token es lo único que hace falta para
usar la consola de órdenes — sin él, nadie puede dar instrucciones a los
trabajadores.

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Abre `http://localhost:4321/office`.

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
| `DATA_FILE`           | `/app/data/state.json`  | Dónde se guarda el estado persistente       |

## Primer arranque: ¿con o sin trabajadores?

Si existe `config/mission-data.json` (ver
[personalización](personalizacion.md)), la oficina arranca con tu propio equipo.
Si no existe, usa el ejemplo genérico incluido
(`config/mission-data.example.json`, 8 trabajadores) para que puedas ver cómo
funciona antes de configurar el tuyo.

## Verificar que funciona

```bash
curl http://localhost:4321/api/info
```

Debe devolver un JSON con `"miniverse": true` y el número de agentes cargados.
