import * as fs from "fs";
import * as readline from "readline";
import { beginCell, Cell, Address, toNano, CurrencyCollection, CommonMessageInfo } from "@ton/core";
import { compileFunc } from "@ton-community/func-js";
import { Blockchain, createShardAccount, SandboxContract } from "@ton/sandbox";
import { randomAddress } from "@ton/test-utils";
import ts from 'typescript';

const Colors = {
  Reset: "\x1b[0m",

  FgBlack: "\x1b[30m",
  FgRed: "\x1b[31m",
  FgGreen: "\x1b[32m",
  FgYellow: "\x1b[33m",
  FgBlue: "\x1b[34m",
  FgMagenta: "\x1b[35m",
  FgCyan: "\x1b[36m",
  FgWhite: "\x1b[37m",
};

// Work interface

interface ContractState {
  balance?: bigint;
  code?: Cell;
  data?: Cell;
  lastTransaction?: {
    lt: string;
    hash: string;
  };
}

interface Message {
  id: number;
  type: `internal` | `external-out`;
  body: Cell;
  sender: Address;
  value?: {
    coins: bigint;
    extraCurrencies?: Cell | null;
  };
  name?: string;
}

interface Transaction {
  hash: string;
  message: Message;
  status: `success` | `failed`;
  stateChanges: ContractState;
}

interface DebugConsoleOptions {
  initialState?: ContractState;
  initialQueue?: Message[];
}


// TON Debug Console
class TONDebugConsole {
  private blockchain!: Blockchain;
  private contractAddress!: Address;
  private queue: Message[] = [];
  private executedMessages: Message[] = [];
  private transactions: Transaction[] = [];
  private stateHistory: ContractState[] = [];
  private rl: readline.Interface;
  private provider!: SandboxContract<any>;
  private scriptFn: ((q: Message[]) => void) | null = null;


