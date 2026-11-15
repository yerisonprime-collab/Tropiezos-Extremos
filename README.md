# Tropiezos Extremos (primera versión jugable)

## Estado real
**Incluido:** menú, registro/login con Supabase, personaje 3D con animación de correr, cámara en tercera persona, un mapa (pista con barras giratorias), carrera con meta, servidor Node.js + Socket.IO que simula el juego (hasta 30 jugadores), recompensas validadas en el servidor y guardadas en Supabase.

**Todavía no incluido:** los otros 7 mapas, skins/tienda, personalización, pase de temporada, clasificación, misiones, salas privadas con código, rondas eliminatorias (ahora hay una sola carrera por partida), música y efectos de sonido, reconexión.

**Sin probar:** este código no se ha ejecutado todavía. Es posible que haya que corregir errores al primer arranque.

## Instalación
1. Instala Node.js 18 o superior.
2. En Supabase: crea un proyecto, abre SQL Editor y ejecuta `supabase/migrations/001_initial_schema.sql`.
3. En Authentication > Providers > Email, desactiva "Confirm email" si quieres probar sin verificar correos.
4. Copia `server/.env.example` a `server/.env` y rellena las tres claves (Project Settings > API).
5. Terminal:
   ```
   cd server
   npm install
   npm start
   ```
6. Abre http://localhost:3000. Con dos pestañas (dos cuentas) la partida arranca sola con 10 s de cuenta atrás.

Sin claves de Supabase, el juego ofrece "Jugar de invitado" (solo pruebas locales, sin guardado).

## Controles
W/A/S/D mover, Espacio saltar, Shift correr, clic en el juego para activar el ratón (cámara).

## Publicar en Internet
Sube la carpeta a un servicio que ejecute Node (Render, Railway, Fly.io). Comando de inicio: `cd server && npm install && npm start`. Define las variables de `.env.example` en el panel del servicio. Necesitas WebSockets (todos los anteriores los soportan).

## Errores frecuentes
- "Sesión no válida": falta `SUPABASE_SERVICE_ROLE_KEY` o la URL es incorrecta.
- Registro sin perfil: no se ejecutó la migración SQL.
- Monedas que no suben: revisa los logs del servidor; `award_match` debe existir.
- Pantalla azul sin personaje: el servidor no está en marcha o falló la conexión Socket.IO.
