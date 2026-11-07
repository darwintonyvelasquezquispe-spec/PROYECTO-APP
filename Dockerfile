# DarkMan - Dockerfile para Producción en la Nube (Render, Railway, Fly.io, VPS)
FROM node:22-alpine

WORKDIR /app

# Crear directorio de datos
RUN mkdir -p /app/data

# Copiar archivos de la aplicación
COPY . /app

# Variable de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000
ENV REQUIRE_AUTH=true

EXPOSE 3000

CMD ["node", "server.js"]
