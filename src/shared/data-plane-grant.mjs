import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const DATA_PLANE_GRANT_SCHEMA_VERSION = 1;

export const DATA_PLANE_GRANT_AUDIENCE =
  "gpulink-data-plane";

export const DATA_PLANE_GRANT_ROLES =
  Object.freeze([
    "client",
    "worker",
  ]);

export const DATA_PLANE_GRANT_MAX_TTL_MS =
  60_000;

export const DATA_PLANE_GRANT_MAX_TOKEN_BYTES =
  4_096;

const TOKEN_PREFIX = "gdp1";

const CLAIM_FIELDS =
  Object.freeze([
    "schemaVersion",
    "audience",
    "role",
    "sessionId",
    "workerId",
    "leaseId",
    "issuedAt",
    "expiresAt",
    "nonce",
  ]);

export function signDataPlaneGrant(
  value,
  signingKey,
) {
  const claims =
    validateDataPlaneGrantClaims(
      value,
    );

  const key =
    validateSigningKey(
      signingKey,
    );

  const payload =
    Buffer.from(
      JSON.stringify(claims),
      "utf8",
    ).toString("base64url");

  const signed =
    `${TOKEN_PREFIX}.${payload}`;

  const signature =
    createHmac(
      "sha256",
      key,
    )
      .update(
        signed,
        "utf8",
      )
      .digest("base64url");

  const token =
    `${signed}.${signature}`;

  if (
    Buffer.byteLength(
      token,
      "utf8",
    ) >
    DATA_PLANE_GRANT_MAX_TOKEN_BYTES
  ) {
    throw new Error(
      "data-plane grant exceeds maximum token size",
    );
  }

  return token;
}

export function verifyDataPlaneGrant(
  token,
  signingKey,
  {
    now = Date.now(),
  } = {},
) {
  const key =
    validateSigningKey(
      signingKey,
    );

  if (
    typeof token !== "string" ||
    token.length === 0 ||
    Buffer.byteLength(
      token,
      "utf8",
    ) >
      DATA_PLANE_GRANT_MAX_TOKEN_BYTES
  ) {
    return null;
  }

  if (
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new TypeError(
      "data-plane grant verification time must be a non-negative safe integer",
    );
  }

  const parts =
    token.split(".");

  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX
  ) {
    return null;
  }

  const [
    prefix,
    payload,
    suppliedSignature,
  ] = parts;

  if (
    !isBase64Url(payload) ||
    !isBase64Url(
      suppliedSignature,
    )
  ) {
    return null;
  }

  const expectedSignature =
    createHmac(
      "sha256",
      key,
    )
      .update(
        `${prefix}.${payload}`,
        "utf8",
      )
      .digest("base64url");

  const supplied =
    Buffer.from(
      suppliedSignature,
      "utf8",
    );

  const expected =
    Buffer.from(
      expectedSignature,
      "utf8",
    );

  if (
    supplied.length !==
      expected.length ||
    !timingSafeEqual(
      supplied,
      expected,
    )
  ) {
    return null;
  }

  let parsed;

  try {
    parsed =
      JSON.parse(
        Buffer.from(
          payload,
          "base64url",
        ).toString("utf8"),
      );
  } catch {
    return null;
  }

  let claims;

  try {
    claims =
      validateDataPlaneGrantClaims(
        parsed,
      );
  } catch {
    return null;
  }

  if (
    claims.issuedAt > now ||
    claims.expiresAt <= now
  ) {
    return null;
  }

  return claims;
}

export function validateDataPlaneGrantClaims(
  value,
) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "data-plane grant claims must be an object",
    );
  }

  const unexpected =
    Object.keys(value)
      .filter(
        (key) =>
          !CLAIM_FIELDS.includes(
            key,
          ),
      );

  if (unexpected.length > 0) {
    throw new TypeError(
      `data-plane grant claims contain unexpected field ${unexpected[0]}`,
    );
  }

  if (
    value.schemaVersion !==
      DATA_PLANE_GRANT_SCHEMA_VERSION
  ) {
    throw new TypeError(
      "data-plane grant schemaVersion must be 1",
    );
  }

  if (
    value.audience !==
      DATA_PLANE_GRANT_AUDIENCE
  ) {
    throw new TypeError(
      "data-plane grant audience is invalid",
    );
  }

  if (
    !DATA_PLANE_GRANT_ROLES.includes(
      value.role,
    )
  ) {
    throw new TypeError(
      "data-plane grant role must be client or worker",
    );
  }

  const sessionId =
    boundedString(
      value.sessionId,
      "data-plane grant sessionId",
      200,
    );

  const workerId =
    boundedString(
      value.workerId,
      "data-plane grant workerId",
      200,
    );

  const leaseId =
    boundedString(
      value.leaseId,
      "data-plane grant leaseId",
      200,
    );

  const nonce =
    boundedString(
      value.nonce,
      "data-plane grant nonce",
      100,
    );

  const issuedAt =
    timestamp(
      value.issuedAt,
      "data-plane grant issuedAt",
    );

  const expiresAt =
    timestamp(
      value.expiresAt,
      "data-plane grant expiresAt",
    );

  if (
    expiresAt <= issuedAt
  ) {
    throw new TypeError(
      "data-plane grant expiresAt must be after issuedAt",
    );
  }

  if (
    expiresAt - issuedAt >
      DATA_PLANE_GRANT_MAX_TTL_MS
  ) {
    throw new TypeError(
      "data-plane grant lifetime exceeds 60 seconds",
    );
  }

  return Object.freeze({
    schemaVersion:
      DATA_PLANE_GRANT_SCHEMA_VERSION,
    audience:
      DATA_PLANE_GRANT_AUDIENCE,
    role: value.role,
    sessionId,
    workerId,
    leaseId,
    issuedAt,
    expiresAt,
    nonce,
  });
}

function validateSigningKey(
  value,
) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(
      value,
      "utf8",
    ) < 32
  ) {
    throw new TypeError(
      "data-plane signing key must contain at least 32 bytes",
    );
  }

  return Buffer.from(
    value,
    "utf8",
  );
}

function boundedString(
  value,
  name,
  maximum,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${maximum} characters`,
    );
  }

  return value;
}

function timestamp(
  value,
  name,
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `${name} must be a non-negative safe integer`,
    );
  }

  return value;
}

function isBase64Url(
  value,
) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    /^[A-Za-z0-9_-]+$/u.test(
      value,
    )
  );
}
