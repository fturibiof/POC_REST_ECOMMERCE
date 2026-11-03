# One image for the five services; the service to run is chosen by the
# compose `command` (see compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY services ./services
ENV NODE_ENV=production
