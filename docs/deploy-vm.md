# Running the demo on one VM

The whole stack (infrastructure, services and web app) runs in Docker Compose on one AWS EC2
`t3a.large` (2 vCPU, 8 GB, x86_64, Ubuntu 24.04). Images are built on the VM; there is no registry.

```bash
COMPOSE="docker compose --env-file .env -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.prod.yml"
```

Every command below runs from the repo checkout (`~/Flash-Sale`) and uses `$COMPOSE`.

Only port 80 is public. Grafana (3000), Prometheus (9090) and the Envoy admin port (9901) listen on
127.0.0.1 and are reached over an SSH tunnel. Nothing else publishes a port.

## First-time setup

The EC2 security group should allow inbound 22 (from your IP only) and 80. Nothing else.

**1. Docker, from Docker's own repository** (Ubuntu's `docker.io` may be too old: Compose 2.24.4 or
later is needed):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu        # then log out and back in
docker compose version                # 2.24.4 or later
```

Node and pnpm are NOT needed on the VM: everything builds inside the image.

**2. Swap.** The image build (`next build`, `tsc`) runs next to the live stack during an update:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**3. Clone, then create `.env`:**

```bash
git clone <repo-url> ~/Flash-Sale && cd ~/Flash-Sale
git checkout <branch>
cp .env.example .env
nano .env     # every change-me: openssl rand -base64 48, and openssl rand -hex 24 for POSTGRES_PASSWORD
```

**4. Deploy:**

```bash
bash scripts/deploy.sh
```

It checks `.env`, pulls, builds the image, starts the infrastructure, creates the Kafka topics,
runs the migrations, starts everything and waits for the health checks, seeds the demo events if
they are not there yet, and finishes with `scripts/smoke-prod.sh`. It stops at the first failure.

Then open `http://<public IP>/`.

## Update

```bash
cd ~/Flash-Sale && bash scripts/deploy.sh
```

Changes reach the VM through git only: commit and push, then deploy. `--reseed` runs the seed again
(the sale times move to now; stock is not reset).

## Logs and state

```bash
$COMPOSE ps
$COMPOSE logs -f order-api            # or any service: ticket, queue-svc, relay, envoy, ...
$COMPOSE logs --since 10m envoy
docker stats --no-stream
```

Each container keeps at most 3 log files of 10 MB.

## Grafana and Prometheus over SSH

```bash
ssh -i key.pem -L 3000:localhost:3000 -L 9090:localhost:9090 ubuntu@<public IP>
```

Then open http://localhost:3000 (user `admin`, `GRAFANA_ADMIN_PASSWORD`) and http://localhost:9090.
Grafana reads that password only when it first creates its database; to change it later:
`$COMPOSE exec grafana grafana cli admin reset-admin-password '<new>'`.

## Stopping and starting

Stopping and starting the EC2 instance is safe: Docker starts at boot and every long-running
container has `restart: unless-stopped`, so the stack comes back by itself. Check with `$COMPOSE ps`.

```bash
$COMPOSE stop          # stop everything, keep the data
$COMPOSE start
$COMPOSE down          # remove the containers, keep the volumes (data)
```

`$COMPOSE down -v` also deletes the volumes: the database, Redis, Kafka and the metrics.

## Backup

```bash
$COMPOSE exec -T postgres pg_dump -U app -d flashsale | gzip > flashsale-$(date +%F).sql.gz
# restore into an empty database:
gunzip -c flashsale-YYYY-MM-DD.sql.gz | $COMPOSE exec -T postgres psql -U app -d flashsale
```

Redis (stock, holds, waiting rooms, the outbox stream) is on the `redis-data` volume with an AOF.
Postgres alone is not enough to restore a sale in progress.

## Memory

Every container has a limit; together they come to 5.9 GiB of the 8 GB. Measured two minutes after
a deploy, idle, the stack uses about 1 GiB.

| Container | Limit | Notes |
|---|---|---|
| redpanda (Kafka) | 1 GiB | `--memory 700M`; not a JVM, so no heap options |
| postgres | 768 MiB | `shared_buffers=192MB`, `max_connections=100` |
| ticket | 512 MiB | cluster primary + 2 workers, 128 MiB heap each |
| prometheus | 384 MiB | 7 days of retention |
| grafana | 384 MiB | uses about 230 MiB right after it starts |
| order-worker | 384 MiB | 192 MiB heap (Kafka buffers live outside it) |
| web | 384 MiB | `next start` |
| order-api, payment-mock | 320 MiB each | |
| redis | 256 MiB | `maxmemory 192mb`, `noeviction`, AOF on a volume |
| queue-svc, queue-admitter, relay | 256 MiB each | |
| envoy | 256 MiB | |
| redis-ratelimit, ratelimit | 128 MiB each | counters only, nothing on disk |
| redis-exporter | 64 MiB | |

kafka-ui and jaeger are not started (`--profile debug` starts them, with no port published).

## Known limits

- **One VM, one of everything.** A VM, disk or AZ failure takes the whole demo down, and the
  database lives on the VM's disk. Back it up.
- **Deploys blip.** `deploy.sh` recreates the containers whose image or config changed; requests
  in that window can fail for a few seconds.
- **Dev login is on.** It is the demo's login: anyone can sign in as any user id. order-api runs with
  `NODE_ENV=development` because that is what mounts it, and it logs a warning at every start. The
  other services run with `NODE_ENV=production`.
- **Redpanda runs in dev-container mode** (one node, relaxed fsync). Fine for a demo, not for money.
- **HTTP only.** No TLS on port 80; put a load balancer or Caddy in front for HTTPS.

What production would use instead: Kubernetes (or ECS) with several replicas of each service behind
a load balancer and rolling deploys; managed Postgres (RDS), Redis (ElastiCache) and Kafka (MSK);
images built in CI and pulled from a registry; secrets from a secrets manager; TLS at the edge.
