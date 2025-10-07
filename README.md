# Squads Multisig Batch Optimizer

A utility for optimizing Squads Multisig v4 batch transactions by packing the maximum number of instructions into minimal transactions while respecting atomic execution requirements.

## Overview

This tool helps prepare Squads Multisig v4 transactions for use with the `batchAdd` functionality. It intelligently groups instructions into optimally-sized batches, ensuring:

1. **Atomic execution**: Instructions that depend on each other are kept together in the same batch transaction
2. **Maximum density**: The most instructions possible are squeezed into a single transaction
3. **Size compliance**: All batches stay within the 1100-byte serialization limit

## Core Functionality

### `packageInstructions()`

The main function that takes instruction buckets and packs them into optimized transaction messages.

```typescript
export const packageInstructions = (
  instructionsBuckets: TransactionInstruction[][],
  addressLookupTableAccounts: AddressLookupTableAccount[]
): PackagedBatchedInstructionsResult
```

**Parameters:**
- `instructionsBuckets`: Array of instruction arrays, where each sub-array represents instructions that must execute together atomically
  - Example with atomic requirements: `[[ix1_setup, ix1_execute], [ix2_setup, ix2_execute]]`
  - Example without atomic requirements: `[[ix1], [ix2], [ix3]]`
- `addressLookupTableAccounts`: Address lookup tables for transaction compression

**Returns:**
```typescript
{
  transactionMessages: TransactionMessage[];  // Optimized transaction messages
  failedBuckets: number[];                    // Indices of buckets that couldn't fit
  bucketTxMessageIndexes: number[];           // Maps each bucket to its transaction index
}
```

### `createBatchAddSingleTransaction()`

Creates a single versioned transaction for adding to a Squads batch, including compute budget instructions.

**Key features:**
- Adds priority fees (configurable, defaults to 50,000 microlamports)
- Sets compute unit limit to 100,000
- Supports address lookup tables for transaction compression
- Compatible with Squads Multisig v4 program

## Usage Example

```typescript
import { packageInstructions } from './index.js';

// Group your instructions into atomic buckets
const instructionBuckets = [
  [setupIx1, executeIx1],  // These must execute together
  [setupIx2, executeIx2],  // These must execute together
  [standaloneIx3],         // This can execute alone
];

// Pack them optimally
const result = packageInstructions(
  instructionBuckets,
  addressLookupTableAccounts
);

console.log(`Created ${result.transactionMessages.length} optimized transactions`);
console.log(`Failed buckets: ${result.failedBuckets.length}`);
```

## How It Works

1. **Size calculation**: Uses dummy keys to calculate serialized transaction size before committing
2. **Greedy packing**: Attempts to add each instruction bucket to the current transaction
3. **Overflow handling**: When a bucket would exceed the size limit:
   - Saves the current transaction
   - Starts a new transaction
   - Attempts to add the bucket to the new transaction
4. **Failure tracking**: Buckets that are too large even for an empty transaction are marked as failed

## Configuration

- `BATCH_ADD_MAX_SIZE_CHECK`: 1100 bytes (serialization limit for batch transactions)
- `PRIORITY_FEES`: 50,000 microlamports (default priority fee)
- `SQUADS_PROGRAM_ID`: Imported from `@sqds/multisig`

## Build

```bash
# Build the project
yarn build

# Watch mode for development
yarn build:watch

# Clean build artifacts
yarn clean
```

## Dependencies

- `@solana/web3.js`: Solana blockchain interaction
- `@sqds/multisig`: Squads Multisig v4 SDK
- `typescript`: Type safety and compilation
