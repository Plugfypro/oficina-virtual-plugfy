#!/bin/sh
set -eu

BASE_URL="${1:-http://127.0.0.1:4322}"

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"director_general","name":"Director General","state":"working","task":"Revisando prioridades y coordinando equipos"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"cm_vms","name":"Community Manager VMS","state":"working","task":"Planificando publicaciones de automatización con IA"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"ventas_01","name":"Comercial Captación","state":"working","task":"Preparando seguimiento de leads para automatizaciones y chatbots"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"seo_lead","name":"SEO Lead","state":"thinking","task":"Auditando oportunidades SEO, GEO y AEO en tus webs principales"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"web_dev","name":"Responsable Web","state":"working","task":"Revisando estructura de conversión y CTAs de páginas clave"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"automatizacion_n8n","name":"Especialista Automatización","state":"working","task":"Preparando automatizaciones y flujos conectados a contenido y ventas"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_instagram_main","name":"Especialista Instagram Principal","state":"working","task":"Preparando publicaciones y reels para la cuenta principal"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_instagram_ia","name":"Especialista Instagram IA","state":"working","task":"Adaptando contenido para la cuenta secundaria con texto alternativo"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_tiktok","name":"Especialista TikTok","state":"working","task":"Preparando ganchos y vídeos verticales de alto alcance"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_youtube_shorts","name":"Especialista YouTube Shorts","state":"working","task":"Planificando shorts reutilizando contenido comercial y educativo"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_facebook_meta","name":"Especialista Facebook Meta","state":"working","task":"Coordinando publicaciones, carruseles y calendario en Meta Business Suite"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_copy_hooks","name":"Especialista Copy y Hooks","state":"thinking","task":"Escribiendo textos, CTAs y ganchos para publicaciones de automatización con IA"}'
echo

curl -s -X POST "$BASE_URL/api/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary '{"agent":"social_creative_design","name":"Especialista Creatividad Redes","state":"working","task":"Definiendo piezas visuales 9:16 y líneas creativas para cada marca"}'
echo

curl -s "$BASE_URL/api/agents"
echo
