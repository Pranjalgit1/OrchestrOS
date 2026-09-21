FROM node:24.13.0-alpine

WORKDIR /app

COPY package.json package-lock.json .env.example ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY backend backend
RUN npm run prisma:generate --workspace backend
RUN npm run build --workspace backend

EXPOSE 4000

CMD ["npm", "run", "start", "--workspace", "backend"]
