/**
 * Server signing key lifecycle (#293).
 *
 * Loads the key from SIGNING_KEY_FILE (secrets-manager mount) or
 * SERVER_SECRET_KEY, keeps it in memory for hot rotation without redeploy,
 * and never logs secret material.
 */
import { readFileSync, existsSync } from "fs";
import { timingSafeEqual } from "crypto";
import StellarSdk from "@stellar/stellar-sdk";
import logger from "./logger.js";

const { Keypair } = StellarSdk;

let activeKeypair = null;
let lastRotationAt = null;
let lastRotationSource = null;

function normalizeSecret(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse and validate a Stellar secret key. Throws on invalid input.
 */
export function parseSigningSecret(secret) {
  const normalized = normalizeSecret(secret);
  if (!normalized) {
    throw new Error("Signing secret key is required");
  }
  if (!normalized.startsWith("S")) {
    throw new Error("Signing secret key must start with 'S'");
  }
  try {
    return Keypair.fromSecret(normalized);
  } catch {
    throw new Error("Invalid Stellar signing secret key");
  }
}

function readSecretsFilePath() {
  return normalizeSecret(process.env.SIGNING_KEY_FILE);
}

function readSecretFromFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Signing key file not found: ${filePath}`);
  }
  const contents = readFileSync(filePath, "utf8");
  return normalizeSecret(contents);
}

function setActiveKeypair(keypair, source) {
  const previousPublicKey = activeKeypair?.publicKey() ?? null;
  activeKeypair = keypair;
  lastRotationAt = new Date().toISOString();
  lastRotationSource = source;

  logger.info("Signing key rotated", {
    event: "signing_key_rotated",
    source,
    previousPublicKey,
    publicKey: keypair.publicKey(),
    rotatedAt: lastRotationAt,
  });
}

/**
 * Load signing key from SIGNING_KEY_FILE or SERVER_SECRET_KEY.
 * Missing configuration is allowed (server may run without a signing key).
 */
export function initializeSigningKey() {
  const filePath = readSecretsFilePath();
  if (filePath) {
    const secret = readSecretFromFile(filePath);
    activeKeypair = parseSigningSecret(secret);
    lastRotationSource = "file";
    lastRotationAt = new Date().toISOString();
    logger.info("Signing key loaded from secrets file", {
      event: "signing_key_loaded",
      source: "file",
      publicKey: activeKeypair.publicKey(),
      filePath,
    });
    return activeKeypair;
  }

  const envSecret = normalizeSecret(process.env.SERVER_SECRET_KEY);
  if (envSecret) {
    activeKeypair = parseSigningSecret(envSecret);
    lastRotationSource = "env";
    lastRotationAt = new Date().toISOString();
    logger.info("Signing key loaded from environment", {
      event: "signing_key_loaded",
      source: "env",
      publicKey: activeKeypair.publicKey(),
    });
    return activeKeypair;
  }

  activeKeypair = null;
  lastRotationAt = null;
  lastRotationSource = null;
  logger.warn("No server signing key configured", {
    event: "signing_key_unconfigured",
  });
  return null;
}

export function getSigningKeypair() {
  return activeKeypair;
}

export function getSigningPublicKey() {
  return activeKeypair?.publicKey() ?? null;
}

export function getSigningKeyStatus() {
  return {
    configured: activeKeypair !== null,
    publicKey: getSigningPublicKey(),
    lastRotationAt,
    lastRotationSource,
  };
}

/**
 * Hot-reload the in-memory signing key from a new secret.
 */
export function rotateSigningKey(secret, { source = "api" } = {}) {
  const keypair = parseSigningSecret(secret);
  setActiveKeypair(keypair, source);
  return {
    publicKey: keypair.publicKey(),
    rotatedAt: lastRotationAt,
    source: lastRotationSource,
  };
}

/**
 * Re-read SIGNING_KEY_FILE and apply the updated secret without redeploy.
 */
export function reloadSigningKeyFromSecretsFile() {
  const filePath = readSecretsFilePath();
  if (!filePath) {
    throw new Error("SIGNING_KEY_FILE is not configured");
  }
  const secret = readSecretFromFile(filePath);
  return rotateSigningKey(secret, { source: "file_reload" });
}

/**
 * Constant-time comparison for the admin rotate token (#293).
 */
export function isAdminRotateTokenValid(providedToken) {
  const expected = normalizeSecret(process.env.ADMIN_ROTATE_TOKEN);
  if (!expected || typeof providedToken !== "string" || providedToken.length === 0) {
    return false;
  }
  const a = Buffer.from(providedToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reset module state (tests only). */
export function _resetSigningKeyState() {
  activeKeypair = null;
  lastRotationAt = null;
  lastRotationSource = null;
}
