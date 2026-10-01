# GPULink Control-Plane Runtime Image

This directory defines the provider-neutral OCI runtime image for the GPULink
control plane.

The image contains the Node.js control-plane application and PostgreSQL
migration files under `src/`.

It does not contain:

- deployment credentials;
- Kubernetes configuration;
- AWS credentials;
- cloud-provider APIs or configuration;
- production database data.

Build from the repository root.

Release builds must supply a full Git revision and a traceable release tag:

    docker build \
      -f infra/images/control-plane/Dockerfile \
      --build-arg GPULINK_RELEASE_REVISION=<40-character-git-revision> \
      --build-arg GPULINK_RELEASE_TAG=<release-tag> \
      -t <oci-image-reference> \
      .

Production deployment must use the resulting immutable image digest rather
than a mutable tag.
