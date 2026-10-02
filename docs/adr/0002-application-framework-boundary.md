# ADR 0002: Separate GPULink Core from application products

- Status: Accepted
- Date: 2026-10-01

## Context

GPULink began by proving a distributed GPU scheduler across a small physical GPU
fleet.

As the platform has matured, several distinct product directions have become
possible:

- finite GPU job scheduling;
- real-time inference;
- secure remote GPU access;
- organizational fleet management;
- external capacity sharing.

Implementing each product directly inside the GPULink control plane would couple
the scheduler to unrelated user experiences and business rules.

It would also make it difficult to determine which features are reusable
platform capabilities and which belong to one product.

CaptionLink provides the first concrete example of this distinction.

CaptionLink needs low-latency streaming speech inference, but desktop audio
capture, caption presentation, speaker UX, and accessibility behavior are not
scheduler responsibilities.

## Decision

GPULink will be treated as an application-agnostic GPU orchestration framework.

GPULink Core will own reusable compute-fabric primitives including:

- workers;
- GPU inventory;
- capabilities;
- adapter health;
- model locality;
- scheduling;
- leases;
- execution lifecycle;
- authentication;
- durable state;
- events;
- generic job and session abstractions.

Product-specific applications will consume those primitives through stable
application-facing APIs and, eventually, SDKs.

GPULink will support two architectural execution shapes:

1. finite jobs;
2. persistent sessions.

Persistent sessions will allow the control plane to allocate and supervise a GPU
resource while latency-sensitive application traffic uses a separate data plane.

CaptionLink will be the first real-time reference integration target.

Potential future reference applications include batch/HPC-style compute,
secure remote inference, organizational fleet management, and external capacity
sharing.

Those are architectural use-case categories, not committed product names.

Their product-specific business logic will not be incorporated into GPULink Core.

## Consequences

Positive consequences:

- GPULink remains reusable across unrelated applications;
- scheduling stays independent from application UX;
- real-time workloads can avoid the durable scheduler hot path;
- applications can evolve independently;
- business and marketplace logic cannot accidentally become scheduler
  dependencies;
- the platform obtains a clearer SDK/API boundary;
- each reference application can validate a different framework capability.

Costs and tradeoffs:

- a stable application-facing contract must be designed;
- session lifecycle semantics must be added;
- one or more data-plane transports must be designed;
- cross-repository compatibility may eventually require versioned SDKs;
- some early integrations may require temporary adapter-specific code before
  abstractions stabilize.

## Non-decision

This ADR does not select:

- the final session wire protocol;
- WebSocket versus QUIC versus WebRTC;
- direct versus relayed transport;
- SDK programming languages;
- marketplace architecture;
- billing systems;
- production multi-tenancy policy.

Those decisions require separate design and acceptance work.
