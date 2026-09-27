# AWS pgBackRest Backup Automation

This directory defines host-side PostgreSQL backup scheduling for the GPULink
AWS reference deployment.

The repository host owns S3 access through its EC2 instance role. Kubernetes
database and restore-verification workloads do not receive AWS credentials.

## Schedule

The systemd timer runs daily at 02:00 UTC with up to 15 minutes of randomized
delay.

The backup runner selects:

- full backup on Sunday UTC;
- incremental backup Monday through Saturday.

The repository's pgBackRest retention policy remains authoritative.

## Installation

Run `install.sh` as root on the repository host.

Installation copies:

- `backup.sh` to `/usr/local/sbin/gpulink-pgbackrest-backup`;
- the service and timer to `/etc/systemd/system`.

The installer deliberately does not enable the timer.

Before enabling recurring execution:

1. verify the installed unit definitions;
2. manually start `gpulink-postgres-backup.service`;
3. confirm a new valid backup appears in pgBackRest;
4. confirm production PostgreSQL remains healthy;
5. only then enable `gpulink-postgres-backup.timer`.

Deployment-specific repository, S3, network, and TLS values remain in the
host's `/etc/pgbackrest/pgbackrest.conf` and are not committed here.

## First activation and persistent timers

The timer uses `Persistent=true` so a backup missed while the host is offline
can run after the host returns.

During first deployment, if the scheduled time has already passed and a manual
backup was just completed for acceptance, initialize the timer stamp before
starting the timer to avoid an unnecessary immediate catch-up backup:

    sudo install \
      -o root \
      -g root \
      -m 0644 \
      /dev/null \
      /var/lib/systemd/timers/stamp-gpulink-postgres-backup.timer

    sudo touch \
      /var/lib/systemd/timers/stamp-gpulink-postgres-backup.timer

    sudo systemctl enable --now gpulink-postgres-backup.timer

This stamp initialization is only a first-activation/bootstrap procedure.
Normal later operation should retain `Persistent=true` so genuinely missed
scheduled backups can be caught up after downtime.
