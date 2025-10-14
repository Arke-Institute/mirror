# Local Docker Testing Guide

This guide explains how to test the Arke IPFS Mirror locally using Docker before deploying to Fly.io.

## Prerequisites

- Docker installed and running
- Your Arke API endpoint available (or use `http://localhost:3000` for local development)

## Quick Start

### 1. Build the Docker Image

```bash
docker build -t arke-mirror:latest .
```

This will:
- Use Node.js 20 Alpine as the base image
- Install dependencies and build TypeScript
- Create the image (~150MB)

### 2. Create a Local Data Directory

```bash
mkdir -p data
```

This directory will simulate the persistent volume used on Fly.io.

### 3. Run the Container

**Basic run (foreground):**
```bash
docker run --rm \
  -e ARKE_API_URL=http://host.docker.internal:3000 \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

**Run in background:**
```bash
docker run -d \
  --name arke-mirror-test \
  -e ARKE_API_URL=http://host.docker.internal:3000 \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

**Note:** `host.docker.internal` allows the container to access services running on your host machine (e.g., localhost:3000).

## Monitoring the Container

### View Logs

**Follow logs in real-time:**
```bash
docker logs -f arke-mirror-test
```

**View last 50 lines:**
```bash
docker logs --tail 50 arke-mirror-test
```

### Check Container Status

```bash
docker ps -a | grep arke-mirror
```

### Inspect the Container

```bash
docker inspect arke-mirror-test
```

## Verifying State Persistence

### Check the State File

While the container is running (or after it stops):

```bash
# View state file size
ls -lh data/mirror-state.json

# View state file contents (formatted)
cat data/mirror-state.json | jq .

# Count entities
cat data/mirror-state.json | jq '.pis | length'
```

### Test Persistence Across Restarts

1. **Run the container and let it sync:**
   ```bash
   docker run -d --name arke-mirror-test \
     -e ARKE_API_URL=http://host.docker.internal:3000 \
     -v $(pwd)/data:/data \
     arke-mirror:latest
   ```

2. **Wait a few seconds, then stop it:**
   ```bash
   docker stop arke-mirror-test
   docker rm arke-mirror-test
   ```

3. **Verify state file exists:**
   ```bash
   ls -lh data/mirror-state.json
   ```

4. **Restart with the same data directory:**
   ```bash
   docker run -d --name arke-mirror-test \
     -e ARKE_API_URL=http://host.docker.internal:3000 \
     -v $(pwd)/data:/data \
     arke-mirror:latest
   ```

5. **Check logs - it should resume from saved state:**
   ```bash
   docker logs arke-mirror-test
   ```

   You should see:
   ```
   === Mirror Already Initialized ===
     - Total entities: XXXX
     - Last poll: ...
   ```

## Interactive Shell Access

To explore inside the running container:

```bash
docker exec -it arke-mirror-test /bin/sh
```

Once inside:
```bash
# View the state file
cat /data/mirror-state.json | head -20

# Check disk usage
df -h /data

# View running processes
ps aux

# Exit
exit
```

## Environment Variables

You can override any environment variable:

```bash
docker run -d \
  --name arke-mirror-test \
  -e ARKE_API_URL=https://your-production-api.com \
  -e STATE_FILE_PATH=/data/mirror-state.json \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

## Common Commands

### Stop the Container

```bash
docker stop arke-mirror-test
```

### Start the Container Again

```bash
docker start arke-mirror-test
```

### Restart the Container

```bash
docker restart arke-mirror-test
```

### Remove the Container

```bash
docker stop arke-mirror-test
docker rm arke-mirror-test
```

### Clean Up Everything (including state)

```bash
# Stop and remove container
docker stop arke-mirror-test
docker rm arke-mirror-test

# Remove image
docker rmi arke-mirror:latest

# Remove state file
rm -rf data/
```

## Troubleshooting

### Container Exits Immediately

Check the logs:
```bash
docker logs arke-mirror-test
```

Common issues:
- **Can't reach API:** Make sure `ARKE_API_URL` is correct
  - Use `http://host.docker.internal:PORT` for localhost services
  - Use full URL for remote APIs (e.g., `https://api.example.com`)
- **Permission errors:** Make sure the `data/` directory is writable

### State File Not Persisting

Make sure you're using absolute paths or `$(pwd)`:
```bash
# Good
-v $(pwd)/data:/data

# Bad (relative path may not work)
-v ./data:/data
```

### API Connection Issues

If you're trying to connect to a service on your host machine:

**On macOS/Windows:**
```bash
-e ARKE_API_URL=http://host.docker.internal:3000
```

**On Linux:**
```bash
--add-host=host.docker.internal:host-gateway \
-e ARKE_API_URL=http://host.docker.internal:3000
```

Or use your machine's IP address:
```bash
-e ARKE_API_URL=http://192.168.1.100:3000
```

### View Real-time Resource Usage

```bash
docker stats arke-mirror-test
```

This shows CPU, memory, and network usage.

## Testing Different Scenarios

### Test with a Fresh State

```bash
# Remove old state
rm data/mirror-state.json

# Run container
docker run --rm \
  -e ARKE_API_URL=http://host.docker.internal:3000 \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

### Test with Different API URLs

```bash
# Production API
docker run --rm \
  -e ARKE_API_URL=https://production.api.com \
  -v $(pwd)/data:/data \
  arke-mirror:latest

# Staging API
docker run --rm \
  -e ARKE_API_URL=https://staging.api.com \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

### Test Resource Limits (similar to Fly.io)

Simulate Fly.io's 256MB memory limit:
```bash
docker run -d \
  --name arke-mirror-test \
  --memory=256m \
  --cpus=1 \
  -e ARKE_API_URL=http://host.docker.internal:3000 \
  -v $(pwd)/data:/data \
  arke-mirror:latest
```

Monitor to ensure it doesn't exceed limits:
```bash
docker stats arke-mirror-test
```

## Next Steps

Once you've verified everything works locally:

1. Review the Fly.io deployment guide: `DEPLOYMENT.md`
2. Update `fly.toml` with your configuration
3. Deploy to Fly.io with `fly deploy`

## Tips

- **Keep the data directory:** Don't commit it to git (already in `.gitignore`)
- **Monitor logs regularly:** Use `docker logs -f` to watch for issues
- **Test with production-like data:** Use a copy of your production API for testing
- **Verify backoff behavior:** Watch the logs to see exponential backoff working (30s → 60s → 120s, etc.)
