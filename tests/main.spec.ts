import * as fs from "fs";
import { Cell, toNano } from "@ton/core";
import { hex } from "../build/main.compiled.json";
import { MainContract } from "../wrappers/MainContract";
import "@ton/test-utils";
// We need to additionally import SandboxContract and TreasuryContract
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { compile } from "@ton/blueprint";
describe("main.fc contract tests", () => {
  let blockchain: Blockchain;
  let myContract: SandboxContract<MainContract>;
  let initWallet: SandboxContract<TreasuryContract>;
  let ownerWallet: SandboxContract<TreasuryContract>;
  let codeCell: Cell;

  beforeAll(async () => {
    codeCell = await compile("MainContract");
  });

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    initWallet = await blockchain.treasury("initWallet");
    ownerWallet = await blockchain.treasury("ownerWallet");

    myContract = blockchain.openContract(
      await MainContract.createFromConfig(
        {
          number: 0,
          address: initWallet.address,
          owner_address: ownerWallet.address,
        },
        codeCell
      )
    );
  });

  it("should get the proper most recent sender address", async () => {
    const senderWallet = await blockchain.treasury("sender");

    const sentMessageResult = await myContract.sendIncrement(
      senderWallet.getSender(),
      toNano("0.05"),
      1
    );

    expect(sentMessageResult.transactions).toHaveTransaction({
      from: senderWallet.address,
      to: myContract.address,
      success: true,
    });

    const data = await myContract.getData();

    expect(data.recent_sender.toString()).toBe(senderWallet.address.toString());
    expect(data.number).toEqual(1);
  });
  it("successfully deposits funds", async () => {
    const senderWallet = await blockchain.treasury("sender");

    const depositMessageResult = await myContract.sendDeposit(
      senderWallet.getSender(),
      toNano("5")
    );

    expect(depositMessageResult.transactions).toHaveTransaction({
      from: senderWallet.address,
      to: myContract.address,
      success: true,
    });

    const balanceRequest = await myContract.getBalance();

    expect(balanceRequest.number).toBeGreaterThan(toNano("4.99"));
  });
  it("should return funds as no command is sent", async () => {
    const senderWallet = await blockchain.treasury("sender");

    const depositMessageResult = await myContract.sendNoCodeDeposit(
      senderWallet.getSender(),
      toNano("5")
    );

    expect(depositMessageResult.transactions).toHaveTransaction({
      from: myContract.address,
      to: senderWallet.address,
      success: true,
    });

    const balanceRequest = await myContract.getBalance();

    expect(balanceRequest.number).toBe(0);
  });
  it("successfully withdraws funds on behalf of owner", async () => {
    const senderWallet = await blockchain.treasury("sender");

    const deposit = await myContract.sendDeposit(senderWallet.getSender(), toNano("5"));
    const hexArtifact = "adding.json";
  
    fs.promises.appendFile(
      hexArtifact,
      JSON.stringify([{
        id: 0,
        type: "internal",
        body: deposit.result.body?.toString(),
        value: deposit.result.value.toString(),
        name: "Deposit"
      }], null, 2)
    );

    const withdrawalRequestResult = await myContract.sendWithdrawalRequest(
      ownerWallet.getSender(),
      toNano("0.05"),
      toNano("1")
    );

    expect(withdrawalRequestResult.transactions).toHaveTransaction({
      from: myContract.address,
      to: ownerWallet.address,
      success: true,
      value: toNano(1),
    });
  });

  it("fails to withdraw funds on behalf of not-owner", async () => {
    const senderWallet = await blockchain.treasury("sender");

    await myContract.sendDeposit(senderWallet.getSender(), toNano("5"));

    const withdrawalRequestResult = await myContract.sendWithdrawalRequest(
      senderWallet.getSender(),
      toNano("0.5"),
      toNano("1")
    );

    expect(withdrawalRequestResult.transactions).toHaveTransaction({
      from: senderWallet.address,
      to: myContract.address,
      success: false,
      exitCode: 103,
    });
  });

  it("fails to withdraw funds because lack of balance", async () => {
    const withdrawalRequestResult = await myContract.sendWithdrawalRequest(
      ownerWallet.getSender(),
      toNano("0.5"),
      toNano("1")
    );

    expect(withdrawalRequestResult.transactions).toHaveTransaction({
      from: ownerWallet.address,
      to: myContract.address,
      success: false,
      exitCode: 104,
    });
  });

  it("successfull attack", async () => {
    const attacker = await blockchain.treasury("atack");
    const user = await blockchain.treasury("commonuser");

    await myContract.sendDeposit(user.getSender(), toNano("5"));
    await myContract.sendDeposit(attacker.getSender(), toNano("1"));

    const withdrawalRequestResult = await myContract.sendWithdrawalRequest(
      ownerWallet.getSender(),
      toNano("0.05"),
      toNano("1")
    );

    expect(withdrawalRequestResult.transactions).toHaveTransaction({
      from: myContract.address,
      to: ownerWallet.address,
      success: true,
      value: toNano(1),
    });
  });

});

