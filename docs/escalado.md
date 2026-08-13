# Escalado: usarlo para más de un negocio/cliente

## Modo cliente: clonar el sistema para otro negocio

1. Clona (o haz fork de) este repositorio.
2. `cp .env.example .env` y pon un `CEO_PANEL_TOKEN` propio para ese cliente
   (nunca reutilices el mismo token entre despliegues distintos).
3. Crea su `config/mission-data.json` propio (ver
   [personalización](personalizacion.md)) con su equipo, sus marcas y su
   ritmo real — no el tuyo.
4. Despliega en su propio contenedor/dominio. Cada cliente = su propio
   `data/state.json`, su propio token, su propia config. Nunca compartas
   contenedor ni token entre dos negocios distintos.

## Separar la base pública de tu capa privada de implementación

- **Público (este repo)**: el motor (`server.js`), la estructura, la
  documentación, el ejemplo genérico. Esto es lo que se comparte/mantiene en
  abierto.
- **Privado (por cliente/instalación)**: `.env`, `config/mission-data.json`,
  `data/`, cualquier integración real específica (como
  `office-reality-sync/` configurado contra la automatización real de ese
  negocio). Esto nunca sale del despliegue de cada cliente.

Esta separación ya está forzada por el propio diseño del repo (ver
`.gitignore`) — no depende de acordarte de excluir algo cada vez.

## Checklist de onboarding (instalar en un VPS o dispositivo nuevo)

Ver [`checklist-onboarding.csv`](checklist-onboarding.csv) para la versión en
tabla. Resumen:

1. Clonar el repo en el servidor.
2. Instalar Docker + Docker Compose si no están.
3. `cp .env.example .env` → rellenar `CEO_PANEL_TOKEN` real.
4. `cp docker-compose.example.yml docker-compose.yml` → ajustar si usas
   reverse proxy propio.
5. Crear `config/mission-data.json` con el equipo real de ese cliente (o
   dejarlo sin crear para arrancar con el ejemplo mientras se configura).
6. `docker compose up -d --build`.
7. Verificar `curl http://localhost:4321/api/info` → debe responder con
   `"miniverse": true`.
8. Si se va a exponer públicamente, configurar el reverse proxy/dominio.
9. Programar backup periódico de `data/state.json` (ver
   [backup y restauración](backup-restore.md)).
10. Guardar el `CEO_PANEL_TOKEN` en un gestor de contraseñas — es lo único
    que hace falta para dar órdenes desde `/office`.

## Autoría y marca

Si publicas este proyecto como propio, deja constancia clara en el `README.md`
de quién lo mantiene — es tu trabajo, tu criterio de diseño ("no fabricar
actividad falsa", separación motor/datos) y tu tiempo de desarrollo. Un
proyecto bien documentado y con una razón de ser clara (no un mockup más)
genera más autoridad que uno anónimo.
