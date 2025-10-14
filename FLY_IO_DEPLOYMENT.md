# Fly.io Deployment Guide (Optional)

This guide shows how to deploy the Arke IPFS Mirror to Fly.io with persistent storage. This is just one option - the Docker image can be deployed to any container platform.

## Why Fly.io?

- Process keeps running (state stays in memory)
- Pay only for CPU usage (mostly idle = cheap)
- Persistent volume for crashes
- ~$2-3/month for this workload
- Simple deployment

## Prerequisites

- A Fly.io account (sign up at https://fly.io)
- Fly CLI installed on your machine

## Installation & Setup

### 1. Install Fly CLI

**macOS/Linux:**
```bash
curl -L https://fly.io/install.sh | sh
```

**Windows (PowerShell):**
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

### 2. Login to Fly.io

```bash
fly auth login
```

This will open your browser for authentication.

## Deployment Steps

### 3. Create fly.toml Configuration

Create a `fly.toml` file in your project root:

```toml
# Fly.io configuration for Arke IPFS Mirror
app = "arke-mirror"  # Change to your desired app name (must be unique)
primary_region = "iad"  # Change to your preferred region
kill_signal = "SIGINT"
kill_timeout = "5s"

[build]
  dockerfile = "Dockerfile"

[env]
  ARKE_API_URL = "https://your-api.com"  # Set your API URL
  STATE_FILE_PATH = "/data/mirror-state.json"

[mounts]
  source = "mirror_data"
  destination = "/data"

[vm]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 256  # Increase to 512 or 1024 if state file grows large

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

**Available regions:** Run `fly platform regions` to see all options (e.g., "sjc", "lhr", "syd").

### 4. Create the App

```bash
fly launch --no-deploy
```

This will:
- Create the app in Fly.io
- Set up the configuration
- Generate any missing config

**Note:** If prompted, answer:
- "Would you like to copy its configuration to the new app?" → **No**
- "Do you want to tweak these settings before proceeding?" → **No**

### 5. Create Persistent Volume

This volume will store your `mirror-state.json` file and persist across restarts:

```bash
fly volumes create mirror_data --size 1
```

**Important:** The volume name must match the `source` in the `[mounts]` section of `fly.toml`.

### 6. Set Environment Variables (Optional)

If you want to override the API URL without editing `fly.toml`:

```bash
fly secrets set ARKE_API_URL=https://your-actual-api.com
```

### 7. Deploy!

```bash
fly deploy
```

This will:
- Build the Docker image
- Push it to Fly.io
- Start your app
- Mount the persistent volume

## Monitoring & Management

### View Logs

See real-time logs:
```bash
fly logs
```

Follow logs continuously:
```bash
fly logs -f
```

### Check Status

```bash
fly status
```

### View App Info

```bash
fly info
```

### SSH into the Running Instance

```bash
fly ssh console
```

Once inside, you can:
```bash
# View the state file
cat /data/mirror-state.json

# Check disk usage
df -h /data

# View running processes
ps aux
```

### Scale Resources (if needed)

If your state file grows large or you need more memory:

```bash
fly scale memory 512  # Increase to 512 MB
fly scale memory 1024 # Or 1024 MB (1 GB)
```

### Restart the App

```bash
fly apps restart
```

## Cost Estimation

Based on Fly.io's pricing (as of 2024):

| Resource | Specs | Monthly Cost |
|----------|-------|--------------|
| Compute (shared CPU) | 256 MB RAM | ~$1.94/month |
| Persistent Volume | 1 GB | ~$0.15/month |
| **Total** | | **~$2.10/month** |

**Notes:**
- Shared CPU is perfect for this workload (mostly idle polling)
- Volume can be scaled up if needed (e.g., 5 GB = ~$0.75/month)
- First 3 shared CPU instances are free on the hobby plan!

## Updating Your Deployment

After making code changes:

```bash
# Rebuild and deploy
fly deploy

# Or, if you only changed environment variables
fly secrets set ARKE_API_URL=https://new-api.com
```

## Troubleshooting

### App Won't Start

Check logs for errors:
```bash
fly logs
```

### Volume Issues

List volumes:
```bash
fly volumes list
```

Delete and recreate (⚠️ **this will delete your state**):
```bash
fly volumes destroy mirror_data
fly volumes create mirror_data --size 1
fly deploy
```

### High Memory Usage

If you see OOM errors, scale up memory:
```bash
fly scale memory 512
```

### Change API URL

```bash
fly secrets set ARKE_API_URL=https://new-url.com
fly apps restart
```

## Advanced: Multiple Regions

To run in multiple regions for redundancy:

```bash
# Scale to 2 instances
fly scale count 2

# Add a volume in another region
fly volumes create mirror_data --region sjc --size 1
```

**Note:** Each instance maintains its own state. This is useful for geo-redundancy but means separate state files.

## Cleanup / Deletion

To completely remove your app:

```bash
# Destroy the volume (optional, to save costs)
fly volumes destroy mirror_data

# Destroy the app
fly apps destroy arke-mirror
```

## Support

- Fly.io Documentation: https://fly.io/docs/
- Fly.io Community: https://community.fly.io/
- Check app status: https://fly.io/dashboard/personal
