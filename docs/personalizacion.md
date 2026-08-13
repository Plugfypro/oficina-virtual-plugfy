# Personalización

## Tu equipo real: `config/mission-data.json`

El repo trae un ejemplo genérico en `config/mission-data.example.json` (8
trabajadores, marca ficticia "Mi Empresa"). Para poner tu propio equipo, crea
`config/mission-data.json` con la misma forma:

```json
{
  "reglaMadre": ["Regla 1", "Regla 2"],
  "ritmoDiario": [{ "hora": "09:00", "accion": "Qué toca hacer" }],
  "ritmoSemanal": { "lunes": "Tema del día" },
  "herramientasPorDepartamento": { "ventas": "CRM, Email" },
  "agentes": {
    "id_unico_del_trabajador": {
      "dept": "direccion",
      "mission": "Su misión permanente, en una frase",
      "diaria": "Qué hace cada día",
      "semanal": "Qué debe cerrar cada semana",
      "kpi": "Cómo se mide si va bien",
      "marcas": ["Tu Marca"],
      "acceso": ["Plataforma o cuenta que usa"]
    }
  }
}
```

Este archivo **no se sube al repo** (está en `.gitignore`) — es tuyo, se queda
local o en tu servidor. Si lo montas como volumen (ver
`docker-compose.example.yml`), puedes editarlo sin reconstruir la imagen: solo
reinicia el contenedor.

Si el archivo no existe, la oficina arranca igual con el ejemplo genérico —
nunca falla por no tener datos propios configurados todavía.

## Departamentos y su etiqueta visible

Los nombres de departamento que se muestran en `/manual` viven en `DEPT_TITLES`
dentro de `server.js`. Si usas claves de departamento distintas a las del
ejemplo (`direccion`, `community`, `comerciales`, `seo`, `web`,
`automatizacion`, `operaciones`, ...), añade su título ahí.

## Plantillas de ejecución (los pasos de una orden)

Cuando alguien da una instrucción, se genera automáticamente una ejecución con
pasos (ej. "Hook y ángulo" → "Copy y CTA" → "Creatividad" → "Revisión final").
Esos pasos por departamento están en `TEAM_EXECUTION_TEMPLATES` en `server.js` —
cámbialos por el flujo de trabajo real de tu equipo.

## Conectar datos reales (opcional)

Si tienes automatizaciones reales que quieres reflejar en vivo (en vez de una
misión fija), mira `office-reality-sync/sync-real.js` como ejemplo — está escrito
para leer una base de datos de n8n, pero el patrón (leer tu fuente real, mandar
un heartbeat honesto) sirve para cualquier sistema. Solo conecta lo que sea
real — no lo uses para fabricar actividad falsa en trabajadores sin
automatización de verdad.

## Colores y estilo visual

El CSS está embebido directamente en cada función `render*Html()` de
`server.js` (sin build step, sin dependencias de frontend). Busca las variables
de color como `#d4af37` (dorado) y `#0b0b0f` (fondo oscuro) si quieres adaptarlo
a tu propia paleta de marca.
