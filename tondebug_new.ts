import * as fs from "fs";
import * as readline from "readline";
import { beginCell, Cell, Address, toNano, CurrencyCollection, CommonMessageInfo } from "@ton/core";
import { compileFunc } from "@ton-community/func-js";
import { Blockchain, createShardAccount, SandboxContract, PendingMessage, BlockchainTransaction, printTransactionFees } from "@ton/sandbox";
import { randomAddress } from "@ton/test-utils";
import ts from 'typescript';

// Work interface

interface GeneratedMessage {
  id: number;
  type: string;
  body: string;
  value: {
      coins: string;
      extraCurrencies: null;
  };
  senderId: number;
  name: string;
}

interface ExperimentContractState {
  balance: string;
  total: number;
  owner_address: string | null;
  owner_id?: string;
  state: {
      type: 'active' | 'frozen' | 'uninit';
      code?: string | null; // hex-строка
      data?: string | null; // hex-строка
      stateHash?: string; // для frozen
  };
}

interface ContractState {
    balance?: bigint;
    code?: Cell;
    data?: Cell;
    lastTransaction?: {
        lt: string;
        hash: string;
    };
    type?: 'active' | 'frozen' | 'uninit';
    stateHash?: string; // для frozen type
}

interface Message {
  id: number;
  type: 'internal' | 'external-in';
  body: Cell;
  sender: Address;
  value?: {
    coins: bigint;
    extraCurrencies?: Cell | null;
  };
  name?: string;
}

interface Transaction {
  transaction: BlockchainTransaction,
  message: Message;
  stateChanges: ContractState;
}

interface DebugConsoleOptions {
    initialState?: ContractState;
    initialQueue?: Message[];
}

