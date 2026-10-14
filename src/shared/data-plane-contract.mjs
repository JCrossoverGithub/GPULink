export const DATA_PLANE_PROTOCOL_VERSION = 1;

export const DATA_PLANE_PATH =
  "/v1/data-plane";

export const DATA_PLANE_SUBPROTOCOL =
  "gpulink.data-plane.v1";

export const DATA_PLANE_SUBPROTOCOL_V2 =
  "gpulink.data-plane.v2";

/* Reserved server-origin text frame, only on opt-in v2 sockets. */
export const DATA_PLANE_RELAY_READY_V2 =
  "gpulink.relay.ready.v2";

export const DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX =
  "gpulink.grant.";

export const DATA_PLANE_MAX_FRAME_BYTES =
  1_048_576;

export const DATA_PLANE_MAX_BUFFERED_BYTES =
  4_194_304;

export const DATA_PLANE_PEER_WAIT_TIMEOUT_MS =
  10_000;

export const DATA_PLANE_IDLE_TIMEOUT_MS =
  30_000;

export const DATA_PLANE_CLOSE_CODES =
  Object.freeze({
    NORMAL: 1000,
    PROTOCOL_ERROR: 1002,
    MESSAGE_TOO_BIG: 1009,
    INTERNAL_ERROR: 1011,
    TRY_AGAIN_LATER: 1013,
    UNAUTHORIZED: 4401,
    PEER_TIMEOUT: 4408,
    DUPLICATE_ROLE: 4409,
    LEASE_INVALIDATED: 4410,
  });

export function createDataPlaneProtocols(
  grant,
) {
  const normalizedGrant =
    requireGrant(
      grant,
    );

  return [
    DATA_PLANE_SUBPROTOCOL,
    `${DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX}${normalizedGrant}`,
  ];
}

export function parseDataPlaneProtocols(
  header,
) {
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    header.length > 8_192
  ) {
    return null;
  }

  const values =
    header
      .split(",")
      .map(
        (value) =>
          value.trim(),
      )
      .filter(Boolean);

  const protocol =
    values.find(
      (value) =>
        value === DATA_PLANE_SUBPROTOCOL ||
        value === DATA_PLANE_SUBPROTOCOL_V2,
    );

  if (
    values.length !== 2 ||
    new Set(values).size !== 2 ||
    !protocol
  ) {
    return null;
  }

  const grantProtocol =
    values.find(
      (value) =>
        value.startsWith(
          DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX,
        ),
    );

  if (!grantProtocol) {
    return null;
  }

  const grant =
    grantProtocol.slice(
      DATA_PLANE_GRANT_SUBPROTOCOL_PREFIX.length,
    );

  try {
    requireGrant(
      grant,
    );
  } catch {
    return null;
  }

  return Object.freeze({
    protocol,
    grant,
  });
}

export function validateDataPlaneFrameSize(
  byteLength,
) {
  if (
    !Number.isSafeInteger(
      byteLength,
    ) ||
    byteLength < 0
  ) {
    throw new TypeError(
      "data-plane frame byte length must be a non-negative safe integer",
    );
  }

  if (
    byteLength >
    DATA_PLANE_MAX_FRAME_BYTES
  ) {
    return false;
  }

  return true;
}

export function isDataPlaneBackpressured(
  bufferedAmount,
) {
  if (
    !Number.isSafeInteger(
      bufferedAmount,
    ) ||
    bufferedAmount < 0
  ) {
    throw new TypeError(
      "data-plane buffered amount must be a non-negative safe integer",
    );
  }

  return (
    bufferedAmount >
    DATA_PLANE_MAX_BUFFERED_BYTES
  );
}

function requireGrant(
  grant,
) {
  if (
    typeof grant !== "string" ||
    grant.length === 0 ||
    grant.length > 4_096 ||
    !/^gdp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
      grant,
    )
  ) {
    throw new TypeError(
      "data-plane grant token is invalid",
    );
  }

  return grant;
}
