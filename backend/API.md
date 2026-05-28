# Stellar Royalty Splitter — HTTP API

Base URL: `http://localhost:3001` (default)

All JSON POST bodies must use `Content-Type: application/json`.

## Health

### `GET /api/v1/health`

Operator health check for the backend and Stellar connectivity.

**Response**

```json
{
  "ok": true,
  "dbVersion": 2,
  "network": "Testnet",
  "horizon": {
    "connected": true,
    "url": "https://horizon-testnet.stellar.org"
  },
  "contract": {
    "configured": true,
    "contractId": "C...",
    "deployed": true,
    "initialized": true,
    "status": "initialized"
  }
}
```

| Field | Description |
| ----- | ----------- |
| `ok` | `true` when Horizon is reachable and any configured contract is healthy |
| `dbVersion` | SQLite schema migration version |
| `network` | `Testnet` or `Mainnet` (from `STELLAR_NETWORK`) |
| `horizon.connected` | Whether Horizon responded successfully |
| `horizon.url` | Configured `HORIZON_URL` |
| `contract.status` | `not_configured`, `deployed`, `initialized`, `unreachable`, or `error` |

Configure the default contract with `ROYALTY_CONTRACT_ID` or `CONTRACT_ID`. Responses are cached for `HEALTH_CACHE_TTL_MS` (default 30s).

Legacy `/api/*` paths redirect to `/api/v1/*`.

## Initialize

### `POST /api/v1/initialize`

Build an unsigned `initialize` transaction XDR.

**Body:** `{ contractId, walletAddress, collaborators, shares }`

**Response:** `{ xdr, transactionId }`

## Distribute

### `POST /api/v1/distribute`

Build an unsigned `distribute` transaction XDR.

**Body:** `{ contractId, walletAddress, tokenId }`

**Response:** `{ xdr, transactionId }`

## Collaborators

### `GET /api/v1/collaborators/:contractId`

Returns on-chain collaborator addresses and shares.

## Contract

### `GET /api/v1/contract/status/:contractId`

**Response:** `{ initialized: boolean }`

### `GET /api/v1/contract/balance/:contractId?tokenId=...`

**Response:** `{ balance: string }`

### `GET /api/v1/contract/collaborator-count/:contractId`

**Response:** `{ contractId, count }`

### `GET /api/v1/contract/shares-total/:contractId`

**Response:** `{ contractId, totalShares }`

## Secondary royalty

See route module `src/routes/secondary-royalty.js` for pool, sales, and distribution endpoints.

## History & analytics

- `GET /api/v1/history/:contractId`
- `GET /api/v1/analytics/:contractId`
