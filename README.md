# Bren & Gabo

App privada de pareja. Sitio estático + Supabase (datos, fotos, login) + Vercel (hosting y notificaciones).

- `index.html`: la app (generada a partir de la versión original).
- `shim.js`: conexión con Supabase (login, datos, fotos privadas, notificaciones, importador).
- `sw.js`: service worker (offline, fotos privadas, push).
- `api/notify.js`: envía notificaciones push (Vercel).
- `supabase/schema.sql`: base de datos y reglas de seguridad.

Variables en Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
