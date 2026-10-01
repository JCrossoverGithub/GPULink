# GPULink Control-Plane TLS Contract

This document defines the TLS interface for the GPULink public control-plane
Ingress in the AWS/K3s reference deployment.

It does not contain deployment-specific certificate material.

Real private keys, certificate signing requests, issued certificates,
certificate fingerprints, account identifiers, deployment-specific hostnames,
and deployment-specific ACME contact information must not be committed to the
repository.

## Public hostname

The committed AWS Ingress manifests use the fail-closed reserved hostname:

    control-plane.gpulink.invalid

`infra/kubernetes/scripts/render-aws.sh` replaces that sentinel with the
deployment-provided public hostname for the normal AWS application resources.

The committed cert-manager Certificate template uses the same fail-closed
hostname sentinel but is rendered separately with:

    infra/kubernetes/scripts/render-aws-certificate.sh <public-hostname>

The Certificate renderer is deliberately separate from the normal AWS
application renderer so certificate lifecycle operations remain an explicit
deployment step.

The real hostname is deployment material and is supplied only when rendering
deployable manifests.

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

The repository defines only this Secret interface. It must not contain the
real certificate or private key.

The Secret name remains stable across bootstrap provisioning and cert-manager
steady-state management.

## Certificate requirements

The certificate stored in `control-plane-tls` must:

- be valid for the deployment-provided public hostname;
- contain that hostname in `subjectAltName`;
- be within its validity period;
- include any intermediate certificates required by intended clients;
- be trusted by the worker/client systems that connect to GPULink.

The private key must correspond to the leaf certificate.

Workers must not be enrolled against the AWS endpoint until external HTTPS
validation succeeds with the intended trust chain.

## Bootstrap provisioning boundary

Initial AWS ingress acceptance may use an already-issued bootstrap certificate
provisioned from a secure administrative environment:

    kubectl create secret tls control-plane-tls \
      --namespace gpulink \
      --cert=/secure/path/fullchain.pem \
      --key=/secure/path/privkey.pem

The paths above are examples only. Certificate and key files must remain
outside the repository.

Bootstrap provisioning exists to make the AWS HTTPS endpoint independently
testable before public DNS is moved from the previous production endpoint.

The bootstrap Secret remains authoritative until the cert-manager Certificate
transition is deliberately accepted.

## cert-manager steady-state boundary

The AWS reference deployment uses cert-manager for automated public certificate
issuance and renewal after DNS cutover.

The source contracts live under:

    infra/kubernetes/overlays/aws/cert-manager/

The committed Certificate template:

- targets `gpulink/control-plane-tls`;
- references the `letsencrypt-production` ClusterIssuer;
- contains only the reserved hostname sentinel;
- uses `privateKey.rotationPolicy: Always`.

The Certificate must not be applied until:

1. public DNS authoritatively points the deployment hostname to AWS;
2. the AWS HTTP and HTTPS ingress paths are externally healthy;
3. cert-manager is healthy;
4. the production ClusterIssuer is Ready;
5. the deployment-local Certificate manifest passes server-side validation.

The Certificate uses the same Secret interface as bootstrap provisioning.
The committed HTTPS Ingress therefore does not need to change when certificate
management transitions to cert-manager.

After issuance, the deployment must verify the new certificate and public
HTTPS behavior before treating cert-manager as the accepted steady-state
certificate owner.

The secure bootstrap certificate source may be retained temporarily as
rollback material. Its later retirement is an explicit operational decision
and is not part of certificate issuance itself.

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
- direct Internet access to port 8088 remains unavailable;
- the production cert-manager Certificate is Ready once steady-state
  certificate management has been enabled.

## Current reference-deployment acceptance

The contracts in this document remain requirements for a fresh deployment.

The current AWS reference deployment has exercised this path successfully:

- public DNS reached the intended AWS ingress;
- HTTP redirected to HTTPS;
- the public HTTPS endpoint passed trust and health checks;
- cert-manager became the steady-state certificate owner;
- JPCMAIN subsequently completed the first accepted physical GPU workload
  through that public endpoint.

Future deployments must still satisfy the prerequisites in this document before
worker enrollment. This acceptance does not weaken the fail-closed hostname,
Secret, or deployment-local certificate-material boundaries.
