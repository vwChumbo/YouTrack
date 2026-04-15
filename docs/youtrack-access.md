# YouTrack Access

**Instance ID:** i-0f9fe3a681f4c1d5a  
**Private IP:** 192.168.146.15  
**Access URL:** http://192.168.146.15:8080

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
