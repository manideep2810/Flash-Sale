# One image for every Node process of the production stack (infra/docker/docker-compose.prod.yml):
# the services, the web app, and the migrate and seed jobs. Each container picks its process with
# its own working_dir and command. Built from the repo root:
#
#   docker build -f infra/docker/app.Dockerfile -t flash-sale-app .
#
# It keeps the dev dependencies on purpose: the migrate job needs the prisma CLI and the seed job
# runs tools/ through tsx. One image built once is cheaper on a small VM than a slim image per service.

FROM node:24-bookworm-slim

# Prisma's migration engine links against OpenSSL, which the slim image leaves out. It has to be
# there before `pnpm install`, which picks the engine build to download by the OpenSSL it finds.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# The version root package.json pins in "packageManager".
RUN npm install -g pnpm@12.6.0

WORKDIR /app

# Manifests first, so the install layer is reused until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/kafka/package.json packages/kafka/
COPY packages/observability/package.json packages/observability/
# With a schema comes its tsconfig.json: `prisma generate` reads it to pick the import extension of
# the client it writes. Without it the client imports "./enums.ts", which `node dist/...` cannot load.
COPY services/order/package.json services/order/prisma.config.ts services/order/tsconfig.json services/order/
COPY services/order/prisma services/order/prisma
COPY services/payment-mock/package.json services/payment-mock/prisma.config.ts services/payment-mock/tsconfig.json services/payment-mock/
COPY services/payment-mock/prisma services/payment-mock/prisma
COPY services/queue/package.json services/queue/
COPY services/relay/package.json services/relay/
COPY services/ticket/package.json services/ticket/prisma.config.ts services/ticket/tsconfig.json services/ticket/
COPY services/ticket/prisma services/ticket/prisma
COPY tools/package.json tools/
COPY tests/e2e/package.json tests/e2e/
COPY web/package.json web/
# postinstall runs `prisma generate` in each service with a schema, which needs the schemas above.
RUN pnpm install --frozen-lockfile

COPY . .

# The workspace packages are consumed as dist/ by `node`, so they build before the services.
# Lua scripts are read from src/ (order, ticket) and lua/ (queue), which COPY . . brought in.
RUN pnpm -r --filter "./packages/*" run build \
 && pnpm -r --filter "./services/*" run build \
 && NEXT_TELEMETRY_DISABLED=1 pnpm -C web run build

ENV NEXT_TELEMETRY_DISABLED=1
