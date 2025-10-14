# Docker Deployment Guide

This guide shows how to deploy the Arke IPFS Mirror using Docker. The Docker image can be deployed to any container platform (Fly.io, AWS ECS, Google Cloud Run, DigitalOcean, etc.).

## Docker Image Overview

The application is packaged as a Docker container:
- **Base Image:** Node.js 20 Alpine (~150MB)
- **Runtime:** Compiled TypeScript (ES2022)
- **State Storage:** Persistent volume at `/data/mirror-state.json`
- **Resource Requirements:** ~256MB RAM (can scale up if state file grows)

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ARKE_API_URL` | Arke API endpoint URL | `http://localhost:3000` | Yes |
| `STATE_FILE_PATH` | Path to state file | `/data/mirror-state.json` | No |

## Building the Docker Image

```bash
docker build -t arke-mirror:latest .
```

The Dockerfile:
- Installs dependencies
- Compiles TypeScript
- Removes dev dependencies
- Creates `/data` directory for volume mounting

## Running Locally

### Basic Run (Foreground)

```bash
docker run --rm \
  -e ARKE_API_URL=http://host.docker.internal:3000 \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

### Run in Background

```bash
docker run -d \
  --name arke-mirror \
  -e ARKE_API_URL=https://your-api.com \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

### With Resource Limits

```bash
docker run -d \
  --name arke-mirror \
  --memory=256m \
  --cpus=1 \
  -e ARKE_API_URL=https://your-api.com \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

## Persistent Storage

The application requires a persistent volume mounted at `/data` to store the mirror state.

**Important:** Without persistent storage, the mirror will restart from scratch on every container restart.

### Volume Options

**Local directory mount:**
```bash
-v $(pwd)/data:/data
```

**Named Docker volume:**
```bash
# Create volume
docker volume create arke-mirror-data

# Use volume
docker run -d \
  --name arke-mirror \
  -e ARKE_API_URL=https://your-api.com \
  -v arke-mirror-data:/data \
  arke-mirror:latest
```

## Monitoring

### View Logs

```bash
# Follow logs in real-time
docker logs -f arke-mirror

# View last 50 lines
docker logs --tail 50 arke-mirror
```

### Check Resource Usage

```bash
docker stats arke-mirror
```

### Inspect State File

```bash
# If using local directory mount
cat data/mirror-state.json | jq .

# If using Docker volume
docker exec arke-mirror cat /data/mirror-state.json | jq .
```

## Management Commands

```bash
# Stop container
docker stop arke-mirror

# Start container
docker start arke-mirror

# Restart container
docker restart arke-mirror

# Remove container
docker rm arke-mirror

# View container info
docker inspect arke-mirror
```

## Deployment Platforms

The Docker image can be deployed to various platforms:

### Container Platforms
- **Fly.io** - See [FLY_IO_DEPLOYMENT.md](FLY_IO_DEPLOYMENT.md) for detailed instructions
- **AWS ECS/Fargate** - Use task definitions with EBS volumes
- **Google Cloud Run** - Use Cloud Storage for state persistence
- **DigitalOcean App Platform** - Use managed databases or volumes
- **Azure Container Instances** - Use Azure Files for volumes
- **Kubernetes** - Use PersistentVolumeClaims

### VPS/VM Deployment
If deploying to a VPS (DigitalOcean, Linode, etc.):

1. **Install Docker** on the server
2. **Clone repository** or copy Dockerfile
3. **Build image** on the server
4. **Run with systemd** for auto-restart:

```bash
# Create systemd service
sudo nano /etc/systemd/system/arke-mirror.service
```

```ini
[Unit]
Description=Arke IPFS Mirror
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker stop arke-mirror
ExecStartPre=-/usr/bin/docker rm arke-mirror
ExecStart=/usr/bin/docker run --rm --name arke-mirror \
  -e ARKE_API_URL=https://your-api.com \
  -v /var/lib/arke-mirror:/data \
  arke-mirror:latest

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl enable arke-mirror
sudo systemctl start arke-mirror

# View logs
sudo journalctl -u arke-mirror -f
```

## Docker Compose (Optional)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  arke-mirror:
    build: .
    container_name: arke-mirror
    restart: unless-stopped
    environment:
      - ARKE_API_URL=https://your-api.com
      - STATE_FILE_PATH=/data/mirror-state.json
    volumes:
      - mirror-data:/data
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 256M

volumes:
  mirror-data:
    driver: local
```

Run with:
```bash
docker-compose up -d
```

## Health Checks

The application doesn't expose an HTTP endpoint by default. Monitor health via:

1. **Container status:**
   ```bash
   docker ps -a | grep arke-mirror
   ```

2. **Log monitoring:**
   ```bash
   docker logs --tail 100 arke-mirror | grep -i error
   ```

3. **Process check:**
   ```bash
   docker exec arke-mirror ps aux
   ```

## Troubleshooting

### Container Exits Immediately

Check logs:
```bash
docker logs arke-mirror
```

Common issues:
- Invalid `ARKE_API_URL`
- Permission issues with volume mount
- Insufficient memory

### State Not Persisting

Verify volume is mounted:
```bash
docker inspect arke-mirror | grep -A 10 Mounts
```

### High Memory Usage

Monitor and adjust:
```bash
# Check current usage
docker stats arke-mirror

# Update memory limit
docker update --memory 512m arke-mirror
```

### Can't Connect to API

If connecting to localhost from container:
- Use `http://host.docker.internal:PORT` (macOS/Windows)
- Use `--network host` (Linux)
- Or use the host machine's IP address

## Security Considerations

1. **Environment Variables:** Use secrets management for production
2. **Network:** Consider network isolation with Docker networks
3. **Updates:** Regularly rebuild image with latest dependencies
4. **State File:** Ensure backups of `/data/mirror-state.json`

## Backup Strategy

### Backup State File

```bash
# Local directory mount
cp data/mirror-state.json data/mirror-state.json.backup

# Docker volume
docker cp arke-mirror:/data/mirror-state.json ./backup/
```

### Automated Backups

Use cron or a backup service to periodically copy the state file.

## Updating the Application

1. **Pull latest code**
2. **Rebuild image:**
   ```bash
   docker build -t arke-mirror:latest .
   ```
3. **Stop and remove old container:**
   ```bash
   docker stop arke-mirror
   docker rm arke-mirror
   ```
4. **Start new container** with same volume

## Performance Optimization

- **Memory:** Start with 256MB, scale up if state file grows large
- **CPU:** Single CPU is sufficient (mostly idle polling)
- **Storage:** Monitor state file size and adjust volume as needed
- **Backoff:** Application uses exponential backoff (30s to 600s) to reduce API load

## Support

For local testing and development, see [LOCAL_TESTING.md](LOCAL_TESTING.md).

For Fly.io specific deployment, see [FLY_IO_DEPLOYMENT.md](FLY_IO_DEPLOYMENT.md).