/*
import { Address, Cell, toNano, beginCell } from "@ton/ton";
import { Blockchain, internal, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { MainContract, MainContractConfig } from "../wrappers/MainContract";
import { compileFunc } from "@ton-community/func-js";
import { readFileSync } from "fs";

describe("MainContract withdrawal vulnerability test", () => {
  let blockchain: Blockchain;
  let contract: SandboxContract<MainContract>;
  let owner: SandboxContract<TreasuryContract>;
  let codeCell: Cell;

  beforeAll(async () => {
    const compileResult = await compileFunc({
      targets: ["contracts/main.fc"],
      sources: (x) => readFileSync(x).toString("utf8"),
    });
    if (compileResult.status === "error") {
      throw new Error(`Compilation failed: ${compileResult.message}`);
    }
    codeCell = Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0];
  });

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury("owner");
    const config: MainContractConfig = {
      number: 0,
      address: owner.address,
      owner_address: owner.address,
    };
    contract = blockchain.openContract(MainContract.createFromConfig(config, codeCell, 0));
    await contract.sendDeploy(owner.getSender(), toNano("1")); // 1 TON
  });

  it("should prevent multiple withdrawals exceeding available balance", async () => {
    const initialBalance = toNano("1");
    const minTonsForStorage = toNano("0.01");
    const withdrawAmount = toNano("0.4");

    console.log("balance:", BigInt((await contract.getBalance()).number));

    // Queue three withdrawal messages
    const messages = [
      internal({
        from: owner.address,
        to: contract.address,
        value: toNano("0.05"),
        body: beginCell().storeUint(3, 32).storeCoins(withdrawAmount).endCell(),
      }),
      internal({
        from: owner.address,
        to: contract.address,
        value: toNano("0.05"),
        body: beginCell().storeUint(3, 32).storeCoins(withdrawAmount).endCell(),
      }),
      internal({
        from: owner.address,
        to: contract.address,
        value: toNano("0.05"),
        body: beginCell().storeUint(3, 32).storeCoins(withdrawAmount).endCell(),
      }),
    ];

    // Queue all messages
    for (const msg of messages) {
      await blockchain.sendMessageIter(msg);
    }

    console.log("Pending messages:", (blockchain as any).messageQueue);

    // Process all messages in the queue
    const transactions: any[] = [];
    const successfulWithdrawals: any[] = [];
    const messageQueue = (blockchain as any).messageQueue;

    // Iterate over each message in the queue
    while (messageQueue.length > 0) {
      const msg = messageQueue[0];
      const iter = await blockchain.sendMessageIter(msg);
      for await (const tx of iter) {
        transactions.push(tx);
        let op: number | undefined;
        try {
          op = tx.inMessage?.body.beginParse().loadUint(32);
        } catch (e) {
          op = undefined; // Handle bounced messages
        }
        console.log("Processed transaction:", {
          op,
          exitCode: tx.description,
          //outMessages: tx.outMessages.length,
          //gasUsed: tx.description.gasUsed,
        });
        if (op === 3 && tx.outMessages.size > 0) {
          successfulWithdrawals.push(tx);
        }
      }
      // Remove processed message
      messageQueue.shift();
    }

    console.log("Total transactions:", transactions.length);
    console.log("Successful withdrawals:", successfulWithdrawals.length);

    const finalBalance = BigInt((await contract.getBalance()).number);
    console.log("Final balance:", finalBalance.toString());
    const maxWithdrawable = initialBalance - minTonsForStorage;
    expect(finalBalance).toBeGreaterThanOrEqual(minTonsForStorage);
    expect(successfulWithdrawals.length).toBeLessThanOrEqual(2); // At most 2 withdrawals
    let totalSent = 0n;
    for (const tx of successfulWithdrawals) {
      totalSent += tx.outMessages[0].info.value?.coins || 0n;
    }
    console.log("Total sent:", totalSent.toString());
    expect(totalSent).toBeLessThanOrEqual(maxWithdrawable);

    const data = await contract.getData();
    expect(data.number).toBe(0);
    expect(data.recent_sender.toString()).toBe(owner.address.toString());
    expect(data.owner_address.toString()).toBe(owner.address.toString());
  });
});
*/