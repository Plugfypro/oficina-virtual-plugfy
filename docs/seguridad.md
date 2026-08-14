# Seguridad

## Dónde van los secretos

**Solo en `.env`, nunca en el código.** El repo trae `.env.example` con los
nombres de las variables necesarias, sin valores reales. `.env` está en
`.gitignore` — nunca debería aparecer en un commit.

| Secreto                | Dónde vive                        |
|-------------------------|------------------------------------|
| `CEO_PANEL_TOKEN`       | `.env` (variable de entorno)       |
| `HEARTBEAT_TOKEN`       | `.env` (variable de entorno) — también debe configurarse en cada automatización que llame a `POST /api/heartbeat` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` | `.env` — el hash se genera una vez, nunca se guarda la contraseña en texto plano |
| Credenciales de tu automatización real (n8n, APIs...) | En la config de `office-reality-sync/`, nunca en `server.js` |

## Qué NO debe subirse nunca a un repo (público o privado compartido)

- `.env` (credenciales reales)
- `data/` (estado real: instrucciones, métricas de negocio reales)
- `config/mission-data.json` (los datos reales de tu equipo — el repo solo trae
  `config/mission-data.example.json`, genérico)
- `docker-compose.yml` (si le añadiste tu dominio real o tokens de proxy) — el
  repo trae `docker-compose.example.yml` sin esos datos
- Cualquier CSV/archivo de trabajo interno con nombres, accesos o datos reales de
  clientes (revisa `knowledge/` antes de un commit si guardas ahí notas propias)

Todo lo anterior ya está cubierto por el `.gitignore` incluido — pero si añades
archivos nuevos con datos reales, revisa que también queden excluidos antes de
hacer commit.

## El token del CEO

`CEO_PANEL_TOKEN` es lo único que protege la consola de órdenes
(`POST /api/instructions` y endpoints relacionados). No tiene expiración ni
rotación automática — trátalo como una contraseña: no lo compartas fuera de tu
equipo, y cámbialo si sospechas que se filtró (basta con editar `.env` y
reiniciar el contenedor).

## El token de heartbeat

`POST /api/heartbeat` y `POST /api/agents/remove` exigen la cabecera
`X-Heartbeat-Token` con el valor de `HEARTBEAT_TOKEN`. Sin esto, cualquiera en
internet podría escribir o borrar datos del panel — por eso es obligatorio,
no opcional. Cada automatización que reporte estado real (n8n, un script, lo
que sea) debe mandar esa cabecera. Si tras un cambio de token tus
automatizaciones dejan de reportar, revisa que también se haya actualizado
ahí, no solo en `.env` del panel.

Hay además un límite de intentos fallidos por IP (5 fallos → bloqueo de 30
minutos) en los endpoints protegidos por token, para frenar intentos de
adivinar el token a fuerza bruta. Este bloqueo nunca afecta a las páginas
públicas de solo lectura, solo a los endpoints que escriben/borran datos.

## Login del panel

`/office`, `/operations`, `/manual`, `/api/agents`, `/api/events` y el
WebSocket (`/ws`) exigen sesión iniciada (`ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH`
en `.env`). Sin esas dos variables configuradas, el login queda deshabilitado
y esas rutas son inaccesibles — configúralas antes de desplegar en producción.
La contraseña se guarda solo como hash (scrypt), nunca en texto plano — no la
reutilices de otro sistema (SSH, hosting, etc.): si el panel se viera
comprometido alguna vez, esa contraseña no debe abrir nada más.

Los únicos endpoints de solo lectura que siguen siendo públicos por diseño son
`/api/info` y `/api/metrics` (pensados para mostrarse sin login, ej. en un
embed). Si tu información de negocio es sensible, no expongas ni siquiera esos
a internet sin un proxy con autenticación adicional delante.

## Antes de cada `git push`

1. `git status` — revisa qué archivos se van a subir.
2. Si ves `.env`, `data/`, `config/mission-data.json`, o cualquier archivo con
   datos reales de tu empresa en la lista: **para y revisa el `.gitignore`**.
3. Si ya hiciste commit de un secreto por error: no basta con borrarlo en el
   siguiente commit — sigue en el historial de git. Hay que reescribir el
   historial (`git filter-repo` o similar) o, si ya se publicó, considerar el
   secreto comprometido y rotarlo.

## Reportar un problema de seguridad

Si encuentras una vulnerabilidad real en el código (no en tu propia
configuración), abre un issue privado o contacta directamente antes de hacerlo
público.
