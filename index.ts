import {
  AddressLookupTableAccount, ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const BATCH_ADD_MAX_SIZE_CHECK = 1100;
const PRIORITY_FEES = 50000;
const SQUADS_PROGRAM_ID = multisig.PROGRAM_ID;

// this uses dummy keys, merely to see if the size goes above the limit
const calculateSerializedTxSize = (
  addressLookupTableAccounts: AddressLookupTableAccount[],
  transactionMessage: TransactionMessage
): number => {
  try {
    const batchAddTx = createBatchAddSingleTransaction({
      blockhash: PublicKey.default.toBase58(),
      proposer: PublicKey.default,
      rentPayer: PublicKey.default,
      squadAddress: PublicKey.default,
      transactionIndex: 0,
      batchIndex: BigInt(0),
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: {
        // create a new one since we will actually have a fee priority compute ix in each tx
        message: new TransactionMessage({
          payerKey: PublicKey.default,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions: transactionMessage.instructions,
        }),
        addressLookupTableAccounts,
      },
    });
    return batchAddTx.serialize().length;
  } catch (e) {
    console.error("Size exceeded in preparation");
    return BATCH_ADD_MAX_SIZE_CHECK + 1; // Assume it exceeds max size to handle error
  }
};

const tryAddBucket = (
  message: TransactionMessage,
  bucket: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[]
): TransactionMessage | null => {
  // MBO-1 Fix: Build a new message instead of mutating the caller's message. Mutating
  // shared TransactionMessage instances makes the result depend on call order
  // and can leave a partially updated message behind when the size check fails.
  const candidate = new TransactionMessage({
    payerKey: message.payerKey,
    recentBlockhash: message.recentBlockhash,
    instructions: [...message.instructions, ...bucket],
  });

  if (
    calculateSerializedTxSize(addressLookupTableAccounts, candidate) >
    BATCH_ADD_MAX_SIZE_CHECK
  ) {
    return null;
  }
  return candidate;
};

export interface PackagedBatchedInstructionsResult {
  transactionMessages: TransactionMessage[];
  failedBuckets: number[];
  bucketTxMessageIndexes: Array<number>;
}

// function takes an array of arrays, with each have a collection of instructions (that may need to be executed together to represent a single tx)
// ie [[ix1_requirement, ix1_requirement, ix1], [ix2_requirement, ix3_requirement, ix3]...]
// if there are no atomic requirements, this can simply be a list [[ix1], [ix2], [ix3]]
export const packageInstructions = (
  instructionsBuckets: TransactionInstruction[][],
  addressLookupTableAccounts: AddressLookupTableAccount[]
): PackagedBatchedInstructionsResult => {
  // MBO-3 Fix: Explicit input validation
  if (!Array.isArray(instructionsBuckets)) {
    throw new Error("instructionsBuckets must be an array of instruction arrays");
  }
  if (!Array.isArray(addressLookupTableAccounts)) {
    throw new Error("addressLookupTableAccounts must be an array");
  }

  const transactionMessages: TransactionMessage[] = [];
  const failedBuckets: number[] = [];
  const bucketTxMessageIndexes: Array<number> = [];

  // the initial message to add instructions to
  let currentMessage = new TransactionMessage({
    payerKey: PublicKey.default,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [],
  });

  instructionsBuckets.forEach((bucket, index) => {
    // MBO-3 Fix: Explicitly check bucket arrays
    if (!Array.isArray(bucket)) {
      throw new Error(`Instruction bucket at index ${index} must be an array`);
    }

    // if bucket does not have any instructions, skip it
    if (bucket.length === 0) {
      failedBuckets.push(index);
      bucketTxMessageIndexes.push(-1);
      return;
    }

    const withBucket = tryAddBucket(
      currentMessage,
      bucket,
      addressLookupTableAccounts
    );

    if (withBucket) {
      // The bucket was added successfully to the current message.
      currentMessage = withBucket;
      bucketTxMessageIndexes.push(transactionMessages.length);
      return;
    }

    // Attempt to add the current bucket to the message failed due to size constraints.
    if (currentMessage.instructions.length > 0) {
      transactionMessages.push(currentMessage); // Save the message if it has any instructions
    }

    // Create a new message for the next attempt
    currentMessage = new TransactionMessage({
      payerKey: PublicKey.default,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [],
    });

    // Try adding the bucket to the new message to see if it fits
    const inEmptyMessage = tryAddBucket(
      currentMessage,
      bucket,
      addressLookupTableAccounts
    );

    if (inEmptyMessage) {
      currentMessage = inEmptyMessage;
      // If the bucket is successfully added, record its message index
      bucketTxMessageIndexes.push(transactionMessages.length);
    } else {
      // If the bucket alone exceeds the max size, mark it as failed
      failedBuckets.push(index);
      bucketTxMessageIndexes.push(-1);
    }
  });

  if (currentMessage.instructions.length > 0) {
    transactionMessages.push(currentMessage); // Ensure the last message is added
  }

  return {transactionMessages, failedBuckets, bucketTxMessageIndexes};
};

// for prexisting batch drafts - this is a solo transaction to create the ix to attach
// a single tx to a batch
// IMPORTANT! batchIndex is the actual proposal/transaction index, and transactionIndex is the
// batch TX themselves!
export function createBatchAddSingleTransaction({
                                                  blockhash,
                                                  proposer,
                                                  rentPayer,
                                                  squadAddress,
                                                  transactionIndex,
                                                  vaultIndex,
                                                  batchIndex,
                                                  ephemeralSigners,
                                                  transactionMessage,
                                                  fees,
                                                }: {
  blockhash: string;
  proposer: PublicKey;
  rentPayer: PublicKey;
  squadAddress: PublicKey;
  transactionIndex: number;
  batchIndex: bigint;
  vaultIndex: number;
  ephemeralSigners: number;
  transactionMessage: {
    message: TransactionMessage;
    addressLookupTableAccounts: AddressLookupTableAccount[];
  };
  fees?: number;
}): VersionedTransaction {
  // MBO-3 Fix: Explicit input validations added for strings, integers and ranges
  if (!blockhash) {
    throw new Error("blockhash is required");
  }
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
    throw new Error("vaultIndex must be an integer between 0 and 255");
  }
  if (!Number.isInteger(ephemeralSigners) || ephemeralSigners < 0) {
    throw new Error("ephemeralSigners must be a non-negative integer");
  }
  if (fees !== undefined && (!Number.isFinite(fees) || fees < 0)) {
    throw new Error("fees must be a non-negative finite number");
  }

  const batchIx = multisig.instructions.batchAddTransaction({
    vaultIndex,
    multisigPda: squadAddress, // MBO-3 Fix: Use squadAddress directly as it is already a PublicKey
    member: proposer,
    rentPayer,
    batchIndex,
    transactionIndex,
    ephemeralSigners,
    transactionMessage: transactionMessage.message,
    addressLookupTableAccounts: transactionMessage.addressLookupTableAccounts,
    programId: SQUADS_PROGRAM_ID,
  });

  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: rentPayer ?? proposer,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({
          // MBO-2 Fix: Use `??` so that an explicit fee of 0 is intentionally preserved.
          microLamports: fees ?? PRIORITY_FEES,
        }),
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 100_000,
        }),
        batchIx,
      ],
    }).compileToV0Message(transactionMessage.addressLookupTableAccounts)
  );
}
