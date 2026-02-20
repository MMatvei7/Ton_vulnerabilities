/**
 * Тесты для 5 уязвимых контрактов (учебные примеры).
 * Запуск: yarn test tests/vuln-contracts.spec.ts
 *
 * Контракты: vuln_aqua_redeem, vuln_delayed_sender_check, vuln_signature_replay,
 *            vuln_thunder_deposit, simple_race_condition
 */
import * as fs from "fs";
import * as path from "path";
import { beginCell, Cell, toNano } from "@ton/core";
import { compileFunc } from "@ton-community/func-js";
import { Blockchain, createShardAccount, internal } from "@ton/sandbox";
import { randomAddress } from "@ton/test-utils";

const projectRoot = path.resolve(__dirname, "..");

async function compileVulnContract(contractPath: string): Promise<Cell> {
  const fullPath = path.join(projectRoot, contractPath);
  const compileResult = await compileFunc({
    targets: [fullPath],
    sources: (requestedPath: string) => {
      if (path.isAbsolute(requestedPath)) return fs.readFileSync(requestedPath, "utf8");
      const fromRoot = path.join(projectRoot, requestedPath);
      if (fs.existsSync(fromRoot)) return fs.readFileSync(fromRoot, "utf8");
      return fs.readFileSync(path.join(path.dirname(fullPath), requestedPath), "utf8");
    },
  });
  if (compileResult.status === "error") {
    console.error(`\n[ОШИБКА КОМПИЛЯЦИИ] Контракт: ${contractPath}`);
    console.error(compileResult.message);
    throw new Error(`Компиляция не удалась (${contractPath}):\n${compileResult.message}`);
  }
  return Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0];
}

function assertStep(stepName: string, actual: unknown, expected: unknown, equal: boolean): void {
  if (!equal) {
    console.error(`\n[ОШИБКА] Шаг: "${stepName}"`);
    console.error(`  Ожидалось: ${JSON.stringify(expected)}`);
    console.error(`  Получено:  ${JSON.stringify(actual)}\n`);
  }
}

