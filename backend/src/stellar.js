/**
 * Shared Soroban RPC client and helpers.
 * Real transactions are assembled here and returned as XDR so the
 * frontend can sign them with Freighter before submission.
 */
import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  Account,
  xdr,
} from "@stellar/stellar-sdk";
import logger from "./logger.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

export const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
export const networkPassphrase =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Parse a Soroban simulation or submission error into a structured object
 * with a human-readable message, error code, and any available context.
 */
export function parseSorobanError(error) {
  // Simulation error from prepareTransaction / simulateTransaction
  if (error?.result?.error) {
    const raw = error.result.error;
    return {
      status: 400,
      code: "SOROBAN_SIMULATION_ERROR",
      message: `Contract simulation failed: ${raw}`,
      detail: raw,
    };
  }

  // SorobanRpc simulation error object
  if (error?._type === "SimulateTransactionError" || error?.events !== undefined && error?.error) {
    return {
      status: 400,
      code: "SOROBAN_SIMULATION_ERROR",
      message: `Contract simulation failed: ${error.error}`,
      detail: error.error,
    };
  }

  // Horizon submission error — extract result_codes
  const resultCodes =
    error?.response?.data?.extras?.result_codes ??
    error?.data?.extras?.result_codes ??
    error?.extras?.result_codes;

  if (resultCodes) {
    const txCode = resultCodes.transaction ?? "unknown";
    const opCodes = resultCodes.operations ?? [];
    const detail = opCodes.length
      ? `transaction: ${txCode}, operations: ${opCodes.join(", ")}`
      : `transaction: ${txCode}`;
    return {
      status: 400,
      code: "SOROBAN_INVOCATION_ERROR",
      message: `Contract invocation failed — ${detail}`,
      detail: resultCodes,
    };
  }

  // Generic Horizon/RPC HTTP error
  const httpStatus = error?.response?.status ?? error?.status;
  if (httpStatus && httpStatus >= 400) {
    return {
      status: httpStatus >= 500 ? 502 : 400,
      code: "STELLAR_RPC_ERROR",
      message: error?.message ?? `Stellar RPC returned HTTP ${httpStatus}`,
      detail: error?.response?.data ?? null,
    };
  }

  return null;
}

/**
 * Build an unsigned Soroban transaction XDR for a contract invocation.
 * The frontend signs and submits it.
 */
export async function buildTx(callerAddress, contractId, method, args = []) {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  let prepared;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (error) {
    // Surface Soroban simulation errors with full detail
    if (SorobanRpc.Api.isSimulationError(error)) {
      throw {
        status: 400,
        code: "SOROBAN_SIMULATION_ERROR",
        message: `Contract simulation failed: ${error.error ?? error.message}`,
        detail: error.error ?? error.message,
      };
    }
    const parsed = parseSorobanError(error);
    if (parsed) throw parsed;
    throw error;
  }

  return prepared.toXDR();
}

function isRateLimitError(error) {
  return (
    error?.response?.status === 429 ||
    error?.status === 429 ||
    error?.message?.includes("429") ||
    error?.message?.toLowerCase().includes("too many requests") ||
    error?.message?.toLowerCase().includes("rate limit")
  );
}

/**
 * Retry wrapper for buildTx with exponential backoff.
 * Handles HTTP 429 rate-limit responses from Horizon explicitly.
 */
export async function retryBuildTx(callerAddress, contractId, method, args = []) {
  const maxRetries = 3;
  const baseBackoffMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await buildTx(callerAddress, contractId, method, args);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isNetworkError = error.message?.includes("network") || error.message?.includes("timeout") || error.code === "ENOTFOUND";
      const isAccountNotFound = error.message?.includes("account not found");
      const isSimulationError = error.message?.includes("simulation") || error.message?.includes("prepare");
      const isRateLimit = isRateLimitError(error);

      if (isAccountNotFound) {
        throw { status: 400, code: "ACCOUNT_NOT_FOUND", message: "Caller account not found on Stellar network" };
      }

      // Surface Soroban simulation / invocation errors immediately — no retry
      const sorobanError = parseSorobanError(error);
      if (sorobanError) throw sorobanError;
      if (error?.code === "SOROBAN_SIMULATION_ERROR" || error?.code === "SOROBAN_INVOCATION_ERROR") {
        throw error;
      }

      if (isRateLimit) {
        if (isLastAttempt) {
          logger.warn("Horizon rate limit exceeded after max retries", { method, contractId, attempt });
          throw { status: 429, code: "RATE_LIMIT_EXCEEDED", message: "Stellar Horizon rate limit exceeded. Please try again later." };
        }
        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        logger.warn(`Horizon rate limit hit, retrying with backoff`, { method, contractId, attempt, maxRetries, delayMs: delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (isNetworkError || isSimulationError) {
        if (isLastAttempt) {
          throw { status: 503, code: "RPC_UNAVAILABLE", message: "Stellar RPC is currently unavailable. Please try again later." };
        }
        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }
}

// ── ScVal helpers ────────────────────────────────────────────────────────

export function addressToScVal(addr) {
  return new Address(addr).toScVal();
}

export function u32ToScVal(n) {
  return xdr.ScVal.scvU32(n);
}

export function i128ToScVal(n) {
  return nativeToScVal(BigInt(n), { type: "i128" });
}

export function vecToScVal(items) {
  return xdr.ScVal.scvVec(items);
}

/**
 * Fetch the royalty rate from the contract using a read-only simulation.
 * Returns the rate as a u32 (basis points), or 0 on error.
 */
export async function getRoyaltyRateFromContract(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("get_royalty_rate"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return 0;
  return sim.result?.retval?.u32() ?? 0;
}

/**
 * Check if a contract has been initialized by simulating is_initialized().
 * Returns true if initialized, false if not.
 */
export async function isContractInitialized(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("is_initialized"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return false;
  return sim.result?.retval?.bool() ?? false;
}
