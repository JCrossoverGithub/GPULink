# AWS cert-manager foundation

This directory defines the certificate-management foundation for the GPULink
AWS deployment.

It is deliberately separate from the normal AWS application kustomization
because installation has an explicit dependency order.

1. Apply `helmchart.yaml`.
2. Wait for cert-manager CRDs, controller, cainjector, and webhook to become
   healthy.
3. Render the deployment-local ACME contact email into
   `clusterissuer.yaml` outside Git.
4. Server-side validate and then apply the rendered ClusterIssuer.
5. Do not create the GPULink public Certificate until the public DNS cutover
   to AWS has been deliberately accepted.

## Pinned cert-manager chart

Version:

`v1.21.2`

Upstream artifact:

`https://charts.jetstack.io/charts/cert-manager-v1.21.2.tgz`

Accepted SHA-256:

`73a56e1728edd6c99f1f31082618c3259d279a76b7ebd3d4bdc5475c2442d34a`

The HelmChart does not fetch the upstream artifact directly.

Deployment tooling must:

1. download the upstream chart;
2. verify its SHA-256 against the committed value above;
3. stage those exact verified bytes on the K3s server at:

   `/var/lib/rancher/k3s/server/static/charts/cert-manager-v1.21.2.tgz`

4. only then apply the HelmChart.

The committed HelmChart consumes the staged archive through the K3s static
content endpoint:

`https://%{KUBERNETES_API}%/static/charts/cert-manager-v1.21.2.tgz`

This ensures that the artifact verified by deployment tooling is the artifact
consumed by Helm Controller, rather than allowing Helm Controller to perform
an independent second download from the upstream URL.

The chart enables Helm-managed CRDs:

```yaml
crds:
  enabled: true
  keep: true
```

The chart archive itself is deployment/runtime material and is not committed
to the GPULink repository.

## ACME ClusterIssuer

The committed issuer contains the fail-closed contact sentinel:

`acme-contact@gpulink.invalid`

It must be replaced with the deployment operator's actual ACME contact address
outside Git before application.

The issuer contract uses:

- the production Let's Encrypt ACME directory;
- a cert-manager-managed ACME account key Secret named
  `letsencrypt-production-account-key`;
- HTTP-01 validation through Traefik using
  `ingressClassName: traefik`.

No personal contact address, deployment hostname, certificate, private key,
certificate fingerprint, or ACME account key belongs in this directory.

## Bootstrap certificate boundary

The manually provisioned `control-plane-tls` Secret remains authoritative
during pre-cutover validation.

Installing cert-manager and the ClusterIssuer must not modify that Secret.

A future Certificate resource may take ownership of `control-plane-tls`
only after:

1. public DNS points the production hostname to AWS;
2. AWS HTTP/HTTPS ingress acceptance remains healthy;
3. the ClusterIssuer is Ready;
4. HTTP-01 challenge routing has been accepted.
