import assert from "node:assert/strict";
import test from "node:test";

import {
  createDataPlaneProtocols,
  DATA_PLANE_CLOSE_CODES,
  DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX,
  DATA_PLANE_IDLE_TIMEOUT_MS,
  DATA_PLANE_MAX_BUFFERED_BYTES,
  DATA_PLANE_MAX_FRAME_BYTES,
  DATA_PLANE_PATH,
  DATA_PLANE_PEER_WAIT_TIMEOUT_MS,
  DATA_PLANE_PROTOCOL_VERSION,
  DATA_PLANE_SUBPROTOCOL,
  isDataPlaneBackpressured,
  parseDataPlaneProtocols,
  validateDataPlaneFrameSize,
} from "../src/shared/data-plane-contract.mjs";

const grant =
  "gdp1.eyJ0ZXN0Ijp0cnVlfQ.signature_123";

test(
  "data-plane wire vocabulary is versioned and bounded",
  () => {
    assert.equal(
      DATA_PLANE_PROTOCOL_VERSION,
      1,
    );

    assert.equal(
      DATA_PLANE_PATH,
      "/v1/data-plane",
    );

    assert.equal(
      DATA_PLANE_SUBPROTOCOL,
      "gpulink.data-plane.v1",
    );

    assert.equal(
      DATA_PLANE_MAX_FRAME_BYTES,
      1_048_576,
    );

    assert.equal(
      DATA_PLANE_MAX_BUFFERED_BYTES,
      4_194_304,
    );

    assert.equal(
      DATA_PLANE_PEER_WAIT_TIMEOUT_MS,
      10_000,
    );

    assert.equal(
      DATA_PLANE_IDLE_TIMEOUT_MS,
      30_000,
    );
  },
);

test(
  "creates and parses a grant-bearing WebSocket protocol offer",
  () => {
    const protocols =
      createDataPlaneProtocols(
        grant,
      );

    assert.deepEqual(
      protocols,
      [
        DATA_PLANE_SUBPROTOCOL,
        `${DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX}${grant}`,
      ],
    );

    assert.deepEqual(
      parseDataPlaneProtocols(
        protocols.join(", "),
      ),
      {
        protocol:
          DATA_PLANE_SUBPROTOCOL,
        grant,
      },
    );

    assert.deepEqual(
      parseDataPlaneProtocols(
        protocols
          .toReversed()
          .join(", "),
      ),
      {
        protocol:
          DATA_PLANE_SUBPROTOCOL,
        grant,
      },
    );
  },
);

test(
  "rejects ambiguous or malformed WebSocket protocol offers",
  () => {
    assert.equal(
      parseDataPlaneProtocols(
        "",
      ),
      null,
    );

    assert.equal(
      parseDataPlaneProtocols(
        DATA_PLANE_SUBPROTOCOL,
      ),
      null,
    );

    assert.equal(
      parseDataPlaneProtocols(
        `${DATA_PLANE_SUBPROTOCOL}, ${DATA_PLANE_SUBPROTOCOL}`,
      ),
      null,
    );

    assert.equal(
      parseDataPlaneProtocols(
        `${DATA_PLANE_SUBPROTOCOL}, gpulink.grant.not-a-grant`,
      ),
      null,
    );

    assert.equal(
      parseDataPlaneProtocols(
        `${DATA_PLANE_SUBPROTOCOL}, ${DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX}${grant}, extra`,
      ),
      null,
    );
  },
);

test(
  "enforces frame and buffered-byte bounds",
  () => {
    assert.equal(
      validateDataPlaneFrameSize(
        DATA_PLANE_MAX_FRAME_BYTES,
      ),
      true,
    );

    assert.equal(
      validateDataPlaneFrameSize(
        DATA_PLANE_MAX_FRAME_BYTES +
          1,
      ),
      false,
    );

    assert.equal(
      isDataPlaneBackpressured(
        DATA_PLANE_MAX_BUFFERED_BYTES,
      ),
      false,
    );

    assert.equal(
      isDataPlaneBackpressured(
        DATA_PLANE_MAX_BUFFERED_BYTES +
          1,
      ),
      true,
    );

    assert.throws(
      () =>
        validateDataPlaneFrameSize(
          -1,
        ),
      /non-negative safe integer/u,
    );

    assert.throws(
      () =>
        isDataPlaneBackpressured(
          Number.NaN,
        ),
      /non-negative safe integer/u,
    );
  },
);

test(
  "reserves explicit relay close semantics",
  () => {
    assert.deepEqual(
      DATA_PLANE_CLOSE_CODES,
      {
        NORMAL: 1000,
        PROTOCOL_ERROR: 1002,
        MESSAGE_TOO_BIG: 1009,
        INTERNAL_ERROR: 1011,
        TRY_AGAIN_LATER: 1013,
        UNAUTHORIZED: 4401,
        PEER_TIMEOUT: 4408,
        DUPLICATE_ROLE: 4409,
        LEASE_INVALIDATED: 4410,
      },
    );
  },
);
