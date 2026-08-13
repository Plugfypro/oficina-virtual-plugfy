# Seguridad

## Dónde van los secretos

**Solo en `.env`, nunca en el código.** El repo trae `.env.example` con los
nombres de las variables necesarias, sin valores reales. `.env` está en
`.gitignore` — nunca debería aparecer en un commit.

| Secreto                | Dónde vive                        |
|-------------------------|------------------------------------|
| `CEO_PANEL_TOKEN`       | `.env` (variable de entorno)       |
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

Los endpoints de solo lectura (`/api/info`, `/api/metrics`) son públicos por
diseño — pensados para que la oficina se pueda mostrar sin autenticación. Si tu
información de negocio es sensible, no expongas el servicio a internet sin un
proxy con autenticación adicional delante.

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
