import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_PLANE_GRANT_AUDIENCE,
  DATA_PLANE_GRANT_MAX_TTL_MS,
  DATA_PLANE_GRANT_SCHEMA_VERSION,
  signDataPlaneGrant,
  validateDataPlaneGrantClaims,
  verifyDataPlaneGrant,
} from "../src/shared/data-plane-grant.mjs";

const signingKey =
  "test-data-plane-signing-key-that-is-at-least-32-bytes";

function claims(
  overrides = {},
) {
  return {
    schemaVersion:
      DATA_PLANE_GRANT_SCHEMA_VERSION,
    audience:
      DATA_PLANE_GRANT_AUDIENCE,
    role: "client",
    sessionId:
      "session_0123456789abcdef",
    workerId:
      "worker_0123456789abcdef",
    leaseId:
      "lease_0123456789abcdef",
    issuedAt:
      1_700_000_000_000,
    expiresAt:
      1_700_000_015_000,
    nonce:
      "grant_0123456789abcdef",
    ...overrides,
  };
}

test(
  "signs and verifies a bounded versioned data-plane grant",
  () => {
    const expected =
      validateDataPlaneGrantClaims(
        claims(),
      );

    const token =
      signDataPlaneGrant(
        expected,
        signingKey,
      );

    assert.match(
      token,
      /^gdp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );

    const verified =
      verifyDataPlaneGrant(
        token,
        signingKey,
        {
          now:
            expected.issuedAt +
            1,
        },
      );

    assert.deepEqual(
      verified,
      expected,
    );
  },
);

test(
  "rejects tampered grants and grants signed by another key",
  () => {
    const value =
      claims();

    const token =
      signDataPlaneGrant(
        value,
        signingKey,
      );

    const parts =
      token.split(".");

    const tampered =
      [
        parts[0],
        `${parts[1]}A`,
        parts[2],
      ].join(".");

    assert.equal(
      verifyDataPlaneGrant(
        tampered,
        signingKey,
        {
          now:
            value.issuedAt +
            1,
        },
      ),
      null,
    );

    assert.equal(
      verifyDataPlaneGrant(
        token,
        "different-data-plane-signing-key-that-is-long-enough",
        {
          now:
            value.issuedAt +
            1,
        },
      ),
      null,
    );
  },
);

test(
  "rejects expired and not-yet-valid data-plane grants",
  () => {
    const value =
      claims();

    const token =
      signDataPlaneGrant(
        value,
        signingKey,
      );

    assert.equal(
      verifyDataPlaneGrant(
        token,
        signingKey,
        {
          now:
            value.expiresAt,
        },
      ),
      null,
    );

    assert.equal(
      verifyDataPlaneGrant(
        token,
        signingKey,
        {
          now:
            value.issuedAt -
            1,
        },
      ),
      null,
    );
  },
);

test(
  "rejects invalid roles, extra claims, excessive lifetime, and weak keys",
  () => {
    assert.throws(
      () =>
        signDataPlaneGrant(
          claims({
            role:
              "administrator",
          }),
          signingKey,
        ),
      /role must be client or worker/u,
    );

    assert.throws(
      () =>
        signDataPlaneGrant(
          {
            ...claims(),
            endpoint:
              "wss://example.invalid",
          },
          signingKey,
        ),
      /unexpected field endpoint/u,
    );

    assert.throws(
      () =>
        signDataPlaneGrant(
          claims({
            expiresAt:
              1_700_000_000_000 +
              DATA_PLANE_GRANT_MAX_TTL_MS +
              1,
          }),
          signingKey,
        ),
      /lifetime exceeds 60 seconds/u,
    );

    assert.throws(
      () =>
        signDataPlaneGrant(
          claims(),
          "short-key",
        ),
      /at least 32 bytes/u,
    );
  },
);
