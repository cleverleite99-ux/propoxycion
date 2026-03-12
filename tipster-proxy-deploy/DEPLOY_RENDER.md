# Desplegar el proxy en Render (gratis)

## Pasos (5 minutos)

### 1. Sube el proxy a GitHub
- Crea un repo nuevo en github.com (ej: "tipster-proxy")
- Sube la carpeta tipster-proxy/ con todos sus archivos

### 2. Crea el servicio en Render
- Ve a https://render.com y regístrate (gratis)
- New → Web Service
- Conecta tu repo de GitHub
- Configuración:
  - Name: tipster-proxy
  - Runtime: Node
  - Build Command: npm install
  - Start Command: node index.js
  - Plan: Free
- Clic en "Create Web Service"

### 3. Espera ~2 minutos
Render te dará una URL del tipo:
  https://tipster-proxy-xxxx.onrender.com

### 4. Pon esa URL en la app
Abre tipster-ai/src/App.tsx y cambia:
  const API_BASE = "PROXY_URL_PLACEHOLDER";
por:
  const API_BASE = "https://tipster-proxy-xxxx.onrender.com";

### 5. Recompila el APK
  cd tipster-ai
  npm run build
  npx cap copy android
  (compilar APK en Android Studio)

## Nota sobre el plan gratuito de Render
El servicio se "duerme" tras 15 min de inactividad.
La primera petición tras ese tiempo tarda ~30 segundos en despertar.
Para evitarlo, puedes usar UptimeRobot (gratis) para hacer ping cada 10 min.
