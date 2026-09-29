# Ledger API

A double-entry ledger and money transfer API built with NestJS and PostgreSQL.

The goal of this project is not feature breadth. It focuses on one problem that every payment system has to get right: **moving money between accounts correctly, even under concurrent requests, retries, and partial failures.**

> **Status:** work in progress. See the [Roadmap](#roadmap) for what is implemented.

---

## Table of contents

- [Why this project](#why-this-project)
- [Core guarantees](#core-guarantees)
- [Tech stack](#tech-stack)
- [Domain model](#domain-model)
- [How a transfer works](#how-a-transfer-works)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [API overview](#api-overview)
- [Testing strategy](#testing-strategy)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Out of scope](#out-of-scope)
- [Roadmap](#roadmap)

---

## Why this project

A naive wallet stores a `balance` column and runs `balance = balance - amount`. That breaks in predictable ways:

| Problem | What goes wrong |
|---|---|
| Race condition | Two concurrent transfers read the same balance and both succeed, overdrawing the account |
| Client retry | A timeout causes the client to resend the request and the money moves twice |
| Partial failure | The debit is written but the credit is not, and money disappears |
| No history | The balance changed, but nobody can explain why |

This project addresses each of these explicitly and proves the fixes with tests.

## Core guarantees

1. **Conservation of money.** Every transaction produces ledger entries whose debits and credits sum to zero. Money is never created or destroyed, only moved.
2. **Atomicity.** A transfer either fully applies or has no effect at all.
3. **No overdraft under concurrency.** Concurrent transfers from the same account cannot push its balance below zero.
4. **Exactly-once effect per request.** Retrying a request with the same idempotency key never moves money twice.
5. **Auditability.** Ledger entries are append-only. Every balance can be recomputed from its entries.

## Tech stack

| Area | Choice |
|---|---|
| Runtime | Node.js, TypeScript |
| Framework | NestJS |
| Database | PostgreSQL |
| ORM | TypeORM |
| Validation | class-validator, class-transformer |
| Testing | Jest, Supertest, real PostgreSQL in Docker |
| Environment | Docker, Docker Compose |

## Domain model

```
accounts
  id              uuid, primary key
  owner_name      text
  currency        char(3)               -- single currency (VND) for now
  balance         bigint  CHECK (balance >= 0)
  type            'user' | 'system'
  created_at      timestamptz

transactions
  id              uuid, primary key
  type            'transfer' | 'deposit'
  status          'completed'
  idempotency_key text
  created_at      timestamptz

ledger_entries                           -- append-only
  id              uuid, primary key
  transaction_id  uuid -> transactions.id
  account_id      uuid -> accounts.id
  direction       'debit' | 'credit'
  amount          bigint  CHECK (amount > 0)
  created_at      timestamptz

idempotency_keys
  key             text, primary key
  request_hash    text                  -- hash of the request body
  response_status int
  response_body   jsonb
  created_at      timestamptz
```

A transfer of 50,000 VND from Alice to Bob creates **one** transaction and **two** ledger entries:

| account | direction | amount |
|---|---|---|
| Alice | debit | 50,000 |
| Bob | credit | 50,000 |

Deposits follow the same rule. Money enters the system through a **system account**, so every movement, including funding, is double-entry.

## How a transfer works

```
POST /transfers   (Idempotency-Key: <uuid>)

BEGIN
  1. INSERT idempotency key
       - key already exists, same request hash   -> return the stored response
       - key already exists, different hash      -> 422 Unprocessable Entity
       - same key in flight concurrently         -> waits on the unique index, then returns the stored response
  2. SELECT ... FOR UPDATE both accounts, ordered by account id
  3. Validate: accounts exist, same currency, amount > 0, sufficient balance
  4. INSERT transaction
  5. INSERT two ledger entries (debit + credit)
  6. UPDATE both account balances
  7. Store the response on the idempotency key
COMMIT
```

Any error before `COMMIT` rolls back every step, including the idempotency key, so the client can safely retry.

## Design decisions and trade-offs

**Money stored as `bigint` in minor units.**
Floating point cannot represent money exactly (`0.1 + 0.2 !== 0.3`). Integers make arithmetic exact. VND has no minor unit, so the stored value equals the amount in đồng.

**Pessimistic locking (`SELECT ... FOR UPDATE`) instead of optimistic locking.**
Transfers on a hot account conflict often, and a failed transfer is expensive for the user. Row locks make concurrent transfers on the same account wait instead of fail and retry. The trade-off is lower throughput on a single hot account, which is acceptable here. Optimistic locking would fit better when conflicts are rare.

**Locks acquired in a consistent order (by account id).**
If transfer A→B locks A then B while B→A locks B then A, the two can deadlock. Always locking the lower id first removes that cycle.

**`READ COMMITTED` plus explicit row locks, not `SERIALIZABLE`.**
Explicit locks protect exactly the rows that matter. `SERIALIZABLE` would also be correct, but it pushes serialization failures to the application, which would need retry logic for every transaction.

**Cached `balance` column plus ledger entries as the source of truth.**
Summing all entries on every read is slow. The balance column is updated in the same database transaction as the entries, and a reconciliation check verifies that `balance == sum(credits) - sum(debits)` for every account.

**Database constraints as the last line of defense.**
`CHECK (balance >= 0)` and `CHECK (amount > 0)` hold even if application code has a bug.

**Append-only ledger.**
Entries are never updated or deleted. Mistakes are corrected with a new, reversing transaction, keeping full history.

## API overview

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/accounts` | Create an account |
| `GET` | `/accounts/:id` | Get an account and its balance |
| `GET` | `/accounts/:id/entries` | Paginated ledger entries for an account |
| `POST` | `/deposits` | Fund an account from the system account (requires `Idempotency-Key`) |
| `POST` | `/transfers` | Transfer money between accounts (requires `Idempotency-Key`) |
| `GET` | `/transfers/:id` | Get a transfer and its ledger entries |
| `GET` | `/reconciliation` | Verify ledger integrity across all accounts |

Error responses:

| Status | When |
|---|---|
| `400` | Invalid input (non-positive amount, same source and destination) |
| `404` | Account not found |
| `409` | Insufficient funds |
| `422` | Idempotency key reused with a different request body |

## Testing strategy

Tests run against a real PostgreSQL instance, because locking and transaction behavior cannot be meaningfully mocked.

**Unit tests:** validation rules, request hashing, entry construction.

**Integration tests:**
- A successful transfer creates one transaction and two balanced entries.
- A transfer with insufficient funds changes nothing.
- A failure midway through a transfer rolls back all writes.
- Replaying a request with the same idempotency key returns the same response and moves money once.
- Reusing a key with a different body returns `422`.

**Concurrency and invariant tests:**
- Many concurrent transfers draining one account never produce a negative balance.
- Opposite-direction transfers (A→B and B→A) running concurrently do not deadlock.
- Many concurrent random transfers between many accounts, then:
  - total money in the system is unchanged,
  - every transaction's debits equal its credits,
  - every account's balance matches the sum of its entries.

## Getting started

> Setup instructions will be finalized once the scaffold is in place.

```bash
# Start PostgreSQL
docker compose up -d

# Install dependencies
npm install

# Run database migrations
npm run migration:run

# Start the API
npm run start:dev

# Run tests
npm test
```

## Project structure

```
src/
  accounts/        account creation and lookup
  transfers/       transfer and deposit use cases
  ledger/          transactions, ledger entries, reconciliation
  idempotency/     idempotency key storage and request hashing
  common/          errors, filters, shared utilities
  database/        TypeORM config and migrations
test/
  integration/
  concurrency/
```

## Out of scope

To keep the focus on correctness, the following are intentionally left out:

- Authentication and authorization
- Multiple currencies and exchange rates
- External payment gateways
- Frontend

## Roadmap

- [ ] Project scaffold, Docker Compose, database config
- [ ] Schema and migrations
- [ ] Accounts API
- [ ] Deposits via system account
- [ ] Atomic transfers with row-level locking
- [ ] Idempotency keys
- [ ] Reconciliation endpoint
- [ ] Integration tests
- [ ] Concurrency and invariant tests
- [ ] Final documentation and benchmark numbers
