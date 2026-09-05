# Build
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Runtime — static files only (PWA built with base /travel/)
FROM nginx:alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
# Dist lives under /travel/ so Traefik can forward the full path without StripPrefix.
COPY --from=build /app/dist /usr/share/nginx/html/travel

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