const SENDERS_LIST: Record<number, Address> = {};

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
          prompt: 'tondebug> '
      });
  }


  // Инициализация дебагера
  async initialize() {
    this.blockchain = await Blockchain.create(); // создаём локально копию блокчейна
    this.contractAddress = randomAddress(); // рандомный адрес гарантирует что состояние блокчейна не зависит от истории
    this.provider = this.blockchain.provider(this.contractAddress); // сохранаем провайдер для общения с блокчейном 
    // парсинг скомпилированной версии контракта и выгрузка его в блокчейн
    const hexData = fs.readFileSync('./tmp/tondebug.compiled.json', 'utf-8');
    const { hex } = JSON.parse(hexData);
    const codeCell = Cell.fromBoc(Buffer.from(hex, "base64"))[0];

    // создаём дефолтное начальное состояние
    const initialState = this.options.initialState || {
        balance: toNano('1'),
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
            balance: initialState.balance ?? toNano('1'),
        })
    );
    
    // Если очередь есть то сохраняем её
    if (this.options.initialQueue) {
        this.queue = this.options.initialQueue;
    }

    // Сохраняем начальное состояние в лог
    const currentState = await this.getCurrentState();
    this.stateHistory.push(currentState);

    console.log(`
 \u001b[36m   ╔════════════════════════════════════════════════════╗
    ║\u001b[1;34m               TON Debug Console Started            \u001b[0;36m║
    ╚════════════════════════════════════════════════════╝\u001b[0m

      \u001b[33mType '\u001b[35mexit\u001b[33m' to quit.\u001b[0m
    `);
    this.showHelp();
    this.rl.prompt();

    // Обработка запроса из консоли
    this.rl.on('line', async (line) => {
        await this.handleCommand(line.trim());
        this.rl.prompt();
    }).on('close', () => {
        console.log("Exiting TON Debug Console");
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
        case 'help':
          this.showHelp();
          break;
        case 'run':
          await this.handleRunCommand(params);
          break;
        case 'continue':
          await this.runAllMessages();
          break;
        case 'show':
          await this.handleShowCommand(params);
          break;
        case 'load':
          await this.handleLoadCommand(params);
          break;
        case 'save':
          await this.handleSaveCommand(params);
          break;
        case 'diff':
          await this.diffStates(params[0], params[1]);
          break;
        case 'queue':
          await this.handleQueueCommand(params);
          break;
        case 'set':
          await this.handleSetCommand(params);
          break;
        case 'add':
          await this.addMessages(params[1]);
          break;
        case 'delete':
          await this.deleteMessage(parseInt(params[1]));
          break;
        case 'script':
          await this.handleScriptCommand(params);
          break;
        case 'experiment':
          await this.experiment();
          break;
        case 'exit':
          this.rl.close();
          break;
        case '':
          break;
        default:
          console.log(`          
            \u001b[33mCommand not recognized:\u001b[0m \u001b[35m"${command}"\u001b[0m
            \u001b[36mType \u001b[32m"help"\u001b[36m to see available commands\u001b[0m
          `);
      }
    } catch (err) {
        console.error(`Command error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // основной метод для воспроизведения численного эксперимента
  private async experiment() {
    let total_sum = 0;
    for (let n = 0; n < 100; n++) {
      for (let i = 0; i < 1000; i++) {
          this.shuffleQueue();
          // let order = await this.getPythonScriptToGenerateOrderQueue(this.queue.length);
          this.showQueue();
          const queueLength = this.queue.length;
          for (let j = 0; j < queueLength; j++) {
            await this.runNextMessage();
            // await this.runSpecificMessage(order[j]);
            // await this.sleep(2000);
            this.shuffleQueue();
          }
          if (i == 0) {
            await this.saveExperimentState('tmp/first_exp_state.json')
          } else {
            await this.saveExperimentState('tmp/last_exp_state.json')
            const diff = await this.diffExperimentContractState('tmp/first_exp_state.json', 'tmp/last_exp_state.json')

            if (diff) {
              fs.unlinkSync('tmp/last_exp_state.json');
            } else {
              console.log(`Состояния не совпали, номер итерации "${i + 1}"`);
              const iterationNumber = i + 1;
              total_sum += iterationNumber;
              fs.appendFileSync('tmp/iterations.txt', `${iterationNumber} `, 'utf8');
              
              await this.addMessages('tmp/generated_queue.json')
              const params = ['state', 'states/initial_rc_state.json']
              await this.handleLoadCommand(params);

              break;
            }
          }

          await this.addMessages('tmp/generated_queue.json')
          const params = ['state', 'states/initial_rc_state.json']
          await this.handleLoadCommand(params);
          console.log(`Итерация "${i + 1}"`);
      }
    }
    console.log(`Total sum: "${total_sum}"`)
  }

  // метод для воспроизведения питон скрипта для получения рандомного порядка сообщений (для эксперимента)
  private async getPythonScriptToGenerateOrderQueue(n: number): Promise<number[]> {
    const { execSync } = require('child_process');
    try {
        console.log(n);
        const result = execSync(`python3 tmp/shuffle_script.py ${n}`).toString().trim();;
        console.log(result);
        return result.split(' ').map(Number);
    } catch (error) {
        console.error('Error calling Python script:', error);
        return [];
    }
  }

  // метод для засыпания (использовался для эксперимента, чтобы легче было дебажить)
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // метод сравнения состояний контракта (для эксперимента)
  private async diffExperimentContractState(path1: string, path2:string): Promise<boolean> {
    const state1: ExperimentContractState = JSON.parse(fs.readFileSync(path1, 'utf8'));
    const state2: ExperimentContractState = JSON.parse(fs.readFileSync(path2, 'utf8'));

    // if (state1.balance !== state2.balance) {
    //   console.log(`Balance mismatch: ${state1.balance} vs ${state2.balance}`);
    //   return false;
    // }

    if (state1.total !== state2.total) {
        console.log(`Total mismatch: ${state1.total} vs ${state2.total}`);
        return false;
    }

    if (state1.owner_address !== state2.owner_address) {
      console.log(`Owner mismatch: ${state1.owner_address} vs ${state2.owner_address}`);
      return false;
    }

    if (state1.state.type !== state2.state.type) {
      console.log(`State type mismatch: ${state1.state.type} vs ${state2.state.type}`);
      return false;
    }

    switch (state1.state.type) {
      case 'active':
          if (state2.state.type !== 'active') return false;
          
          if (state1.state.code !== state2.state.code) {
              console.log('Code mismatch');
              return false;
          }

          if (state1.state.data !== state2.state.data) {
              console.log('Data mismatch');
              return false;
          }
          break;

      case 'frozen':
          if (state2.state.type !== 'frozen') return false;
          
          if (state1.state.stateHash !== state2.state.stateHash) {
              console.log('State hash mismatch');
              return false;
          }
          break;

      case 'uninit':
          if (state2.state.type !== 'uninit') return false;
          break;
    }
  
    return true;
  }

  // метод для сохранения состояния контракта (для эксперимента)
  private async saveExperimentState(filename: string) {
    const state = await this.provider.getState();
    const data = await this.blockchain.runGetMethod(this.contractAddress, 'get_state', []);
    const total = data.stackReader.readNumber();
    // console.log(data.stack.length);
    let ownerAddress = null;
    try {
      ownerAddress = data.stackReader.readAddress();
    } catch (e) {
    }
    // const ownerId = this.senderByAddr(ownerAddress);
    console.log(ownerAddress);
    const serializableState = {
      balance: state.balance.toString(),
      total: total,
      owner_address: ownerAddress?.toString() || null,
      // owner_id: ownerId,
      state: (() => {
          switch (state.state.type) {
              case 'active':
                  return {
                      type: 'active',
                      code: state.state.code?.toString('hex') || null,
                      data: state.state.data?.toString('hex') || null
                  };
              case 'frozen':
                  return {
                      type: 'frozen',
                      stateHash: state.state.stateHash.toString('hex')
                  };
              case 'uninit':
                  return {
                      type: 'uninit'
                  };
          }
      })()
    };
    await fs.promises.writeFile(filename, JSON.stringify(serializableState, null, 2));
  }

  // Обработать сообщение
  private async executeMessage(message: Message): Promise<boolean> {
      console.log(`
        \u001b[36m╔════════════════════════════════════════════════════╗
        \u001b[36m║\u001b[1;34m               Executing Message                    \u001b[0;36m║
        \u001b[36m╚════════════════════════════════════════════════════╝\u001b[0m
      
        \u001b[33mMessage ID:\u001b[0m   \u001b[35m${message.id}\u001b[0m
        \u001b[33mName:\u001b[0m        \u001b[32m${message.name || 'unnamed'}\u001b[0m
        \u001b[33mType:\u001b[0m        \u001b[36m${message.type}\u001b[0m
        \u001b[33mValue:\u001b[0m       \u001b[35m${message.value?.coins || '0'}\u001b[0m
        \u001b[33mSender:\u001b[0m      \u001b[36m${this.senderByAddr(message.sender)}\u001b[0m
      `);

    try {
      const msgType = message.type === 'internal' ? 'internal' : 'external-in';
      
      // Формирование правильной структуры сообщений
      const messageInfo: CommonMessageInfo = msgType === 'internal'
          ? {
              type: 'internal',
              ihrDisabled: true,
              bounce: true,
              bounced: false,
              src: message.sender,
              dest: this.contractAddress,
              value: message.value || { coins: toNano('0.05'), extraCurrencies: null },
              forwardFee: 0n,
              ihrFee: 0n,
              createdLt: 0n,
              createdAt: 0
          }
          : {
              type: 'external-in',
              src: null,
              dest: this.contractAddress,
              importFee: 0n
          };
      
      const iter = await this.blockchain.sendMessageIter({
        info: messageInfo, 
        body: message.body,
      });

      let step = 0;
      const result : BlockchainTransaction[] = []
      for await (const tx of iter) {
         result.push(tx);
         step++;
          if (step == 1) {
            break;
          }
      }
      
      // TODO: выяснить почему это влияет на эксперимент
      // const messageQueue: PendingMessage[] = (this.blockchain as any).messageQueue;
      // for (const pm of messageQueue) {
      //   if (pm.type !== 'message') {
      //       continue;
      //   }           
    
      //   const { info, body } = pm;
      //   const infoType = (info as any).type as string;
    
      //   if (infoType !== 'internal' && infoType !== 'external-in') continue;
    
      //   const sender = (info as any).src as Address;
    
      //   const value =
      //       infoType === 'internal'
      //           ? {
      //               coins: (info as any).value.coins as bigint,
      //               extraCurrencies: (info as any).value.extraCurrencies ?? null,
      //             }
      //           : undefined;
      //   let maxId = this.queue.length > 0 
      //           ? Math.max(...this.queue.map(m => m.id)) 
      //           : 0;

      //   const msg: Message = {
      //       id: ++maxId,
      //       type: infoType as 'internal' | 'external-in',
      //       body,
      //       sender,
      //       value,
      //   };

      //   this.queue.push(msg);
      // }    
      if (!result) {
          throw new Error('No transactions were produced');
      }

      const newState = await this.getCurrentState();
      const transaction: Transaction = {
        transaction: result[0],
        message: message,
        stateChanges: newState
      }

      // запушили состояние транзакцию и сообщение в соответствуюшие списки
      this.transactions.push(transaction);
      this.executedMessages.push(message);
      this.stateHistory.push(newState);
  
      console.log(`
        \u001b[36m╔════════════════════════════════════════════════════╗
        \u001b[36m║\u001b[1;34m              Transaction Executed                  \u001b[0;36m║
        \u001b[36m╚════════════════════════════════════════════════════╝\u001b[0m
      
        \u001b[33mContract Address:\u001b[0m \u001b[35m${transaction.transaction.address}\u001b[0m
        \u001b[33mCurrent Balance:\u001b[0m  \u001b[32m${newState.balance}\u001b[0m
      
        \u001b[36mTransaction Details:\u001b[0m
          \u001b[33mLT:\u001b[0m \u001b[35m${transaction.transaction.lt}\u001b[0m
          \u001b[33mHash:\u001b[0m \u001b[35m${transaction.transaction.hash().toString('hex')}\u001b[0m
          \u001b[33mStatus:\u001b[0m \u001b[36m${transaction.transaction.endStatus}\u001b[0m
          \u001b[33mOut Msgs:\u001b[0m \u001b[35m${transaction.transaction.outMessagesCount}\u001b[0m
      
        \u001b[36mPrevious Transaction:\u001b[0m
          \u001b[33mLT:\u001b[0m \u001b[35m${transaction.transaction.prevTransactionLt}\u001b[0m
          \u001b[33mHash:\u001b[0m \u001b[35m${transaction.transaction.prevTransactionHash}\u001b[0m
      
        \u001b[33mTransaction fees:\u001b[0m
      `);

      console.log(printTransactionFees(result));
      return true;
    } catch (err) {
      console.error(`\u001b[31m✖\u001b[0m Failed to execute message: \u001b[33m${err instanceof Error ? err.message : String(err)}\u001b[0m`);
      return false;
    }
  }

  // Вернуть текущее состояние --- внутренняя функция
  private async getCurrentState(): Promise<ContractState> {
    const state = await this.provider.getState();
    
    return {
      balance: state.balance,
      type: state.state.type,
      code: state.state.type === 'active' ? state.state.code : undefined,
      data: state.state.type === 'active' ? state.state.data : undefined,
      stateHash: state.state.type === 'frozen' ? state.state.stateHash.toString('hex') : undefined,
      lastTransaction: state.last ? {
          lt: state.last.lt.toString(),
          hash: state.last.hash.toString('hex')
      } : undefined
    };
  }

  // Сохраняем текущее состояние контракта в файл ---  внутренняя функция
  private async saveState(path: string): Promise<void> {
    const state = await this.getCurrentState();

    const serialized = {
        last: state.lastTransaction ? {
          lt: state.lastTransaction.lt.toString(),
          hash: state.lastTransaction.hash} : null,
        balance: state.balance?.toString(),
        code: state.code?.toString('hex'),
        data: state.data?.toString('hex'),
        type: state.type,
        stateHash: state.stateHash
    };
    await fs.promises.writeFile(path, JSON.stringify(serialized, null, 2));
    console.log(`\n\u001b[32m✓ State saved to ${path}\u001b[0m\n`);
  }

  // все команды начинающиеся на run --- внутренняя функция
  private async handleRunCommand(params: string[]): Promise<void> {
    if (params.length === 0) {
        console.log(`\n\u001b[33mUsage: run <next|message <id>|get-method --name <method>>\u001b[0m\n`);
        return;
    }

    switch (params[0]) {
        case 'next':
            await this.runNextMessage();
            break;
        case 'message':
            if (params.length < 2) {
                console.log(`\n\u001b[33mPlease specify message ID\u001b[0m\n`);
                return;
            }
            await this.runSpecificMessage(parseInt(params[1]));
            break;
        // case 'get-method':
        //     if (params.length < 3 || params[1] !== '--name') {
        //       console.log(`\n\u001b[33mUsage: run get-method --name <method>\u001b[0m\n`);
        //         return;
        //     }
        //     await this.runGetMethod(params[2]);
        //     break;
        default:
            console.log('Invalid run command');
    }
  }

  private showHelp(): void {
      console.log(`
    \u001b[36m╔════════════════════════════════════════════════════╗
    \u001b[36m║\u001b[1;34m                Command Reference                   \u001b[0;36m║
    \u001b[36m╚════════════════════════════════════════════════════╝\u001b[0m
  
      \u001b[32mrun next\u001b[0m                           - Execute next message from queue
      \u001b[32mrun message \u001b[35m<id>\u001b[0m                   - Execute specific message by ID
      \u001b[32mcontinue\u001b[0m                           - Execute all remaining messages
      \u001b[32mqueue list\u001b[0m                         - Show message queue
      \u001b[32mset queue \u001b[35m--order reverse/random\u001b[0m   - Reorder queue
      \u001b[32madd messages \u001b[35m<path>\u001b[0m                - Add messages from JSON file
      \u001b[32mdelete message \u001b[35m<id>\u001b[0m                - Remove message from queue
      \u001b[32mscript load \u001b[35m<path>\u001b[0m                 - Load custom queue script
      \u001b[32mscript run\u001b[0m                         - Execute custom queue script

      \u001b[32mshow state\u001b[0m                         - Show current contract state
      \u001b[32mload state \u001b[35m<path>\u001b[0m                  - Load state from file
      \u001b[32msave state \u001b[35m<path>\u001b[0m                  - Save current state to file
      \u001b[32mdiff \u001b[35m<path1> <path2>\u001b[0m               - Compare two state files

      \u001b[32mshow transactions\u001b[0m                  - List executed transactions
      \u001b[32mshow message log\u001b[0m                   - Show executed messages log

      \u001b[32mhelp\u001b[0m                               - Show this help message
      \u001b[32mexit\u001b[0m                               - Exit the debug console
    `);
  }

  // Обработать следующее сообщение
  private async runNextMessage(): Promise<void> {
    if (this.queue.length === 0) {
        console.log('Queue is empty');
        return;
    }

    const message = this.queue.shift()!;
    await this.executeMessage(message);
  }

    // Обработать конкретное сообщение
    private async runSpecificMessage(id: number): Promise<void> {
      const index = this.queue.findIndex(m => m.id === id);
      if (index === -1) {
          console.log(`\n\u001b[33mMessage with ID ${id} not found in the queue\u001b[0m\n`);
          return;
      }

      const message = this.queue.splice(index, 1)[0];
      await this.executeMessage(message);
  }

  // Доделать все сообщения
  private async runAllMessages(): Promise<void> {
    if (this.queue.length === 0) {
        console.log(`\n\u001b[33mNo messages in the queue\u001b[0m\n`);
        return;
    }

      console.log(`
        \u001b[36m╔════════════════════════════════════════════════════╗
        \u001b[36m║\u001b[1;34m             Processing Message Queue               \u001b[0;36m║
        \u001b[36m╚════════════════════════════════════════════════════╝\u001b[0m
        
        \u001b[33mTotal messages:\u001b[0m \u001b[35m${this.queue.length}\u001b[0m
      `);

    while (this.queue.length > 0) {
        await this.runNextMessage();
    }

    console.log(`\n\u001b[32m✓ All messages executed successfully!\u001b[0m\n`);
  }

  // все команды начинающиеся на show --- внутренняя функция
  private async handleShowCommand(params: string[]): Promise<void> {
    if (params.length === 0) {
      console.log(`\n\u001b[33mUsage: show <state|transactions|message log>\u001b[0m\n`);
      return;
    }

    switch (params[0]) {
      case 'state':
          await this.showState();
          break;
      case 'transactions':
          this.showTransactions();
          break;
      case 'message':
          if (params[1] === 'log') {
              this.showMessageLog();
          }
          break;
      default:
          console.log(`\n\u001b[33mInvalid show command\u001b[0m\n`);
    }
  }

  // показать текущее состояние
  private async showState(): Promise<void> {
    const state = await this.getCurrentState();

    console.log(`
      \u001b[36m╔════════════════════════════════════════════════════╗
      \u001b[36m║\u001b[1;34m              Current Contract State                \u001b[0;36m║
      \u001b[36m╚════════════════════════════════════════════════════╝\u001b[0m
    
      \u001b[33mBalance:\u001b[0m \u001b[35m${state.balance?.toString() || 'N/A'}\u001b[0m
      \u001b[33mStatus:\u001b[0m  \u001b[32m${state.type || 'unknown'}\u001b[0m
    `);

    switch (state.type) {
      case 'active':
        console.log(`
      \u001b[33mCode:\u001b[0m \u001b[36m${state.code?.toString('hex') || 'null'}\u001b[0m
      \u001b[33mData:\u001b[0m \u001b[36m${state.data?.toString('hex') || 'null'}\u001b[0m
        `);
        break;
      case 'frozen':
        console.log(`
      \u001b[33mState Hash:\u001b[0m \u001b[35m${state.stateHash || 'null'}\u001b[0m
        `);
        break;
    }
    
    if (state.lastTransaction) {
      console.log(`
      \u001b[33mLast Transaction:\u001b[0m
        \u001b[36mLT:\u001b[0m   \u001b[35m${state.lastTransaction.lt}\u001b[0m
        \u001b[36mHash:\u001b[0m \u001b[35m${state.lastTransaction.hash}\u001b[0m
        `);
    } else {
      console.log('\n  \u001b[33mNo transactions yet\u001b[0m');
    }
  }

  // показать список выполненных транзакций
  private showTransactions(): void {
    if (this.transactions.length === 0) {
        console.log(`\n\u001b[33mNo transactions yet\u001b[0m\n`);
        return;
    }

    console.log(`\n\u001b[32mTransaction history (${this.transactions.length}):\u001b[0m`);
    this.transactions.forEach((tx, i) => {
        console.log(`    
          \u001b[33m\n${i + 1}. ${tx.transaction.hash().toString('hex')}\u001b[0m

          \u001b[33mContract Address:\u001b[0m \u001b[35m${tx.transaction.address}\u001b[0m
          \u001b[33mCurrent Balance:\u001b[0m  \u001b[32m${tx.stateChanges.balance}\u001b[0m
        
          \u001b[36mTransaction Details:\u001b[0m
            \u001b[33mLT:\u001b[0m \u001b[35m${tx.transaction.lt}\u001b[0m
            \u001b[33mHash:\u001b[0m \u001b[35m${tx.transaction.hash().toString('hex')}\u001b[0m
            \u001b[33mStatus:\u001b[0m \u001b[36m${tx.transaction.endStatus}\u001b[0m
            \u001b[33mOut Msgs:\u001b[0m \u001b[35m${tx.transaction.outMessagesCount}\u001b[0m
        
          \u001b[36mPrevious Transaction:\u001b[0m
            \u001b[33mLT:\u001b[0m \u001b[35m${tx.transaction.prevTransactionLt}\u001b[0m
            \u001b[33mHash:\u001b[0m \u001b[35m${tx.transaction.prevTransactionHash}\u001b[0m
        
          \u001b[33mMessage:\u001b[0m \u001b[35m${tx.message.id} (${tx.message.name || 'unnamed'})\u001b[0m  
        `);
    });
  }

  // показать лог сообщений
  private showMessageLog(): void {
    if (this.executedMessages.length === 0) {
        console.log(`\n\u001b[33mNo messages executed yet\u001b[0m\n`);
        return;
    }

    console.log(`\n\u001b[33mExecuted messages:\u001b[0m \u001b[33m${this.executedMessages.length}\u001b[0m messages\n`);
    this.executedMessages.forEach((msg, i) => {
      const num = (i + 1).toString().padStart(2, ' ');
      console.log(
        `  \u001b[36m${num}.\u001b[0m ` +
        `ID: \u001b[34m${msg.id}\u001b[0m, ` +
        `Name: \u001b[34m${msg.name || 'unnamed'},\u001b[0m ` +
        `Type: \u001b[34m${msg.type}, \u001b[0m ` +
        `from Sender: \u001b[34m${this.senderByAddr(msg.sender)}\u001b[0m\n`
      );
    });
  }

  // задать состояние TVM вручную
  private async handleLoadCommand(params: string[]): Promise<void> {
    if (params.length < 2 || params[0] !== 'state') {
      console.log(`\n\u001b[33mUsage: load state <path>\u001b[0m\n`);
      return;
    }

    const path = params[1];
    if (!fs.existsSync(path)) {
      console.log(`\n\u001b[33mFile not found: ${path}\u001b[0m\n`);
      return;
    }

    try {
      const data = await fs.promises.readFile(path, 'utf-8');
      const state = JSON.parse(data);
      
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

      console.log(`\n\u001b[32m✓ State loaded.\u001b[0m\n`);
      console.log(await this.showState());
      
      this.stateHistory.push(await this.getCurrentState());
    } catch (err) {
      console.error(`\u001b[31m✖\u001b[0m Failed to load state: \u001b[33m${err instanceof Error ? err.message : String(err)}\u001b[0m`);
    }
  }

  // Сохранить состояние TVM по конкретному пути --- внутренняя функция
  private async handleSaveCommand(params: string[]): Promise<void> {
    if (params.length < 2 || params[0] !== 'state') {
      console.log(`\n\u001b[33mUsage: save state <path>\u001b[0m\n`);
      return;
    }

    await this.saveState(params[1]);
  }

  // сравнить состояния по пути 1 и 2
  private async diffStates(path1: string, path2: string): Promise<void> {
    if (!fs.existsSync(path1) || !fs.existsSync(path2)) {
      console.log(`\n\u001b[33mOne or both state files not found\u001b[0m\n`);
      return;
    }

    try {
      const [state1, state2] = await Promise.all([
        fs.promises.readFile(path1, 'utf-8').then(JSON.parse),
        fs.promises.readFile(path2, 'utf-8').then(JSON.parse)
      ]);

      console.log(`\n\u001b[33mComparing states:\u001b[0m\n`);
      this.compareObjects(state1, state2);
    } catch (err) {
      console.error(`\u001b[31m✖\u001b[0m Failed to compare states: \u001b[33m${err instanceof Error ? err.message : String(err)}\u001b[0m`);
    }
  }
  
  // сравнить объекты 
  private compareObjects(obj1: any, obj2: any, path: string = ''): void {
    const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);

    for (const key of allKeys) {
      const currentPath = path ? `${path}.${key}` : key;
      
      if (!(key in obj1)) {
        console.log(`+ ${currentPath}: ${JSON.stringify(obj2[key])} (added)`);
        continue;
      }

      if (!(key in obj2)) {
        console.log(`- ${currentPath}: ${JSON.stringify(obj1[key])} (removed)`);
        continue;
      }

      if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object' && 
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
    if (params.length === 0 || params[0] !== 'list') {
      console.log(`\n\u001b[33mUsage: queue list\u001b[0m\n`);
      return;
    }

    this.showQueue();
  }

  // Вывести оставшиеся сообщения в очереди
  private showQueue(): void {
    if (this.queue.length === 0) {
      console.log(`\n\u001b[33mThe message queue is currently empty\u001b[0m\n`);
      return;
    }

    console.log(`\n\u001b[33mMessages in queue:\u001b[0m \u001b[33m${this.queue.length}\u001b[0m messages\n`);
    this.queue.forEach((msg, i) => {
      const num = (i + 1).toString().padStart(2, ' ');
      console.log(
        `  \u001b[36m${num}.\u001b[0m ` +
        `ID: \u001b[34m${msg.id}\u001b[0m, ` +
        `Name: \u001b[34m${msg.name || 'unnamed'},\u001b[0m ` +
        `Type: \u001b[34m${msg.type}, \u001b[0m ` +
        `from Sender: \u001b[34m${this.senderByAddr(msg.sender)}\u001b[0m\n`
      );
    });
  }

  private senderByAddr(addr: Address): number | undefined {
    return (Object.entries(SENDERS_LIST).find(([, a]) => a.equals(addr)))?.[0] as unknown as number | undefined;
  }

  // добавить сообщения из JSON file
  private async addMessages(path: string): Promise<void> {
    if (!fs.existsSync(path)) {
      console.log(`\n\u001b[33mFile not found: ${path}\u001b[0m\n`);
      return;
    }

    try {
      const messages = await loadMessageQueue(path);
      
      let maxId = this.queue.length > 0 
        ? Math.max(...this.queue.map(m => m.id)) 
        : 0;
      messages.forEach(msg => {
        msg.id = ++maxId;
        this.queue.push(msg);
      });

      this.showQueue();
    } catch (err) {
      console.error(`\u001b[31m✖\u001b[0m Failed to add messages: \u001b[33m${err instanceof Error ? err.message : String(err)}\u001b[0m`);
    }
  }

  // Удалить сообщение с заданным id
  private async deleteMessage(id: number): Promise<void> {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter(m => m.id !== id);

    if (this.queue.length === initialLength) {
      console.log(`\n\u001b[33mMessage with ID ${id} not found in the queue\u001b[0m\n`);
    } else {
      console.log(`\n\u001b[32m✓ Message ${id} removed from the queue\u001b[0m`);
      this.showQueue();
    }
  }

  // возможность изменить порядок сообщений: рандомоно перемешать \ развернуть список
  private async handleSetCommand(params: string[]): Promise<void> {
    if (params.length < 3 || params[0] !== 'queue' || params[1] !== '--order') {
      console.log(`\n\u001b[33mUsage: set queue --order <reverse/random>\u001b[0m\n`);
      return;
    }

    const order = params[2];
    switch (order) {
      case 'reverse':
        this.queue.reverse();
        console.log(`\n\u001b[32m✓ Queue order reversed\u001b[0m\n`);
        break;
      case 'random':
        this.shuffleQueue();
        console.log(`\n\u001b[32m✓ Queue order randomized\u001b[0m\n`);
        break;
      default:
        console.log(`\n\u001b[33mUnknown order: ${order}. Use 'reverse' or 'random'\u001b[0m\n`);
    }
  }

  // возможность задать порядок сообщений по скрипту пользователя
  private async handleScriptCommand(params: string[]): Promise<void> {
    if (params.length === 0) {
        console.log('\n \u001b[33mUsage:\u001b[0m \u001b[32mscript\u001b[0m \u001b[35m<load <path> | run>\u001b[0m \n')
        return;
    }

    switch (params[0]) {
        case 'load':
            if (params.length < 2) {
                console.log('\n \u001b[33mPlease, specify script path\u001b[0m \n')
                return;
            }
            await this.loadScript(params[1]);
            break;
        case 'run':
            await this.runScript();
            break;
        default:
            console.log('\n \u001b[33mInvalid script command\u001b[0m \n')
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
        console.error(`
          \u001b[31m✖ File not found:\u001b[0m \u001b[33m${filePath}\u001b[0m
            `);
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
            console.error(`
              \u001b[31m✖ Invalid script format:\u001b[0m
              \u001b[36mScript must export function "modifyQueue(queue)"\u001b[0m
                  `);
            return;
        }
        this.scriptFn = module.exports.modifyQueue as (q: Message[]) => void;
        console.log(`
          \u001b[1;32m✓ Script loaded successfully!\u001b[0m
          \u001b[36mFile:\u001b[0m \u001b[33m${filePath}\u001b[0m
            `);
    } catch (err) {
      console.error(`
        \u001b[31m✖ Failed to load script\u001b[0m
        \u001b[33mError:\u001b[0m \u001b[37m${err instanceof Error ? err.message : String(err)}\u001b[0m
            `);
    }
  }

  // применяем скрипт к очереди
  private async runScript(): Promise<void> {
      if (!this.scriptFn) {
          console.error(`\n \u001b[31m✖ No script loaded – nothing to run\u001b[0m \n`);
          return;
      }
      await this.scriptFn(this.queue);
      console.log(`
        \u001b[1;32m✓ Script executed successfully!\u001b[0m
        \u001b[36mQueue modified:\u001b[0m \u001b[33m${this.queue.length}\u001b[0m messages
        `);
      this.showQueue();
  }

}

// Компиляция контракта
async function compileContract(contractPath: string): Promise<Cell> {
  console.log(`
    \u001b[36m╔════════════════════════════════════════════════════╗
    ║\u001b[1;34m          TON Contract Compilation Started          \u001b[0;36m║
    ╚════════════════════════════════════════════════════╝\u001b[0m
    `);

  const compileResult = await compileFunc({
    targets: [contractPath],
    sources: (x) => fs.readFileSync(x).toString("utf8"),
  });

  if (compileResult.status === "error") {
    console.error(`
      \u001b[1;31m✖ Compilation Failed\u001b[0m
    
      \u001b[33mCompiler output:\u001b[0m
      \u001b[37m${compileResult.message}\u001b[0m
        `);
    throw new Error("Compilation failed");
  }

  const codeCell = Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0];
  console.log(`
    \u001b[1;32m✓ Compilation successful!\u001b[0m
    `);
  
  if (!fs.existsSync('tmp')) {
    fs.mkdirSync('tmp');
    console.log('  \u001b[33m• Created tmp directory\u001b[0m');
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

  console.log(`
    \u001b[33mCompiled artifact saved to:\u001b[0m \u001b[36m${hexArtifact}\u001b[0m
    `);

  return codeCell;
}

// Начальное состояние
async function validateInitState(path: string): Promise<ContractState> {
  console.log(`
    \u001b[36m╔════════════════════════════════════════════════════╗
    ║\u001b[1;34m          Validating Contract Initial State         \u001b[0;36m║
    ╚════════════════════════════════════════════════════╝\u001b[0m
    `);

  const state = JSON.parse(fs.readFileSync(path, 'utf-8'));

  const validFields = ['balance', 'code', 'data'];
  const invalidFields = Object.keys(state).filter(
      key => !validFields.includes(key)
  );
      
  if (invalidFields.length > 0) {
     console.error(`
      \u001b[31m✖ Invalid fields detected:\u001b[0m \u001b[33m${invalidFields.join(', ')}\u001b[0m
      \u001b[36mAllowed fields:\u001b[0m \u001b[35mbalance\u001b[0m, \u001b[35mcode\u001b[0m, \u001b[35mdata\u001b[0m
          `);
      throw new Error(`Invalid fields in state file: ${invalidFields.join(', ')}`);
  }
      
  if (!state.balance && !state.code && !state.data) {
    console.error(`
      \u001b[31m✖ Empty state file\u001b[0m
      \u001b[36mState must contain at least one of:\u001b[0m
        \u001b[35mbalance\u001b[0m, \u001b[35mcode\u001b[0m or \u001b[35mdata\u001b[0m
          `);
    throw new Error('State file must contain at least one of: balance, code, data');
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

  console.log(`
    \u001b[1;32m✓ Initial state validation complete!\u001b[0m
      `);

  return resultState;
}

// Загружаем очередь сообщений для обработки в TON Debug Console
async function loadMessageQueue(path: string): Promise<Message[]> {
  console.log(`
    \u001b[36m╔════════════════════════════════════════════════════╗
    ║\u001b[1;34m              Loading Message Queue                 \u001b[0;36m║
    ╚════════════════════════════════════════════════════╝\u001b[0m
    `);
  try {
    if (!fs.existsSync(path)) {
      console.error(`
        \u001b[31m✖ Error:\u001b[0m File not found
        \u001b[36mPlease verify the path exists:\u001b[0m
        \u001b[33m${path}\u001b[0m
            `);
        throw new Error(`Queue file not found: ${path}`);
    }
    const messages = JSON.parse(fs.readFileSync(path, 'utf-8'));
    if (!Array.isArray(messages)) {
      console.error(`
        \u001b[31m✖ Invalid format:\u001b[0m
        \u001b[36mQueue file must contain an array of messages\u001b[0m
            `);
        throw new Error('Queue file must contain an array of messages');
    }
    const res =  messages.map((msg, i) => ({
        id: msg.id || i + 1,
        type: msg.type || 'internal',
        sender: setSender(msg),
        body: msg.body ? Cell.fromBoc(Buffer.from(msg.body, 'base64'))[0] : new Cell(),
        value: msg.value,
        name: msg.name
    }));
    console.log(`
      \u001b[1;32m✓ Message queue loaded successfully!\u001b[0m
        `);
    return res;
  } catch (err) {
    console.error(`
  \u001b[31m✖ Failed to load message queue:\u001b[0m \u001b[33m${err}\u001b[0m
    `);
    throw err;
  }
}

// загрузка скрипта на питоне для рандомизации типа сообщения (для эксперимента)
function getPythonScriptToGenerateMsgType(): boolean {
  const { execSync } = require('child_process');

  const result = execSync(`python3 tmp/shuffle_type_msg.py`).toString().trim();;
  if (result == 'True') {
    return true;
  }
  return false;
}

// генерация рандомной очереди для эксперимента и контракта contracts/race_condition_wallet.fc
function generateQueue(n1: number, n2: number): void {
    const messages: GeneratedMessage[] = [];
    let id = 1;

    // Генерация сообщений для Alice (senderId = 1)
    for (let i = 0; i < n1; i++) {
        const isEnlist = getPythonScriptToGenerateMsgType();
        const body = isEnlist ? "te6ccgEBAQEABgAACAAAAAE=" : "te6ccgEBAQEABgAACAAAAAI=";
        const value = "1000000000";
        const name = isEnlist ? "ENLIST Alice (1 TON)" : "CLAIM Alice";

        messages.push({
            id: id++,
            type: "internal",
            body: body,
            value: { coins: value, extraCurrencies: null },
            senderId: 1,
            name: name
        });
    }

    // Генерация сообщений для Bob (senderId = 2)
    for (let i = 0; i < n2; i++) {
        const isEnlist = getPythonScriptToGenerateMsgType();
        const body = isEnlist ? "te6ccgEBAQEABgAACAAAAAE=" : "te6ccgEBAQEABgAACAAAAAI=";
        const value = "1000000000";
        const name = isEnlist ? "ENLIST Bob (1 TON)" : "CLAIM Bob";

        messages.push({
            id: id++,
            type: "internal",
            body: body,
            value: { coins: value, extraCurrencies: null },
            senderId: 2,
            name: name
        });
    }

    // Сохранение в JSON-файл
    fs.writeFileSync('tmp/generated_queue.json', JSON.stringify(messages, null, 2));
    console.log(`Сообщения сохранены в файл tmp/generated_queue.json`);
}

function setSender(raw: any): Address {
    if (typeof raw?.senderId === "number" && SENDERS_LIST[raw.senderId]) {
      return SENDERS_LIST[raw.senderId];
    }
    if (typeof raw?.senderId === "number") {
      SENDERS_LIST[raw.senderId] = randomAddress();
      return SENDERS_LIST[raw.senderId];
    }

    return randomAddress();
}

async function main() {
  const args = process.argv.slice(2);
  
  // В начале работы выводим вспомогательное сообщение
  if (args.includes('--help') || args.length === 0) {
      printHelp();
      return;
  }

  const contractIndex = args.indexOf('--contract');
  if (contractIndex === -1 || contractIndex === args.length - 1) {
    console.error(`
      \u001b[31m╭──────────────────────────────────────────────╮
      \u001b[31m│ \u001b[1;31m✖ Error: Missing required argument           \u001b[0;31m│
      \u001b[31m╰──────────────────────────────────────────────╯\u001b[0m
    
      The \u001b[35m--contract\u001b[0m flag requires a path to your FunC file.
    
      \u001b[36mExample:\u001b[0m
        \u001b[32mtondebug\u001b[0m \u001b[35m--contract\u001b[0m \u001b[33m./contract.fc\u001b[0m
    
      Use \u001b[35m--help\u001b[0m for full usage information
      `);
      return;
  }

  // Если не удалось найти контракт
  const contractPath = args[contractIndex + 1];
  if (!fs.existsSync(contractPath)) {
    console.error(`
      \u001b[31m╭──────────────────────────────────────────────╮
      \u001b[31m│ \u001b[1;31m✖ Error: Contract file not found             \u001b[0;31m│
      \u001b[31m╰──────────────────────────────────────────────╯\u001b[0m
    
      Unable to find contract file at: \u001b[33m${contractPath}\u001b[0m
    `);
      return;
  }
  
  // Фиксируем начальное состояние и очередь
  const initStateIndex = args.indexOf('--init-state');
  const queueIndex = args.indexOf('--queue');
  const generateIndex = args.indexOf('--generate');


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

    // Генерируем очередь по заданным n1 и n2 (для эксперимента)
    if (generateIndex !== -1 && generateIndex < args.length - 2) {
      const n1 = parseInt(args[generateIndex + 1]);
      const n2 = parseInt(args[generateIndex + 2]);
      generateQueue(n1, n2);
      process.exit(0);
    }

    // Создаём консоль дебага
    const debugConsole = new TONDebugConsole(options, codeCell);
    await debugConsole.initialize();
  } catch (err) {
      console.error(err);
      process.exit(1);
  }
}

// Помощь
function printHelp(): void {
  console.log(`
    \u001b[36m╔════════════════════════════════════════════════════╗
    ║\u001b[1;34m               TON Debug Console                    \u001b[0;36m║
    ║\u001b[1;34m   Interactive debugger for TON smart contracts     \u001b[0;36m║
    ╚════════════════════════════════════════════════════╝\u001b[0m
    
    \u001b[33mUsage:\u001b[0m
      \u001b[32mtondebug\u001b[0m \u001b[35m--contract\u001b[0m \u001b[36m<path>\u001b[0m [\u001b[35m--init-state\u001b[0m \u001b[36m<path>\u001b[0m] [\u001b[35m--queue\u001b[0m \u001b[36m<path>\u001b[0m] [\u001b[35m--help\u001b[0m]
    
    \u001b[33mOptions:\u001b[0m
      \u001b[35m--contract\u001b[0m    \u001b[36m<path>\u001b[0m  \u001b[37mPath to FunC contract source file\u001b[0m
      \u001b[35m--init-state\u001b[0m  \u001b[36m<path>\u001b[0m  \u001b[37mPath to initial state JSON file\u001b[0m
      \u001b[35m--queue\u001b[0m       \u001b[36m<path>\u001b[0m  \u001b[37mPath to initial message queue JSON file\u001b[0m
      \u001b[35m--help\u001b[0m                \u001b[37mShow this help message\u001b[0m
    
    \u001b[33mExample:\u001b[0m
      \u001b[32mtondebug\u001b[0m \u001b[35m--contract\u001b[0m \u001b[36m./my-contract.fc\u001b[0m \u001b[35m--init-state\u001b[0m \u001b[36m./state.json\u001b[0m \u001b[35m--queue\u001b[0m \u001b[36m./messages.json\u001b[0m
    `);
}

main().catch(console.error);