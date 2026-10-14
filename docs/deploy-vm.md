# Deploying Flash Sale to AWS EC2

A single `t3a.large` VM (2 vCPU, 8 GB RAM, Ubuntu 24.04) runs the full stack: all services on the host via `make dev`, and infrastructure (Postgres, Redis, Kafka, Envoy, Grafana) in Docker Compose.

## First-time setup

### 1. Install Docker and Docker Compose

```bash
sudo apt update
sudo apt install -y docker.io docker-compose
sudo usermod -aG docker ubuntu
# Logout and log back in for group to take effect
```

Verify: `docker compose version` should be v2.24+.

### 2. Add swap (optional but recommended)

For an 8 GB VM, add 4 GB swap:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3. Clone the repo and set up .env

```bash
cd /home/ubuntu
git clone https://github.com/your-org/flash-sale.git
cd flash-sale
cp .env.example .env
```

Edit `.env` and fill in all secrets:

```bash
nano .env
# Generate each secret with: openssl rand -base64 48
# Fill in POSTGRES_PASSWORD, SESSION_SECRET, ADMISSION_SECRET, etc.
```

### 4. Install Node 24 and pnpm

```bash
curl -fsSL https://fnm.io/install | bash  # or use nvm/volta
fnm install 24
fnm use 24
npm install -g pnpm@12.6.0
```

### 5. Install dependencies and build

```bash
pnpm install --frozen-lockfile
pnpm -r run build
```

### 6. Start the infrastructure stack

```bash
make up  # Starts postgres, redis, kafka, prometheus, grafana, envoy, etc.
```

Wait for all services to be healthy:

```bash
docker compose ps
# All should show "healthy" or "running"
```

### 7. Create databases and seed

```bash
# Create the Prisma schemas
DATABASE_URL="postgresql://app:PASSWORD@localhost:5434/flashsale?schema=order" \
  pnpm -C services/order exec prisma migrate deploy
DATABASE_URL="postgresql://app:PASSWORD@localhost:5434/flashsale?schema=ticket" \
  pnpm -C services/ticket exec prisma migrate deploy
DATABASE_URL="postgresql://app:PASSWORD@localhost:5434/flashsale?schema=payment-mock" \
  pnpm -C services/payment-mock exec prisma migrate deploy

# Seed the demo events
pnpm -C tools run seed-events
```

### 8. Start the app services

Open a new terminal:

```bash
cd /home/ubuntu/flash-sale
make dev
```

This runs order, ticket, queue, relay, and payment-mock on the host, plus the Next.js web app. Each process watches its source files (but on a VM, consider disabling watch for production).

For production (no per-request logs):

```bash
make dev-loadtest  # Quieter: LOG_LEVEL=warn
```

Or run services individually with `npm run start:<service>` after building.

### 9. Access the app

- **Web:** `http://<VM-IP>`
- **Grafana:** SSH tunnel to `127.0.0.1:3000` (see below)
- **Kafka UI:** `http://<VM-IP>:8081` (not exposed in prod, disable if needed)

## Update (ongoing)

```bash
cd /home/ubuntu/flash-sale
bash scripts/deploy.sh
```

This pulls the latest, rebuilds, brings compose up, runs migrations, seeds (idempotent), and smoke tests.

## Logs

```bash
# Follow compose logs
docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.prod.yml logs -f

# Single service
docker compose logs -f envoy

# App service (make dev terminal)
# Ctrl+C stops all; Ctrl+C again forces kill.

# Check service status
make ps
```

## Grafana over SSH tunnel

On your local machine:

```bash
ssh -i /path/to/key.pem -L 3000:localhost:3000 ubuntu@<VM-IP>
# Keep this window open, then visit http://localhost:3000 in your browser
```

Password: value of `GRAFANA_ADMIN_PASSWORD` in `.env`.

## Stop and start the EC2 instance

```bash
# From AWS Console: Stop instance
# Containers have `restart: unless-stopped`, so they come back automatically when the VM starts.
```

Verify on restart:

```bash
docker compose ps
# All should be healthy within 30 seconds.
```

## Backup Postgres

```bash
docker compose exec postgres pg_dump -U app -d flashsale > backup.sql
# Restore:
# docker compose exec -T postgres psql -U app -d flashsale < backup.sql
```

## Troubleshooting

- **"Cannot reach services":** Check `make dev` is running and ports are correct (3001, 3003, 4100, 3002, 3004, 3012).
- **"Envoy 503":** Check upstream health: `curl -s http://localhost:9901/stats/prometheus | grep 'upstream_cx'`.
- **"Migrations fail":** Ensure postgres is healthy: `docker compose exec postgres pg_isready`.
- **"Out of memory":** Add swap (above) or scale down `WORKERS` in ticket service.

## Known limits (single VM)

- **No redundancy:** A VM failure loses everything. For production: use managed RDS, ElastiCache, and auto-scaling app instances behind an ALB.
- **Brief outage during deploy:** Services restart; in-flight requests may fail.
- **Single point of failure:** Envoy (the only public endpoint) is one container. For HA: run 2 VMs, ALB, managed Postgres/Redis.
- **Logging:** All containers write JSON logs; a 30 GB disk fills in ~1 week with moderate traffic. Rotate with `docker container prune` or send to CloudWatch.
