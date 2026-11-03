FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/command-centre.db
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api apps/api
COPY --from=build /app/apps/web/dist apps/web/dist
COPY package.json .
VOLUME /data
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--no-warnings", "apps/api/src/server.ts"]
