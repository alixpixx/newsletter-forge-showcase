FROM oven/bun:1 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_PUBLIC_BASE_URL=$NEXT_PUBLIC_PUBLIC_BASE_URL
# Monorepo bun : l'installation se fait sur l'arbre complet. Un etage de
# dependances separe ne suffit pas, bun lie aussi des binaires dans
# apps/*/node_modules et un `next` manquant sort en code 127.
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# La sortie standalone reproduit l'arborescence du monorepo : le serveur est
# sous apps/admin/ et les node_modules sont a la racine de la sortie.
COPY --from=build /app/apps/admin/.next/standalone ./
COPY --from=build /app/apps/admin/.next/static ./apps/admin/.next/static
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]
