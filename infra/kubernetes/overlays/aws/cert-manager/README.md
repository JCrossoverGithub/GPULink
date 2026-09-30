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
5. Wait for the production ClusterIssuer to become Ready.
6. Cut public DNS over to the AWS ingress and accept public HTTP/HTTPS
   behavior before requesting a production certificate.
7. Render `certificate.yaml` with the deployment hostname outside Git.
8. Server-side validate the rendered Certificate before applying it.
9. Apply the Certificate and wait for successful issuance before accepting
   cert-manager as the steady-state owner of `control-plane-tls`.
10. Revalidate public HTTPS after the Secret has been updated.

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

## Public Certificate

`certificate.yaml` defines the steady-state certificate-management contract
for the public GPULink control plane.

The committed resource is deliberately fail-closed and contains the reserved
hostname sentinel:

`control-plane.gpulink.invalid`

It targets the existing TLS Secret:

`gpulink/control-plane-tls`

and references the cluster-scoped issuer:

`letsencrypt-production`

The private-key policy is:

```yaml
privateKey:
  rotationPolicy: Always
```

The real public hostname must not be committed to this file.

Render a deployment-local manifest with:

```text
infra/kubernetes/scripts/render-aws-certificate.sh <public-hostname>
```

The rendered output must remain outside Git, for example under `.local/`.

The dedicated renderer is intentionally separate from `render-aws.sh`.
The normal AWS application renderer has its own fixed hostname-sentinel
contract and must not acquire cert-manager lifecycle resources.

## Bootstrap-to-managed ownership boundary

Before the Certificate is applied, the manually provisioned
`control-plane-tls` Secret remains authoritative.

Installing cert-manager and registering the ClusterIssuer must not modify that
Secret.

The Certificate may be applied only after:

1. authoritative public DNS points the production hostname to AWS;
2. the AWS HTTP and HTTPS ingress paths are externally healthy;
3. the production ClusterIssuer is Ready;
4. no unexpected Certificate, CertificateRequest, Order, or Challenge
   resources already exist;
5. the deployment-local Certificate manifest passes server-side validation.

The Certificate deliberately uses the same `control-plane-tls` Secret already
referenced by the committed HTTPS Ingress. Successful certificate issuance
therefore transitions that stable Secret interface from bootstrap provisioning
to cert-manager-managed renewal without changing the Ingress contract.

After issuance, deployment acceptance must verify the Certificate is Ready,
the resulting Secret remains `kubernetes.io/tls`, the certificate matches the
public hostname, the public trust chain succeeds, and `/healthz` and `/readyz`
remain healthy through normal public DNS.

The bootstrap certificate source should not be removed from its secure
deployment-local recovery location until the cert-manager-managed path has
been accepted and an explicit rollback policy has been established.
