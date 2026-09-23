# AWS ECR Credential Provider Artifact

## Purpose

The AWS reference deployment uses the Kubernetes exec image credential
provider mechanism so the K3s kubelet can obtain short-lived credentials for
the private GPULink ECR repository.

This component is specific to the AWS deployment profile. It is not a GPULink
core dependency.

## Upstream

Project:

    kubernetes/cloud-provider-aws

Version:

    v1.36.1

Git commit:

    7656c21bcc13700566830f6bc4d753063513e6f7

Source component:

    cmd/ecr-credential-provider

## Build toolchain

Go:

    1.26.0

Target:

    linux/amd64

Builder image:

    golang

Builder OCI digest:

    sha256:4f7e5f23bfacf4c2934ba70c132532742b6a53f01a4209e2c2eb7bd06c16f0bc

The upstream Makefile target was used:

    make ecr-credential-provider-linux-amd64

The upstream build uses:

    CGO_ENABLED=0
    GOOS=linux
    GOARCH=amd64
    -trimpath

## Reproducibility verification

Two independent builds were performed using separate ephemeral build
containers.

Build 1 SHA-256:

    090e59c660d2106532a641ba58199f792e4bc076c6ebb238aabab1f1f5eff95c

Build 2 SHA-256:

    090e59c660d2106532a641ba58199f792e4bc076c6ebb238aabab1f1f5eff95c

The binaries were additionally compared byte-for-byte using cmp and were
identical.

## Accepted artifact

SHA-256:

    090e59c660d2106532a641ba58199f792e4bc076c6ebb238aabab1f1f5eff95c

The binary itself is intentionally not stored in the GPULink Git repository.

Installation must verify this checksum before the binary is placed on the
production host.
