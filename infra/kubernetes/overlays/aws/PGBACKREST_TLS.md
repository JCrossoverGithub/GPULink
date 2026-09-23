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
