# GPULink Control-Plane TLS Contract

This document defines the TLS interface for the GPULink public control-plane
Ingress in the AWS/K3s reference deployment.

It does not contain deployment-specific certificate material.

Real private keys, certificate signing requests, issued certificates,
certificate fingerprints, account identifiers, and deployment-specific
certificate configuration must not be committed to the repository.

## Public hostname

The committed AWS Ingress manifests use the fail-closed reserved hostname:

    control-plane.gpulink.invalid

`infra/kubernetes/scripts/render-aws.sh` replaces that sentinel with the
deployment-provided public hostname.

The real hostname is deployment material and is supplied only when rendering a
deployable manifest.

## Kubernetes TLS Secret

The HTTPS Ingress expects a Kubernetes Secret named:

    control-plane-tls

in namespace:

    gpulink

The Secret must have type:

    kubernetes.io/tls

and must contain the standard Kubernetes TLS keys:

    tls.crt
    tls.key

The repository defines only this contract. It must not contain the real
certificate or private key.

## Certificate requirements

The certificate provisioned into `control-plane-tls` must:

- be valid for the deployment-provided public hostname;
- contain that hostname in `subjectAltName`;
- be within its validity period;
- include any intermediate certificates required by intended clients;
- be trusted by the worker/client systems that connect to GPULink.

The private key must correspond to the leaf certificate.

Workers must not be enrolled against the AWS endpoint until external HTTPS
validation succeeds with the intended trust chain.

## Provisioning boundary

Certificate issuance and private-key generation occur outside the public
repository.

A deployment operator may provision an already-issued certificate directly
from a secure administrative environment:

    kubectl create secret tls control-plane-tls \
      --namespace gpulink \
      --cert=/secure/path/fullchain.pem \
      --key=/secure/path/privkey.pem

The paths above are examples only. Certificate and key files must remain
outside the repository.

For replacement or automated renewal, the deployment process may construct the
same `kubernetes.io/tls` Secret through a deployment-local secret-management or
ACME workflow.

Any such workflow must preserve the same Secret name and key contract so the
committed Ingress manifest remains deployment-independent.

## HTTP and HTTPS behavior

The AWS overlay defines two routes:

- the `web` entrypoint receives HTTP requests and applies a Traefik
  `RedirectScheme` middleware that redirects them to HTTPS;
- the `websecure` entrypoint terminates TLS using `control-plane-tls` and routes
  requests to the internal `control-plane` Service on port 8088.

The control-plane Service remains `ClusterIP`. Port 8088 is not intended to be
published directly to the Internet.

## Acceptance boundary

Before physical workers are enrolled, deployment acceptance must verify:

- DNS resolves the deployment hostname to the intended AWS host;
- TCP 443 is reachable externally;
- the presented certificate is valid for the hostname;
- the certificate chain is trusted by intended workers;
- HTTP redirects to HTTPS;
- `/healthz` succeeds through public HTTPS;
- `/readyz` succeeds through public HTTPS;
- direct Internet access to port 8088 remains unavailable.
