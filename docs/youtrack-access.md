# YouTrack Access

**YouTrack Version:** Latest (see ECR tag)  
**Image Location:** 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest

**Instance ID:** i-0f9fe3a681f4c1d5a  
**Private IP:** 192.168.146.15  
**Access URL:** http://192.168.146.15:8080

To get current details:
```bash
aws cloudformation describe-stacks --stack-name YouTrackStack --region eu-west-1 --query 'Stacks[0].Outputs'
```

**Status:** ✅ Running and accessible

## Connecting via SSM

```bash
aws ssm start-session --target i-0f9fe3a681f4c1d5a --region eu-west-1
```

## Admin Access

- **Initial setup:** Navigate to http://192.168.146.15:8080
- **Admin credentials:** Set during YouTrack setup wizard
- **Hosts file entry (if needed):**
  ```
  192.168.146.15  youtrack.local
  ```
  Then access via http://youtrack.local:8080

## Checking Status

Connect via SSM and run:

```bash
# Check Docker is running
docker --version
sudo systemctl status docker

# Check YouTrack container status
docker ps | grep youtrack

# View YouTrack logs
docker logs youtrack

# Check if YouTrack port is listening
sudo netstat -tlnp | grep 8080

# View UserData execution log
sudo cat /var/log/cloud-init-output.log
sudo cat /var/log/youtrack-setup.log
```

## Maintenance

### Restart YouTrack
```bash
docker restart youtrack
```

### View YouTrack logs
```bash
docker logs -f youtrack
```

### Stop/Start Instance
Use AWS Console or CLI:
```bash
# Stop instance (data persists on root volume)
aws ec2 stop-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1

# Start instance
aws ec2 start-instances --instance-ids i-0f9fe3a681f4c1d5a --region eu-west-1
```

Note: Instance IP may change after stop/start. Check outputs with:
```bash
aws cloudformation describe-stacks --stack-name YouTrackStack --region eu-west-1 --query 'Stacks[0].Outputs'
```

## Data Storage

- **Location:** `/var/youtrack-data` on 30GB root volume
- **Backup:** Create AMI or snapshot of instance before major changes
- **Persistence:** Data persists across container restarts and instance reboots

## Troubleshooting

### Container not running
```bash
# Check container status
docker ps -a | grep youtrack

# Check container logs for errors
docker logs youtrack

# Restart container
docker restart youtrack

# If container exited, check why
docker inspect youtrack
```

### Cannot access port 8080
```bash
# Verify port is listening
sudo netstat -tlnp | grep 8080

# Check security group allows traffic
aws ec2 describe-security-groups --region eu-west-1 --filters "Name=tag:Name,Values=YouTrackStack-youtrack-sg"

# Test from within the instance
curl -I http://localhost:8080
```

### Docker not installed
```bash
# Check UserData execution
sudo cat /var/log/cloud-init-output.log

# Manually install Docker if needed
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker
```

## Upgrading YouTrack

Use the update script to upgrade YouTrack. It handles ECR push and container restart automatically.

### Using the update script (recommended)

```bash
# Check current version in ECR
./scripts/update-youtrack-image.sh --check-only

# Upgrade to a new version (pulls from Docker Hub, pushes to ECR, restarts container via SSM)
./scripts/update-youtrack-image.sh <NEW_VERSION>
# e.g. ./scripts/update-youtrack-image.sh 2026.2.1000
```

The script will:
1. Show current ECR state
2. Check if the version already exists in ECR (skips pull if it does)
3. Pull from Docker Hub → push to ECR with version tag + retag `latest`
4. Restart the container on EC2 via SSM (no manual SSM session needed)
5. Show final ECR state confirming the update

**Note:** Docker Hub may be blocked by the Zscaler proxy on the corporate network. Run the script from a machine with internet access if Docker Hub pulls fail.

### Manual upgrade (if script is not available)

```bash
# 1. Push new image to ECR from a machine with Docker and internet access
docker pull jetbrains/youtrack:<VERSION>
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin 640664844884.dkr.ecr.eu-west-1.amazonaws.com
docker tag jetbrains/youtrack:<VERSION> 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:<VERSION>
docker tag jetbrains/youtrack:<VERSION> 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest
docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:<VERSION>
docker push 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest

# 2. Restart container on EC2 via SSM session
aws ssm start-session --target <INSTANCE_ID> --region eu-west-1
# Then inside the session:
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 640664844884.dkr.ecr.eu-west-1.amazonaws.com
docker pull 640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest
docker stop youtrack && docker rm youtrack
docker run -d --name youtrack --restart=always --user 13001:13001 \
  -p 8080:8080 \
  -v /var/youtrack-data/data:/opt/youtrack/data \
  -v /var/youtrack-data/conf:/opt/youtrack/conf \
  -v /var/youtrack-data/logs:/opt/youtrack/logs \
  -v /var/youtrack-data/backups:/opt/youtrack/backups \
  640664844884.dkr.ecr.eu-west-1.amazonaws.com/youtrack:latest
```

## Current Configuration

- **Image Registry:** AWS ECR (640664844884.dkr.ecr.eu-west-1.amazonaws.com)
- **Repository:** youtrack
- **Tag:** `:latest` (check ECR console for current deployed version)
- **Data Location:** /var/youtrack-data on 30GB root volume
- **Network:** Private IP only, port 8080
- **Access Method:** SSM Session Manager (no SSH)