  // Конструктор дебагера
  constructor(
    private options: DebugConsoleOptions,
    private codeCell: Cell
) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `tondebug> `
    });
  }


  // Инициализация дебагера
  async initialize() {
    this.blockchain = await Blockchain.create(); // создаём локально копию блокчейна
    this.contractAddress = randomAddress(); // рандомный адрес гарантирует что состояние блокчейна не зависит от истории
    this.provider = this.blockchain.provider(this.contractAddress); // сохранаем провайдер для общения с блокчейном 
    // парсинг скомпилированной версии контракта и выгрузка его в блокчейн
    const hexData = fs.readFileSync(`./tmp/tondebug.compiled.json`, `utf-8`);
    const { hex } = JSON.parse(hexData);
    const codeCell = Cell.fromBoc(Buffer.from(hex, "base64"))[0];

    // создаём начальное состояние
    const initialState = this.options.initialState || {
      balance: toNano(`1`),
      code: this.codeCell,
      data: new Cell()
    };

    // закидываем наш контракт в блокчейн
    await this.blockchain.setShardAccount(
      this.contractAddress,
      createShardAccount({
        address: this.contractAddress,
        code: initialState.code ?? codeCell,
        data: initialState.data ?? new Cell(),
        balance: initialState.balance ?? toNano(`1`),
      })
    );
    
    // Если очередь есть то сохраняем её
    if (this.options.initialQueue) {
        this.queue = this.options.initialQueue;
    }

    // Сохраняем начальное состояние в лог
    const currentState = await this.getCurrentState();
    this.stateHistory.push(currentState);

    console.log(`${Colors.FgGreen}TON Debug Console started${Colors.Reset}`);
    
    this.rl.prompt();


    // Обработка запроса из консоли
    this.rl.on(`line`, async (line) => {
      await this.handleCommand(line.trim());
      this.rl.prompt();
    }).on(`close`, () => {
      console.log(`${Colors.FgGreen}Exiting TON Debug Console${Colors.Reset}`);
      process.exit(0);
    });
  }


  // Работа с командами в консоли
  private async handleCommand(input: string): Promise<void> {
    const args = input.split(/\s+/);
    const command = args[0];
    const params = args.slice(1);

    try {
      switch (command) {
        case `help`:
          this.showHelp();
          break;
        case `run`:
          await this.handleRunCommand(params);
          break;
        case `continue`:
          await this.runAllMessages();
          break;
        case `show`:
          await this.handleShowCommand(params);
          break;
        case `load`:
          await this.handleLoadCommand(params);
          break;
        case `save`:
          await this.handleSaveCommand(params);
          break;
        case `diff`:
          await this.diffStates(params[0], params[1]);
          break;
        case `queue`:
          await this.handleQueueCommand(params);
          break;
        case `set`:
          await this.handleSetCommand(params);
          break;
        case `add`:
          await this.addMessages(params[1]);
          break;
        case `delete`:
          await this.deleteMessage(parseInt(params[1]));
          break;
        // case `script`:
        //   await this.handleScriptCommand(params);
        //   break;
        case `exit`:
          this.rl.close();
          break;
        case ``:
          break;
        default:
          console.log(`${Colors.FgBlue}Unknown command: "${command}". Type "help" for available commands.${Colors.Reset}`);
      }
    } catch (err) {
      console.log(`${Colors.FgRed}Command error: ${err instanceof Error ? err.message : String(err)}${Colors.Reset}`);
    }
  }

  // Обработать сообщение
  private async executeMessage(message: Message): Promise<boolean> {
    console.log(`\nExecuting message ${message.id}: ${message.name || `unnamed`}\n`);
    console.log(`${Colors.FgYellow}
    Type: ${message.type}, 
    Value: ${message.value || `0`}${Colors.Reset}`);

    try {
      const msgType = message.type === `internal` ? `internal` : `external-in`;
      
      // Формирование правильной структуры сообщений
      const messageInfo: CommonMessageInfo = msgType === `internal`
          ? {
              type: `internal`,
              ihrDisabled: true,
              bounce: true,
              bounced: false,
              src: message.sender,
              dest: this.contractAddress,
              value: message.value || { coins: toNano(`0.05`), extraCurrencies: null },
              forwardFee: 0n,
              ihrFee: 0n,
              createdLt: 0n,
              createdAt: 0
          }
          : {
              type: `external-in`,
              src: null,
              dest: this.contractAddress,
              importFee: 0n
          };

      // Отправка сообщения
      const result = await this.blockchain.sendMessage({
          info: messageInfo,
          body: message.body
      });

      if (!result.transactions || result.transactions.length === 0) {
          throw new Error(`No transactions were produced`);
      }
      
      const transactionResult = result.transactions[0];
      const newState = await this.getCurrentState();
      
      const transaction: Transaction = {
          hash: transactionResult.hash().toString(`hex`),
          message: message,
          status: transactionResult.description.type === `generic` ? `success` : `failed`,
          stateChanges: newState
      };
  
      // запушили состояние транзакцию и сообщение в соответствуюшие списки
      this.transactions.push(transaction);
      this.executedMessages.push(message);
      this.stateHistory.push(newState);
  
      console.log(`${Colors.FgYellow}
      Message executed successfully!

      Transaction LT: ${transactionResult.lt}
      New balance: ${newState.balance}${Colors.Reset}`);
      return true;
    } catch (err) {
      console.error(`${Colors.FgRed}Failed to execute message: ${err instanceof Error ? err.message : String(err)}${Colors.Reset}`);
      return false;
    }
  }

  // Вернуть текущее состояние --- внутренняя функция
  private async getCurrentState(): Promise<ContractState> {
    const state = await this.provider.getState();
    
    return {
      balance: state.balance,
      code: state.state.type === `active` ? state.state.code : undefined,
      data: state.state.type === `active` ? state.state.data : undefined,
      lastTransaction: state.last ? {
          lt: state.last.lt.toString(),
          hash: state.last.hash.toString(`hex`)
      } : undefined
    };
  }


  // Сохраняем текущее состояние контракта в файл ---  внутренняя функция
  private async saveState(path: string): Promise<void> {
    const state = await this.getCurrentState();
    const serialized = {
        balance: state.balance?.toString(),
        code: state.code?.toBoc().toString(`hex`),
        data: state.data?.toBoc().toString(`hex`)
    };
    await fs.promises.writeFile(path, JSON.stringify(serialized, null, 2));
    console.log(`State saved to ${Colors.FgCyan}${path}${Colors.Reset}`);
  }

  // все команды начинающиеся на run --- внутренняя функция
  private async handleRunCommand(params: string[]): Promise<void> {
    if (params.length === 0) {
        console.log(`${Colors.FgYellow}Usage: run <next|message <id>|get-method --name <method>>${Colors.Reset}`);
        return;
    }

    switch (params[0]) {
        case `next`:
            await this.runNextMessage();
            break;
        case `message`:
            if (params.length < 2) {
                console.log(`${Colors.FgCyan}Please specify message ID${Colors.Reset}`);
                return;
            }
            await this.runSpecificMessage(parseInt(params[1]));
            break;
        // case `get-method`:
        //     if (params.length < 3 || params[1] !== `--name`) {
        //         console.log(`Usage: run get-method --name <method>`);
        //         return;
        //     }
        //     await this.runGetMethod(params[2]);
        //     break;
        default:
            console.log(`${Colors.FgYellow}Invalid run command${Colors.Reset}`);
    }
  }

  private showHelp(): void {
    console.log(`${Colors.FgWhite}
    \nAvailable commands:

    ---  help                                  Show this help message
    ---  run next                              Execute next message from queue
    ---  run message <id>                      Execute specific message by ID
    ---  run get-method --name <method>        Call contract method
    ---  continue                              Execute all remaining messages
    ---  show state                            Show current contract state
    ---  show transactions                     List executed transactions
    ---  show message log                      Show executed messages log
    ---  load state <path>                     Load state from file
    ---  save state <path>                     Save current state to file
    ---  diff <path1> <path2>                  Compare two state files
    ---  queue list                            Show message queue
    ---  set queue --order <reverse/random>    Reorder queue
    ---  add messages <path>                   Add messages from JSON file
    ---  delete message <id>                   Remove message from queue
    ---  script load <path>                    Load custom queue script
    ---  script run                            Execute custom queue script
    ---  exit                                  Exit the debug console
    ${Colors.Reset}`);
  }

  // Обработать следующее сообщение
  private async runNextMessage(): Promise<void> {
    if (this.queue.length === 0) {
        console.log(`${Colors.FgYellow}Queue is empty${Colors.Reset}`);
        return;
    }

    const message = this.queue.shift()!;
    await this.executeMessage(message);
  }

    // Обработать конкретное сообщение
    private async runSpecificMessage(id: number): Promise<void> {
      const index = this.queue.findIndex(m => m.id === id);
      if (index === -1) {
          console.log(`${Colors.FgGreen}Message with ID ${id} not found in queue${Colors.Reset}`);
          return;
      }

      const message = this.queue.splice(index, 1)[0];
      await this.executeMessage(message);
  }

  // Доделать все сообщения
  private async runAllMessages(): Promise<void> {
    if (this.queue.length === 0) {
        console.log(`${Colors.FgYellow}No messages in queue${Colors.Reset}`);
        return;
    }

    console.log(`${Colors.FgBlue}Executing ${this.queue.length} messages...${Colors.Reset}`);
    while (this.queue.length > 0) {
        await this.runNextMessage();
    }
    console.log(`${Colors.FgGreen}All messages executed${Colors.Reset}`);
  }


  // все команды начинающиеся на show --- внутренняя функция
  private async handleShowCommand(params: string[]): Promise<void> {
    if (params.length === 0) {
      console.log(`Usage: show <state|transactions|message log>`);
      return;
    }

    switch (params[0]) {
      case `state`:
          await this.showState();
          break;
      case `transactions`:
          this.showTransactions();
          break;
      case `message`:
          if (params[1] === `log`) {
              this.showMessageLog();
          }
          break;
      default:
          console.log(`${Colors.FgYellow}Invalid show command${Colors.Reset}`);
    }
  }

  // показать текущее состояние
  private async showState(): Promise<void> {
    const state = await this.getCurrentState();
    
    console.log(`${Colors.FgYellow}
    \nCurrent contract state:

    Balance: ${state.balance}
    Code: ${state.code ? `present` : `none`}
    Data: ${state.data ? `present` : `none`}\n${Colors.Reset}`);
    
    if (state.lastTransaction) {
        console.log(`${Colors.FgYellow}
        \nLast transaction:

        LT: ${state.lastTransaction.lt}
        hash: ${state.lastTransaction.hash}${Colors.Reset}`);
    } else {
        console.log(`${Colors.FgWhite}No transactions yet${Colors.Reset}`);
    }
  }

  // показать список выполненных транзакций
  private showTransactions(): void {
    if (this.transactions.length === 0) {
        console.log(`${Colors.FgWhite}No transactions yet${Colors.Reset}`);
        return;
    }

    console.log(`${Colors.FgYellow}Transaction history (${this.transactions.length}):${Colors.Reset}`);
    this.transactions.forEach((tx, i) => {
        console.log(`${Colors.FgYellow}\n${i + 1}. ${tx.hash}

        Message: ${tx.message.id} (${tx.message.name || `unnamed`})
        Status: ${tx.status}
        Balance change: ${tx.stateChanges.balance}${Colors.Reset}`);
    });
  }

  // показать лог сообщений
  private showMessageLog(): void {
    if (this.executedMessages.length === 0) {
        console.log(`${Colors.FgWhite}No messages executed yet${Colors.Reset}`);
        return;
    }

    console.log(`${Colors.FgYellow}Executed messages (${this.executedMessages.length}):${Colors.Reset}`);
    this.executedMessages.forEach((msg, i) => {
        console.log(`${Colors.FgYellow}${i + 1} ID: ${msg.id}

        Name: ${msg.name || `unnamed`}
        Type: ${msg.type}${Colors.Reset}`);
    });
  }

  // задать состояние TVM вручную
  private async handleLoadCommand(params: string[]): Promise<void> {
    if (params.length < 2 || params[0] !== `state`) {
      console.log(`${Colors.FgRed}Usage: load state <path>${Colors.Reset}`);
      return;
    }

    const path = params[1];
    if (!fs.existsSync(path)) {
      console.log(`${Colors.FgRed}File not found: ${Colors.FgCyan}${path}${Colors.Reset}${Colors.Reset}`);
      return;
    }

    try {
      const data = await fs.promises.readFile(path, `utf-8`);
      const state = JSON.parse(data);
      
      if (state.balance) {
        const balance = BigInt(state.balance);
        await this.blockchain.setShardAccount(
          this.contractAddress,
          createShardAccount({
            address: this.contractAddress,
            code: state.code ? Cell.fromBoc(Buffer.from(state.code, "base64"))[0] : this.codeCell,
            data: state.data ? Cell.fromBoc(Buffer.from(state.data, "base64"))[0] : new Cell(),
            balance: balance
          })
        );
          
        console.log(`${Colors.FgWhite}State loaded. New balance: ${balance}${Colors.Reset}`);
      } else {
        console.log(`${Colors.FgRed}State loaded (no balance change)${Colors.Reset}`);
      }
      
      this.stateHistory.push(await this.getCurrentState());
    } catch (err) {
      console.error(`${Colors.FgRed}Failed to load state: ${err instanceof Error ? err.message : String(err)}${Colors.Reset}`);
    }
  }

  // Сохранить состояние TVM по конкретному пути --- внутренняя функция
  private async handleSaveCommand(params: string[]): Promise<void> {
    if (params.length < 2 || params[0] !== `state`) {
      console.log(`Usage: save state <path>`);
      return;
    }

    await this.saveState(params[1]);
  }

  // сравнить состояния по пути 1 и 2
  private async diffStates(path1: string, path2: string): Promise<void> {
    if (!fs.existsSync(path1) || !fs.existsSync(path2)) {
      console.log(`${Colors.FgRed}One or both state files not found${Colors.Reset}`);
      return;
    }

    try {
      const [state1, state2] = await Promise.all([
        fs.promises.readFile(path1, `utf-8`).then(JSON.parse),
        fs.promises.readFile(path2, `utf-8`).then(JSON.parse)
      ]);

      // непосредственно сравнение
      console.log(`\nComparing states:`);
      this.compareObjects(state1, state2);
    } catch (err) {
      console.error(`${Colors.FgRed}Failed to compare states: ${err instanceof Error ? err.message : String(err)}${Colors.Reset}`);
    }
  }
  
  // сравнить объекты 
  private compareObjects(obj1: any, obj2: any, path: string = ``): void {
    const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);

    for (const key of allKeys) {
      const currentPath = path ? `${Colors.FgCyan}${path}${Colors.Reset}.${key}` : key;
      
      if (!(key in obj1)) {
        console.log(`+ ${currentPath}: ${JSON.stringify(obj2[key])} (added)`);
        continue;
      }

      if (!(key in obj2)) {
        console.log(`- ${currentPath}: ${JSON.stringify(obj1[key])} (removed)`);
        continue;
      }

      if (typeof obj1[key] === `object` && typeof obj2[key] === `object` && 
        obj1[key] !== null && obj2[key] !== null) {
        this.compareObjects(obj1[key], obj2[key], currentPath);
      } else if (obj1[key] !== obj2[key]) {
        console.log(`~ ${currentPath}:`);
        console.log(`  - ${JSON.stringify(obj1[key])}`);
        console.log(`  + ${JSON.stringify(obj2[key])}`);
      }
    }
  }

  // работа с очередью --- внутренняя функция
  private async handleQueueCommand(params: string[]): Promise<void> {
    if (params.length === 0 || params[0] !== `list`) {
      console.log(`${Colors.FgRed}Usage: queue list${Colors.Reset}`);
      return;
    }

    this.showQueue();
  }

  // Вывести оставшиеся сообщения в очереди
  private showQueue(): void {
    if (this.queue.length === 0) {
      console.log(`${Colors.FgGreen}Queue is empty${Colors.Reset}`);
      return;
    }

    console.log(`${Colors.FgYellow}\nMessages in queue (${this.queue.length}):${Colors.Reset}`);
    this.queue.forEach(msg => {
      console.log(`${Colors.FgYellow}ID: ${msg.id}
      Name: ${msg.name || `unnamed`}
      Type: ${msg.type}
      Body: ${msg.body.toString()}
      Value: ${msg.value?.coins.toString()}
      ${Colors.Reset}`);
    });
  }

  // добавить сообщения из JSON file
  private async addMessages(path: string): Promise<void> {
    if (!fs.existsSync(path)) {
      console.log(`${Colors.FgRed}File not found: ${Colors.FgCyan}${path}${Colors.Reset}${Colors.Reset}`);
      return;
    }

    try {
      const data = await fs.promises.readFile(path, `utf-8`);
      const messages: Message[] = JSON.parse(data);
      
      let maxId = this.queue.length > 0 
        ? Math.max(...this.queue.map(m => m.id)) 
        : 0;
      messages.forEach(msg => {
        if (msg.id === undefined) {
          msg.id = ++maxId;
        }
        this.queue.push(msg);
      });

      console.log(`${Colors.FgGreen}Added ${messages.length} messages to queue${Colors.Reset}`);
      this.showQueue();
    } catch (err) {
      console.error(`${Colors.FgRed}Failed to add messages: ${err instanceof Error ? err.message : String(err)}${Colors.Reset}`);
    }
  }

  // Удалить сообщение с заданным id
  private async deleteMessage(id: number): Promise<void> {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter(m => m.id !== id);

    if (this.queue.length === initialLength) {
      console.log(`${Colors.FgRed}Message with ID ${id} not found in queue${Colors.Reset}`);
    } else {
      console.log(`${Colors.FgGreen}Message ${id} removed from queue${Colors.Reset}`);
      this.showQueue();
    }
  }

  // возможность изменить порядок сообщений: рандомоно перемешать \ развернуть список
  private async handleSetCommand(params: string[]): Promise<void> {
    if (params.length < 3 || params[0] !== `queue` || params[1] !== `--order`) {
      console.log(`Usage: set queue --order <reverse/random>`);
      return;
    }

    const order = params[2];
    switch (order) {
      case `reverse`:
        this.queue.reverse();
        console.log(`${Colors.FgGreen}Queue order reversed${Colors.Reset}`);
        break;
      case `random`:
        this.shuffleQueue();
        console.log(`${Colors.FgGreen}Queue order randomized${Colors.Reset}`);
        break;
      default:
        console.log(`${Colors.FgRed}Unknown order: ${order}. Use 'reverse' or 'random'${Colors.Reset}`);
    }
  }

  // возможность задать порядок сообщений по скрипту пользователя
  private async handleScriptCommand(params: string[]): Promise<void> {
    if (params.length === 0) {
        console.log('Usage: script <load <path>|run>');
        return;
    }

    switch (params[0]) {
        case 'load':
            if (params.length < 2) {
                console.log('Please specify script path');
                return;
            }
            await this.loadScript(params[1]);
            break;
        case 'run':
            await this.runScript();
            break;
        default:
            console.log('Invalid script command');
    }
  }

  // рандомно перемешать очередь
  private shuffleQueue(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  // загружаем скрипт по переданному пути
  private async loadScript(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return;
    }

    try {
        let script = await fs.promises.readFile(filePath, 'utf-8');
        
        if (filePath.endsWith('.ts')) {
            script = ts.transpileModule(script, {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020
              }
            }).outputText;
        }

        if (/export\s+function\s+modifyQueue/.test(script)) {
            script = script
              .replace(/export\s+function\s+modifyQueue/, 'function modifyQueue')
              + '\nmodule.exports.modifyQueue = modifyQueue;';
        }
      
        const module = { exports: {} as Record<string, any> };
        const wrapped =
            `(function (exports, module, require) { ${script}\n})(module.exports, module, require);`;
        eval(wrapped);
      
        if (typeof module.exports.modifyQueue !== 'function') {
            console.error('Script must export function "modifyQueue(queue)"');
            return;
        }
        this.scriptFn = module.exports.modifyQueue as (q: Message[]) => void;
        console.log(`Script loaded from ${filePath}`);
    } catch (err) {
        console.error(`Failed to load script: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // применяем скрипт к очереди
  private async runScript(): Promise<void> {
      if (!this.scriptFn) {
          console.warn('No script loaded – nothing to run');
          return;
      }
      console.log('Running custom queue script');
      await this.scriptFn(this.queue);
      console.log('Queue after script execution:');
      this.showQueue();
  }
}

// Компиляция контракта
async function compileContract(contractPath: string): Promise<Cell> {
  const compileResult = await compileFunc({
    targets: [contractPath],
    sources: (x) => fs.readFileSync(x).toString("utf8"),
  });

  if (compileResult.status === "error") {
    console.log(`${Colors.FgRed}
    - OH NO! Compilation Errors! The compiler output was:
    \n${compileResult.message}${Colors.Reset}`);
    throw new Error(`\n${Colors.FgRed}Compilation failed${Colors.Reset}`);
  }

  const codeCell = Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0];
  console.log(`${Colors.FgGreen}Compilation successful!${Colors.Reset}`);
  
  if (!fs.existsSync(`tmp`)) {
    fs.mkdirSync(`tmp`);
    console.log(`${Colors.FgWhite}Created tmp directory${Colors.Reset}`);
  }

  const hexArtifact = `tmp/tondebug.compiled.json`;

  fs.writeFileSync(
    hexArtifact,
    JSON.stringify({
      hex: Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0]
        .toBoc()
        .toString("base64"),
    })
  );

  console.log(`${Colors.FgGreen}Compiled code saved to${Colors.Reset}` + hexArtifact);

  return codeCell;
}


// Начальное состояние
async function validateInitState(path: string): Promise<ContractState> {
  const state = JSON.parse(fs.readFileSync(path, `utf-8`));

  const validFields = [`balance`, `code`, `data`];
  const invalidFields = Object.keys(state).filter(
      key => !validFields.includes(key)
  );
      
  if (invalidFields.length > 0) {
      throw new Error(`${Colors.FgRed}Invalid fields in state file: ${invalidFields.join(`, `)}${Colors.Reset}`);
  }
  if (!state.balance && !state.code && !state.data) {
    throw new Error(`${Colors.FgRed}State file must contain at least one of: balance, code, data${Colors.Reset}`);
  } 

  const resultState: ContractState = {};
  if (state.balance) {
      resultState.balance = BigInt(state.balance);
  }
  if (state.code) {
      resultState.code = Cell.fromBoc(Buffer.from(state.code, "hex"))[0];
  }
  if (state.data) {
      resultState.data = Cell.fromBoc(Buffer.from(state.data, "base64"))[0];
  }

  return resultState;
}


// Загружаем очередь сообщений для обработки в TON Debug Console
async function loadMessageQueue(path: string): Promise<Message[]> {
  if (!fs.existsSync(path)) {
      throw new Error(`Queue file not found: ${Colors.FgCyan}${path}${Colors.Reset}`);
  }

  const messages = JSON.parse(fs.readFileSync(path, `utf-8`));
  if (!Array.isArray(messages)) {
      throw new Error(`Queue file must contain an array of messages`);
  }

  const res =  messages.map((msg, i) => ({
      id: msg.id || i + 1,
      type: msg.type || `external`,
      sender: randomAddress(),
      body: msg.body ? Cell.fromBoc(Buffer.from(msg.body, `base64`))[0] : new Cell(),
      value: msg.value,
      name: msg.name
  }));

  return res;
}


// непосредственно main

async function main() {
  const args = process.argv.slice(2);
  
  // В начале работы выводим вспомогательное сообщение
  if (args.includes(`--help`) || args.length === 0) {
      printHelp();
      return;
  }

  const contractIndex = args.indexOf(`--contract`);
  if (contractIndex === -1 || contractIndex === args.length - 1) {
      console.error(`${Colors.FgRed}Error: --contract flag requires a path argument${Colors.Reset}`);
      printHelp();
      return;
  }

  // Если не удалось найти контракт
  const contractPath = args[contractIndex + 1];
  if (!fs.existsSync(contractPath)) {
      console.error(`${Colors.FgRed}Contract file not found: ${contractPath}${Colors.Reset}`);
      return;
  }
  
  // Фиксируем начальное состояние и очередь
  const initStateIndex = args.indexOf(`--init-state`);
  const queueIndex = args.indexOf(`--queue`);


  // Работа с контрактом
  try {
    // Компилирем контракт
    const codeCell = await compileContract(contractPath);
    const options: DebugConsoleOptions = {};
    
    // Задаём начальное состояние 
    
    if (initStateIndex !== -1 && initStateIndex < args.length - 1) {
        const statePath = args[initStateIndex + 1];
        options.initialState = await validateInitState(statePath);
    }

    // Инициализиуем очередь
    
    if (queueIndex !== -1 && queueIndex < args.length - 1) {
        const queuePath = args[queueIndex + 1];
        options.initialQueue = await loadMessageQueue(queuePath);
    }

    // Создаём консоль дебага
    const debugConsole = new TONDebugConsole(options, codeCell);
    await debugConsole.initialize();
  } catch (err) {
      console.error(`${Colors.FgRed}${err}${Colors.Reset}`);
      process.exit(1);
  }
}

// Помощь
function printHelp(): void {
  console.log(`${Colors.FgGreen}
TON Debug Console - Interactive debugger for TON smart contracts

Usage:
tondebug --contract <path> [--init-state <path>] [--queue <path>] [--help]

Options:
--contract <path>    Path to FunC contract source file
--init-state <path>  Path to initial state JSON file
--queue <path>       Path to initial message queue JSON file
--help               Show this help message

Example:
tondebug --contract ./my-contract.fc --init-state ./state.json --queue ./messages.json
${Colors.Reset}`);
}

main().catch(console.error);