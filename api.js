const express = require("express");
const axios = require("axios");
const ethers = require("ethers");
const {
  Connection,
  Transaction,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const bs58 = require("bs58");

require("dotenv").config({});

const app = express();
app.use(express.json());

/******************************************************************************
 *                                                                            *
 *                        DECLARE PRIVATE KEYS                                *
 *                                                                            *
 ******************************************************************************/

// Declare EVM and SOL private keys
const EVMPrivateKey = process.env.EVM_PRIVATE_KEY;
const SOLPrivateKeyBase58 = process.env.SOL_PRIVATE_KEY;

/******************************************************************************
 *                                                                            *
 *                        SIGN EVM TRANSACTION                                *
 *                                                                            *
 ******************************************************************************/

// Utility function to get signer (for EVM chains)
async function getEVMSigner(privateKey) {
  //Enter your EVM RPC url
  const provider = new ethers.JsonRpcProvider(process.env.INFURA_EMV_RPC);
  return new ethers.Wallet(privateKey, provider);
}

// Function to execute EVM transaction
async function executeEvmTxData(txData) {
  const signer = await getEVMSigner(EVMPrivateKey);
  const txResponse = await signer.sendTransaction(txData);
  const receipt = await txResponse.wait();
  console.log("Transaction receipt:", receipt);
  return txResponse.hash;
}

/******************************************************************************
 *                                                                            *
 *                        SIGN SOLANA TRANSACTION                             *
 *                                                                            *
 ******************************************************************************/
// Function to execute Solana transaction
async function executeSolTxData(txData) {
  const rawTx = Uint8Array.from(Buffer.from(txData.data, "hex"));
  let transaction;

  try {
    transaction = Transaction.from(rawTx);
  } catch (error) {
    transaction = VersionedTransaction.deserialize(rawTx);
  }

  const connection = new Connection("https://api.mainnet-beta.solana.com");

  // Decode the Base58 private key
  const SOLPrivateKey = bs58.default.decode(SOLPrivateKeyBase58);

  // Ensure the private key is valid (64 bytes)
  if (SOLPrivateKey.length !== 64) {
    throw new Error(
      "Invalid private key length. Solana private keys must be 64 bytes."
    );
  }

  // Create a Keypair from the decoded private key
  const wallet = Keypair.fromSecretKey(SOLPrivateKey);

  const balance = await connection.getBalance(wallet.publicKey);

  console.log(`Wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Get a fresh blockhash
  const { blockhash } = await connection.getLatestBlockhash();

  if (transaction instanceof Transaction) {
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
  } else if (transaction instanceof VersionedTransaction) {
    // For VersionedTransactions, we need to update the blockhash differently
    transaction.message.recentBlockhash = blockhash;
  }

  // Estimate fee
  const fee = await connection.getFeeForMessage(transaction.message);

  if (balance < fee.value) {
    throw new Error("Insufficient balance to cover transaction fees.");
  }

  // Sign the transaction with the wallet
  if (transaction instanceof Transaction) {
    transaction.sign(wallet);
  } else if (transaction instanceof VersionedTransaction) {
    transaction.sign([wallet]);
  }

  // Send the signed transaction
  const txId = await connection.sendRawTransaction(transaction.serialize());

  // Wait for confirmation
  const confirmation = await connection.confirmTransaction(txId);

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${confirmation.value.err}`);
  }

  return txId;
}

/******************************************************************************
 *                                                                            *
 *                        ENTRY ENDPOINT                                      *
 *                                                                            *
 ******************************************************************************/