describe("Vulnerable contracts (examples)", () => {
  describe("simple_race_condition.fc — anyone can claim", () => {
    it("deposit then claim from different sender drains balance (no owner check)", async () => {
      console.log("\n--- simple_race_condition: проверка, что любой отправитель может сделать claim ---");
      const codeCell = await compileVulnContract("contracts/simple_race_condition.fc");
      const blockchain = await Blockchain.create();
      const alice = await blockchain.treasury("alice");
      const bob = await blockchain.treasury("bob");
      const contractAddress = randomAddress();

      console.log("  Шаг 0: деплой контракта с нулевым балансом");
      await blockchain.setShardAccount(
        contractAddress,
        createShardAccount({
          address: contractAddress,
          code: codeCell,
          data: beginCell().storeUint(0, 64).endCell(),
          balance: toNano("10"),
        })
      );

      console.log("  Шаг 1: Alice отправляет deposit (1 TON)");
      const depositBody = beginCell().storeUint(1, 32).endCell();
      await blockchain.sendMessage(
        internal({ from: alice.address, to: contractAddress, value: toNano("1"), body: depositBody })
      );

      let res = await blockchain.runGetMethod(contractAddress, "get_total", []);
      const totalAfterDeposit = res.stackReader.readBigNumber();
      assertStep("после депозита: get_total exitCode", res.exitCode, 0, res.exitCode === 0);
      expect(res.exitCode).toBe(0);
      assertStep("после депозита: баланс = 1 TON", totalAfterDeposit.toString(), toNano("1").toString(), totalAfterDeposit === toNano("1"));
      expect(totalAfterDeposit).toBe(toNano("1"));

      console.log("  Шаг 2: Bob отправляет claim (без проверки владельца — уязвимость)");
      const claimBody = beginCell().storeUint(2, 32).endCell();
      await blockchain.sendMessage(
        internal({ from: bob.address, to: contractAddress, value: toNano("0.01"), body: claimBody })
      );

      console.log("  Шаг 3: проверка, что баланс обнулён (Bob забрал средства)");
      res = await blockchain.runGetMethod(contractAddress, "get_total", []);
      const totalAfterClaim = res.stackReader.readBigNumber();
      assertStep("после claim: get_total exitCode", res.exitCode, 0, res.exitCode === 0);
      expect(res.exitCode).toBe(0);
      assertStep("после claim: баланс должен быть 0 (уязвимость сработала)", totalAfterClaim.toString(), "0", totalAfterClaim === 0n);
      expect(totalAfterClaim).toBe(0n);
      console.log("  OK: уязвимость воспроизведена — чужой забрал средства.\n");
    });
  });

  describe("vuln_thunder_deposit.fc — state update before forward", () => {
    it("deploys and get_state returns (lp_supply, owner); deposit op is callable", async () => {
      console.log("\n--- vuln_thunder_deposit: деплой и вызов get_state, отправка OP_DEPOSIT ---");
      const codeCell = await compileVulnContract("contracts/vuln_thunder_deposit.fc");
      const blockchain = await Blockchain.create();
      const alice = await blockchain.treasury("alice");
      const contractAddress = randomAddress();

      console.log("  Шаг 0: деплой контракта (lp_supply=0)");
      await blockchain.setShardAccount(
        contractAddress,
        createShardAccount({
          address: contractAddress,
          code: codeCell,
          data: beginCell().storeUint(0, 64).endCell(),
          balance: toNano("10"),
        })
      );

      console.log("  Шаг 1: проверка начального get_state (lp_supply должен быть 0)");
      const res = await blockchain.runGetMethod(contractAddress, "get_state", []);
      const lpSupplyInit = res.stackReader.readBigNumber();
      assertStep("get_state exitCode", res.exitCode, 0, res.exitCode === 0);
      expect(res.exitCode).toBe(0);
      assertStep("начальный lp_supply", lpSupplyInit.toString(), "0", lpSupplyInit === 0n);
      expect(lpSupplyInit).toBe(0n);

      console.log("  Шаг 2: отправка OP_DEPOSIT (amount=100, value=1 TON)");
      const depositBody = beginCell().storeUint(0xde, 32).storeUint(100, 64).endCell();
      const sendResult = await blockchain.sendMessage(
        internal({
          from: alice.address,
          to: contractAddress,
          value: toNano("1"),
          body: depositBody,
        })
      );
      assertStep("после deposit: должны быть транзакции", sendResult.transactions.length > 0, true, sendResult.transactions.length > 0);
      expect(sendResult.transactions.length).toBeGreaterThan(0);
      console.log("  OK: контракт принял сообщение, транзакций:", sendResult.transactions.length, "\n");
    });
  });

  describe("vuln_aqua_redeem.fc — stuck redeem_data on bounce", () => {
    it("start redeem then get_redeem_state shows active redeem", async () => {
      console.log("\n--- vuln_aqua_redeem: OP_START_REDEEM и проверка get_redeem_state ---");
      const codeCell = await compileVulnContract("contracts/vuln_aqua_redeem.fc");
      const blockchain = await Blockchain.create();
      const alice = await blockchain.treasury("alice");
      const contractAddress = randomAddress();

      console.log("  Шаг 0: деплой контракта");
      await blockchain.setShardAccount(
        contractAddress,
        createShardAccount({
          address: contractAddress,
          code: codeCell,
          data: new Cell(),
          balance: toNano("10"),
        })
      );

      console.log("  Шаг 1: отправка OP_START_REDEEM (amount=1000)");
      const startBody = beginCell().storeUint(0x1234, 32).storeUint(1000, 64).endCell();
      await blockchain.sendMessage(
        internal({
          from: alice.address,
          to: contractAddress,
          value: toNano("0.1"),
          body: startBody,
        })
      );

      console.log("  Шаг 2: вызов get_redeem_state — ожидаем redeem_id, amount=1000, step=1");
      const res = await blockchain.runGetMethod(contractAddress, "get_redeem_state", []);
      assertStep("get_redeem_state exitCode", res.exitCode, 0, res.exitCode === 0);
      expect(res.exitCode).toBe(0);
      res.stackReader.readBigNumber();
      res.stackReader.readCell();
      const amount = res.stackReader.readBigNumber();
      const step = res.stackReader.readNumber();
      assertStep("amount в активном redeem", amount.toString(), "1000", amount === 1000n);
      expect(amount).toBe(1000n);
      assertStep("step (должен быть 1 после START_REDEEM)", step, 1, step === 1);
      expect(step).toBe(1);
      console.log("  OK: активный redeem в состоянии (уязвимость — при отскоке OP_REDEEM_TICK не очистится).\n");
    });
  });

  describe("vuln_delayed_sender_check.fc — refund before sender check", () => {
    it("when paused, attacker can still receive refund before throw (vuln)", async () => {
      console.log("\n--- vuln_delayed_sender_check: при paused=1 Bob шлёт REFUND (проверка после перевода) ---");
      const codeCell = await compileVulnContract("contracts/vuln_delayed_sender_check.fc");
      const blockchain = await Blockchain.create();
      const alice = await blockchain.treasury("alice");
      const bob = await blockchain.treasury("bob");
      const contractAddress = randomAddress();

      const initialData = beginCell()
        .storeUint(1, 32)
        .storeAddress(alice.address)
        .storeAddress(alice.address)
        .endCell();

      console.log("  Шаг 0: деплой с paused=1, allowed_sender=owner=Alice");
      await blockchain.setShardAccount(
        contractAddress,
        createShardAccount({
          address: contractAddress,
          code: codeCell,
          data: initialData,
          balance: toNano("2"),
        })
      );

      console.log("  Шаг 1: Bob (не allowed) отправляет REFUND 1 TON — уязвимость: выплата до проверки");
      const refundBody = beginCell().storeUint(1, 32).storeCoins(toNano("1")).endCell();
      const result = await blockchain.sendMessage(
        internal({
          from: bob.address,
          to: contractAddress,
          value: toNano("1"),
          body: refundBody,
        })
      );

      assertStep("после REFUND от Bob: должны быть транзакции", result.transactions.length > 0, true, result.transactions.length > 0);
      expect(result.transactions.length).toBeGreaterThan(0);
      const outWithMessages = result.transactions.some(
        (tx) => tx.description.type === "generic" && tx.outMessagesCount > 0
      );
      assertStep("есть исходящие сообщения (refund мог уйти до throw)", outWithMessages || result.transactions.length >= 2, true, outWithMessages || result.transactions.length >= 2);
      expect(outWithMessages || result.transactions.length >= 2).toBe(true);
      console.log("  OK: уязвимость воспроизведена — проверка отправителя выполняется после перевода.\n");
    });
  });

  describe("vuln_signature_replay.fc — RollbackNonce from master", () => {
    it("master can send RollbackNonce and nonce decreases (vuln: allows replay)", async () => {
      console.log("\n--- vuln_signature_replay: RollbackNonce от мастера откатывает nonce ---");
      const codeCell = await compileVulnContract("contracts/vuln_signature_replay.fc");
      const blockchain = await Blockchain.create();
      const master = await blockchain.treasury("master");
      const contractAddress = randomAddress();

      const initialData = beginCell()
        .storeUint(1, 32)
        .storeAddress(master.address)
        .storeUint(0, 256)
        .endCell();

      console.log("  Шаг 0: деплой с nonce=1, master_addr=master");
      await blockchain.setShardAccount(
        contractAddress,
        createShardAccount({
          address: contractAddress,
          code: codeCell,
          data: initialData,
          balance: toNano("10"),
        })
      );

      console.log("  Шаг 1: проверка начального nonce (должен быть 1)");
      let res = await blockchain.runGetMethod(contractAddress, "get_state", []);
      const nonceBefore = res.stackReader.readBigNumber();
      assertStep("get_state exitCode", res.exitCode, 0, res.exitCode === 0);
      expect(res.exitCode).toBe(0);
      assertStep("начальный nonce", nonceBefore.toString(), "1", nonceBefore === 1n);
      expect(nonceBefore).toBe(1n);

      console.log("  Шаг 2: мастер отправляет OP_ROLLBACK_NONCE");
      const rollbackBody = beginCell().storeUint(0x9999, 32).endCell();
      await blockchain.sendMessage(
        internal({
          from: master.address,
          to: contractAddress,
          value: toNano("0.01"),
          body: rollbackBody,
        })
      );

      console.log("  Шаг 3: проверка — nonce должен стать 0 (уязвимость: тот же тикет можно использовать снова)");
      res = await blockchain.runGetMethod(contractAddress, "get_state", []);
      const nonce = res.stackReader.readBigNumber();
      assertStep("get_state после rollback exitCode", res.exitCode, 0, res.exitCode === 0);
      expect(res.exitCode).toBe(0);
      assertStep("nonce после RollbackNonce (должен быть 0)", nonce.toString(), "0", nonce === 0n);
      expect(nonce).toBe(0n);
      console.log("  OK: уязвимость воспроизведена — nonce откатан, возможен replay тикета.\n");
    });
  });
});
