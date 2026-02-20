/**
 * Запуск примера уязвимого контракта в sandbox: компиляция, прогон очереди, вывод состояния.
 *
 * Использование:
 *   npx ts-node scripts/run-vuln-example.ts contracts/race_condition.fc
 *   npx ts-node scripts/run-vuln-example.ts contracts/main_contract.fc [--queue messages/queue.json]
 */
import * as fs from "fs";
import * as path from "path";
import { Cell, toNano } from "@ton/core";
import { compileFunc } from "@ton-community/func-js";
import { Blockchain, createShardAccount, internal } from "@ton/sandbox";
import { randomAddress } from "@ton/test-utils";

const projectRoot = path.resolve(__dirname, "..");

async function compileContract(contractPath: string): Promise<Cell> {
  const fullPath = path.isAbsolute(contractPath) ? contractPath : path.join(projectRoot, contractPath);
  const compileResult = await compileFunc({
    targets: [fullPath],
    sources: (requestedPath: string) => {
      if (path.isAbsolute(requestedPath)) return fs.readFileSync(requestedPath, "utf8");
      const fromRoot = path.join(projectRoot, requestedPath);
      if (fs.existsSync(fromRoot)) return fs.readFileSync(fromRoot, "utf8");
      const fromContractDir = path.join(path.dirname(fullPath), requestedPath);
      return fs.readFileSync(fromContractDir, "utf8");
    },
  });

  if (compileResult.status === "error") {
    throw new Error(`Compilation failed:\n${compileResult.message}`);
  }
  return Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0];
}

function parseValue(v: unknown): bigint {
  if (typeof v === "string") return BigInt(v);
  if (typeof v === "number") return BigInt(v);
  if (v && typeof v === "object" && "coins" in v) return BigInt((v as { coins: string }).coins);
  return toNano("0.05");
}

async function main() {
  const contractArg = process.argv[2];
  const queueArg = process.argv.includes("--queue")
    ? process.argv[process.argv.indexOf("--queue") + 1]
    : path.join(projectRoot, "messages/queue.json");

  if (!contractArg) {
    console.log("Usage: npx ts-node scripts/run-vuln-example.ts <contract.fc> [--queue queue.json]");
    process.exit(1);
  }

  console.log("Compiling", contractArg, "...");
  const codeCell = await compileContract(contractArg);
  console.log("OK\n");

  const queuePath = path.isAbsolute(queueArg) ? queueArg : path.join(projectRoot, queueArg);
  if (!fs.existsSync(queuePath)) {
    console.error("Queue file not found:", queuePath);
    process.exit(1);
  }
  const queueRaw = JSON.parse(fs.readFileSync(queuePath, "utf8")) as Array<{
    id?: number;
    type?: string;
    body?: string;
    value?: unknown;
    name?: string;
  }>;

  const blockchain = await Blockchain.create();
  const alice = await blockchain.treasury("alice");
  const bob = await blockchain.treasury("bob");
  const senderAddresses = [alice.address, bob.address, alice.address];

  const contractAddress = randomAddress();
  const initialData = new Cell();
  await blockchain.setShardAccount(
    contractAddress,
    createShardAccount({
      address: contractAddress,
      code: codeCell,
      data: initialData,
      balance: toNano("10"),
    })
  );

  const messages = queueRaw.map((msg, i) => ({
    id: msg.id ?? i + 1,
    type: msg.type ?? "internal",
    from: senderAddresses[i % senderAddresses.length],
    body: msg.body ? Cell.fromBoc(Buffer.from(msg.body, "base64"))[0] : new Cell(),
    value: parseValue(msg.value),
    name: msg.name ?? `msg_${i + 1}`,
  }));

  async function printState() {
    try {
      const result = await blockchain.runGetMethod(contractAddress, "get_state", []);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        console.log("  get_state -> exit code:", result.exitCode);
        return;
      }
      const balance = result.stackReader.readBigNumber();
      if (result.stack.length >= 2) {
        try {
          const owner = result.stackReader.readAddress();
          console.log("  get_state -> balance:", balance.toString(), "owner:", owner.toString());
        } catch {
          console.log("  get_state -> balance:", balance.toString(), "owner: (slice)");
        }
      } else {
        console.log("  get_state -> balance:", balance.toString());
      }
    } catch (e) {
      console.log("  get_state -> (error)", (e as Error).message);
    }
  }

  console.log("Initial state:");
  await printState();
  console.log("");

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`[${i + 1}/${messages.length}] ${msg.name} (id=${msg.id})`);
    const message = internal({
      from: msg.from,
      to: contractAddress,
      value: msg.value,
      body: msg.body,
      bounce: true,
    });
    await blockchain.sendMessage(message);
    await printState();
    console.log("");
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