app.post("/uniswap", async (req, res) => {
  try {
    const {
      fromChain,
      fromTokenAddress,
      fromUserAddress,
      tokenSymbol,
      toTokenAddress,
      toChain,
      tokenAmount,
      toTokenSymbol,
      toUserAddress,
      projectId,
    } = req.body;

    /**
     *
     *
     * STEPS TO PERFORM SWAP OR BRIDGE
     *
     * - Get a quote
     * - If source token is ERC20 token, check for allowance (/allowance)
     * - If allowance limit is less than tokenAmount, then get approval callData (/approve)
     * - If approval, sign txData from approval
     * - Next, Call send transaction (/send)
     * - Sign txData returned from (/send)
     */

    // Quote Prepare transfer params
    const quoteParams = {
      fromChain,
      fromTokenAddress,
      fromUserAddress,
      tokenSymbol,
      toTokenAddress,
      toChain,
      tokenAmount,
      toTokenSymbol,
      toUserAddress,
      projectId,
    };

    // Get available quotes
    const quotesResponse = await axios.get(
      "https://swap.prod.swing.xyz/v0/transfer/quote",
      {
        params: quoteParams,
      }
    );

    const quotes = quotesResponse.data;

    if (quotes.routes.length < 1) {
      return res.json({ success: false, message: "No Quotes Available" });
    }

    const allowanceParams = {
      bridge: quotes.routes[0].quote.integration,
      fromAddress: fromUserAddress,
      fromChain,
      toChain,
      tokenAddress: fromTokenAddress,
      tokenSymbol,
      toTokenSymbol,
      toTokenAddress,
    };

    const allowanceResponse = await axios.get(
      "https://swap.prod.swing.xyz/v0/transfer/allowance",
      {
        params: allowanceParams,
      }
    );

    if (
      allowanceResponse.data.allowance < tokenAmount &&
      fromChain !== "solana"
    ) {
      const approvalParams = {
        bridge: quotes.routes[0].quote.integration,
        tokenAmount,
        fromAddress: fromUserAddress,
        fromChain,
        toChain,
        tokenAddress: fromTokenAddress,
        tokenSymbol,
        toTokenSymbol,
        toTokenAddress,
      };

      const approve = (
        await axios.get(`https://swap.prod.swing.xyz/v0/transfer/approve`, {
          params: approvalParams,
        })
      ).data.tx[0];

      const approveTxData = {
        data: approve.data,
        from: approve.from,
        to: approve.to,
        value: approve.value,
        gasLimit: approve.gas,
      };

      await executeEvmTxData(approveTxData);
    }

    const sendParams = {
      fromUserAddress,
      toUserAddress,
      tokenSymbol,
      fromTokenAddress,
      fromChain,
      toTokenSymbol,
      toTokenAddress,
      toChain,
      tokenAmount,
      route: quotes.routes[0].route,
      projectId,
    };
    // Send transaction to Swing
    const swingResponse = await axios.post(
      "https://swap.prod.swing.xyz/v0/transfer/send",
      {
        ...sendParams,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const txData = swingResponse.data.tx;

    let txHash;

    /******************************************************************************
     *                                                                            *
     *                        CHECK CHAIN AND SIGN ACCORDINGLY                    *
     *                                                                            *
     ******************************************************************************/

    if (fromChain === "solana") {
      txHash = await executeSolTxData(txData);
    } else {
      // Assume EVM chain
      const ethTxData = {
        data: txData.data,
        from: txData.from,
        to: txData.to,
        value: txData.value,
        gasLimit: txData.gas,
      };

      txHash = await executeEvmTxData(ethTxData);
    }

    return res.json({ success: true, txHash });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/******************************************************************************
 *                                                                            *
 *                        API PARAMS                                          *
 *                                                                            *
 ******************************************************************************/
/**
 * 
 * You MUST specify source and destination change info
 * 
 * 
 * 
 * FOR EVM <> EVM
 * 
 *  {
  "fromChain": "ethereum",
  "fromTokenAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "fromUserAddress": "0xf022c6EC5be6F4A6dD19C196BA50F4be2786E7b8",
  "tokenSymbol": "USDC",
  "toTokenAddress": "0x0000000000000000000000000000000000000000",
  "toChain": "polygon",
  "tokenAmount": "1000000",
  "toTokenSymbol": "MATIC",
  "toUserAddress": "0xf022c6EC5be6F4A6dD19C196BA50F4be2786E7b8",
  "projectId": "replug"
}
 * 
 * 
 * 
 * 
 * FOR EVM <> SOL
 * 
 * {
  "fromChain": "ethereum",
  "fromTokenAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "fromUserAddress": "0xf022c6EC5be6F4A6dD19C196BA50F4be2786E7b8",
  "tokenSymbol": "USDC",
  "toTokenAddress": "11111111111111111111111111111111",
  "toChain": "solana",
  "tokenAmount": "1000000",
  "toTokenSymbol": "SOL",
  "toUserAddress": "ELoruRy7quAskANEgC99XBYfEnCcrVGSqnwGETWKZtsU",
  "projectId": "replug"
}
 * 
 * 
 * FOR SOL <> EVM
 * 
 * {
  "fromChain": "ethereum",
  "fromTokenAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "fromUserAddress": "0xf022c6EC5be6F4A6dD19C196BA50F4be2786E7b8",
  "tokenSymbol": "USDC",
  "toTokenAddress": "11111111111111111111111111111111",
  "toChain": "solana",
  "tokenAmount": "1000000",
  "toTokenSymbol": "SOL",
  "toUserAddress": "ELoruRy7quAskANEgC99XBYfEnCcrVGSqnwGETWKZtsU",
  "projectId": "replug"
}
 * 
 */
