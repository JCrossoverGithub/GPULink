# pgBackRest mTLS Contract for the AWS Overlay

This document defines the certificate interface expected by the GPULink AWS
reference deployment.

It does not define or contain deployment certificate material.

Real private keys, certificate signing requests, issued certificates, CA
private keys, serial files, fingerprints, and generated Kubernetes Secret
manifests must never be committed to this repository.

## Trust model

pgBackRest communication uses mutual TLS between two logical roles:

- database side
- repository side

Each deployment provisions its own private CA and leaf certificates.

The reference identity convention is:

    database client CN:    gpulink-database
    repository client CN:  gpulink-repository

These names describe logical pgBackRest roles. They are not tied to a specific
issued certificate, machine, AWS account, cluster, or operator.

Deployments may use different client CNs, but the corresponding
`tls-server-auth` configuration must be changed to match.

## Server certificate names

Server certificates must contain Subject Alternative Names matching the
address used by the peer to connect.

For example, a deployment might use:

    IP:<database-side service address>

or:

    DNS:<database-side DNS name>

for the database-side pgBackRest server, and:

    IP:<repository-host address>

or:

    DNS:<repository-host DNS name>

for the repository-side server.

The public repository does not prescribe those deployment-specific addresses.

## Kubernetes database-side Secret

The AWS PostgreSQL workload expects a Kubernetes Secret named:

    postgres-pgbackrest-tls

in namespace:

    gpulink

It contains the database-side material:

    ca.crt
    server.crt
    server.key
    client.crt
    client.key

Certificate intent:

- `ca.crt`
  - public certificate of the deployment's pgBackRest CA

- `server.crt` / `server.key`
  - database-side pgBackRest TLS server identity
  - presented to the repository host

- `client.crt` / `client.key`
  - database-side pgBackRest TLS client identity
  - presented when connecting to the repository host
  - reference client CN: `gpulink-database`

The database-side TLS server in the reference configuration authorizes the
repository role:

    gpulink-repository

for only:

    gpulink

## Repository-host material

The repository host receives its own deployment-generated:

    ca.crt
    server.crt
    server.key
    client.crt
    client.key

The repository server should authorize the database-side client role:

    gpulink-database

for only:

    gpulink

Repository-host private keys are not Kubernetes Secrets and are not committed
to this repository.

## Cloud credential boundary

The PostgreSQL workload must not receive:

- AWS access keys
- AWS secret access keys
- AWS session tokens
- EC2 instance-role credentials
- IMDS access
- Kubernetes registry credential Secrets

AWS/S3 authentication remains on the trusted repository-host boundary.

mTLS certificates authenticate pgBackRest peers. They are application
authentication material, not AWS credentials.

## Certificate generation

The repository contains:

    infra/kubernetes/scripts/generate-pgbackrest-mtls.sh

as reusable development/operator tooling.

The script:

- accepts deployment-specific server SANs as arguments;
- generates deployment-specific certificate material outside the repository;
- uses the reference logical client identities by default;
- allows those identities to be overridden;
- refuses to place generated PKI material inside the Git work tree.

Operators may also use an existing organizational PKI instead of this script,
provided the resulting certificates satisfy this contract.

## Provisioning rule

Generated material is provisioned out of band.

Do not commit commands such as:

    kubectl create secret ... --dry-run=client -o yaml > secret.yaml

when the resulting YAML contains real certificate or private-key values.

The Secret may be created directly from local files at deployment time instead.

## Repository endpoint configuration

The repository server address is deployment-specific and is not embedded in
the database-side server configuration committed to this repository.

During the backup-server phase, the database-side pgBackRest process only
needs to accept authenticated pgBackRest protocol connections from the
repository host.

When WAL archival is enabled, the deployment must provide the repository
endpoint used by the database-side pgBackRest client. That endpoint may be an
IP address or DNS name appropriate to that deployment.

The endpoint must not be assumed to be the address of the GPULink reference
AWS deployment.

## TLS repository-host behavior

When a repository host uses the pgBackRest TLS protocol, configure:

    repoN-host=<repository endpoint>
    repoN-host-type=tls
    repoN-host-port=8432
    repoN-host-ca-file=<CA certificate>
    repoN-host-cert-file=<client certificate>
    repoN-host-key-file=<client private key>

Do not set `repoN-host-user` for a TLS repository host. In pgBackRest 2.59.1,
that option is valid for SSH transport rather than TLS transport.

For TLS transport, peer identity is established by the client certificate and
the server's `tls-server-auth` mapping.

## Mutual-TLS acceptance

Before enabling WAL archival, a deployment should prove both protocol
directions independently:

1. Repository to database:
   - run `stanza-create` from the repository host;
   - the database-side pgBackRest TLS server must authorize the repository
     client certificate;
   - PostgreSQL must be reachable through the database-side pgBackRest process.

2. Database to repository:
   - run a read-only repository command such as `info` or `repo-ls` from the
     database-side pgBackRest process using the repository TLS endpoint;
   - the repository TLS server must authorize the database client certificate.

A newly created stanza may report that no valid backups or WAL archive entries
exist. That is expected until the first backup and WAL archival are completed.

TLS transport acceptance must not require enabling `archive_mode`.

## WAL archive repository endpoint

Continuous WAL archiving requires the PostgreSQL-side pgBackRest client to know
the repository service endpoint.

The endpoint is deployment-local and MUST NOT be hard-coded into the reusable
AWS overlay. Before enabling the archive-enabled StatefulSet, the deployment
must provide:

    ConfigMap: postgres-pgbackrest-repository-endpoint
    Namespace: gpulink
    Key: host

The value must be an IP address or DNS name covered by the repository server
certificate's subjectAltName.

Example deployment operation:

    kubectl create configmap postgres-pgbackrest-repository-endpoint \
      --namespace gpulink \
      --from-literal=host=<repository-endpoint> \
      --dry-run=client -o yaml | kubectl apply -f -

The main PostgreSQL container receives this value as
`GPULINK_PGBACKREST_REPOSITORY_HOST`. The archive wrapper passes it explicitly
to pgBackRest as `--repo1-host`.

The Kubernetes workload receives no object-storage credentials. WAL is sent
over mutually authenticated pgBackRest TLS to the repository service, and the
repository host performs object-storage access using its deployment-specific
credential mechanism.

The archive client receives only the CA certificate and database client
certificate/key. It does not require the database-side pgBackRest server
private key.
