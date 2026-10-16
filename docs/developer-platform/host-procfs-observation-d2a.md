# DP3C3B2C2D2A — Linux host process-state observation (test-only)

**Starting point:** accepted and locally committed DP3C3B2C2D1,
`c4a23d9f27ab7241a1fad6c76247a0cd07fba94f`. No production or GPU execution change.

## Scope and trust contract

D1 observes *control-plane allocation state*. D2A provides **read-only Linux
`/proc` observations** for an *operator-provisioned test hint* identifying an
individual PID birth. Neither is evidence that a workload was launched by
GPULink, is isolated from other processes, has no descendants, or no longer
uses a GPU. A PID alone is not an execution identity.

The opt-in `observe-host` operation accepts **only** `attemptId` from a Linux
Unix-socket client. The broker derives all other fields from its private
`remote_claims` journal and a test-only root/operator-managed witness file.
The broker authenticates its client with `SO_PEERCRED` as before. The observer
requires a locally acknowledged positive epoch and an exact match of
`attemptId`, `workerId`, `leaseId`, and `fenceEpoch` before inspecting `/proc`.
The observer checks boot ID, procfs PID birth ticks, and cgroup-v2 membership,
then reads the birth ticks and boot ID again. A missing PID or reused PID is
`absent` **only for that single proc identity**, not proof of cleanup. A boot
mismatch, inaccessible procfs, changed cgroup, zombie process, or incomplete
claim is `unknown`.

All responses have `operatorHintOnly:true`, `authorityConfirmed:false`,
`cleanupVerified:false`, `canRelease:false`, and `canLaunch:false`. No
observation is written to the journal or sent to the control plane, no GPU
fence is cleared, no runtime or process is launched, and no release operation
is implemented. No PID is exposed to the worker response.

## Operator witness format

An *optional* `--host-witness-file` argument is accepted by the already
`--test-only`-gated Linux broker. It requires `--authority-config`. The
operator-provisioned file is a regular file owned by the broker OS UID, mode
`0600` or stricter (no group/other access), with no symlink leaf.

```json
{
  "schemaVersion": 1,
  "witnesses": [
    {
      "attemptId": "example-test-attempt",
      "workerId": "example-test-worker",
      "leaseId": "example-test-lease",
      "fenceEpoch": 1,
      "bootId": "00000000-0000-0000-0000-000000000000",
      "pid": 12345,
      "startTicks": 123456,
      "cgroupV2": "/example-test-cgroup"
    }
  ]
}
```

This example intentionally contains *nonfunctional placeholder identifiers*.
All real values must be provisioned out of band in a private runtime directory.
This is **not a signed attestation** and must never be accepted by a future
release endpoint as evidence. Changing an operator hint cannot establish
ownership of arbitrary runtime processes. GPULink does not currently record
process birth identities during a managed launch because launch is disabled.
Therefore, **existing D1 claims with no operator witness return `unknown`**.

## Next safety gates

D2B must define and test an authenticated broker-created birth witness from an
operator-approved runtime, with host boot identity, stable runtime/cgroup
ownership, verified process lifetime, and crash/restart durability. Before any
real release: independently verify termination of the complete runtime/cgroup,
confirm no device handles/descendants and exact current fence epoch, reject
stale observations, and atomically update attempt + resource fence under the
shared scheduler lock. Unobservable or ambiguous conditions remain quarantined.

## Acceptance criteria

- Source baseline must be the clean local D1 commit SHA, no uncommitted files.
- The test-only Unix peer and credential scope are unchanged.
- Unit and HTTP end-to-end tests prove present, identity-absent, unknown,
  stale epoch, boot change, restart, malformed input, wrong peer and bad file
  permissions; none can change the held GPU fence.
- Full root, SDK and disposable PostgreSQL suites must pass on JPCMAIN.
- No new migrations, deployment changes, worker runtime launch or release.
