FROM node:24.13.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY frontend frontend
RUN npm run build --workspace frontend

EXPOSE 5173

CMD ["npm", "run", "preview", "--workspace", "frontend"]
