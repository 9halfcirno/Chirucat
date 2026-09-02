# 插件普通上下文

该上下文为基本上下文, 其他类型上下文均继承自该上下文, 该上下文提供了插件最基本的功能, 其他类型上下文在此基础上扩展了更多功能

该上下文提供了以下能力

- [消息处理](#消息处理)
  - [普通回调](#message对象)
  - [指令回调](#command对象)
- [持久化存储](#持久化存储)
  - [KV存储](#kv对象)
  - [文件系统存储](#fs对象)

## 消息处理

### message对象

该对象用于注册消息回调, 插件可以通过该对象注册不同类型的消息回调函数, 以便在特定条件下触发相应的处理逻辑。

该对象有以下方法:

| 方法 | 第一参数 | 描述 |
| --- | --- | --- |
| `all`| 消息处理函数 | 注册一个全量消息回调, 该回调会在接收到任何消息时触发, 适用于需要处理所有消息的插件。 |
| `start` | 消息前缀(string) | 注册一个以指定前缀开头的消息回调, 该回调会在接收到以指定前缀开头的消息时触发 |
| `end` | 消息后缀(string) | 注册一个以指定后缀结尾的消息回调, 该回调会在接收到以指定后缀结尾的消息时触发 |
| `include` | 消息包含(string) | 注册一个包含指定字符串的消息回调, 该回调会在接收到包含指定字符串的消息时触发 |
| `full` | 消息完全匹配(string) | 注册一个完全匹配指定字符串的消息回调, 该回调会在接收到完全匹配指定字符串的消息时触发 |
| `regex` | 正则表达式(RegExp) | 注册一个匹配指定正则表达式的消息回调, 该回调会在接收到匹配指定正则表达式的消息时触发 |
| `match` | 消息断言函数(返回boolean) | 注册一个自定义消息匹配回调, 该回调会在接收到任何消息时触发, 并将消息传入回调函数, 回调函数返回true则触发该回调, 返回false则不触发 |

除`all`方法外, 其他方法的第二个参数均为消息处理函数

消息处理函数: `(msg: Message) => void` ([Message指路](../../objects/message.md))

### command对象

该对象用于注册指令回调, 插件可以通过该对象注册框架级指令处理

该对象有以下方法:

- `register(command: string, handler: (msg: Message | null, args: (string | number)[]) => void)`: 注册一个指令回调, 当指令触发时, 会触发该回调函数, 并将指令参数传入回调函数, 指令名支持携带空格

- `unregister(command: Command)`: 注销一个指令回调

- `exec: (message: Message | string, args?: (string | number)[])`: 触发一个指令
  - 若第一个参数为string, 则将第二个参数作为指令参数传入, 同时目标指令回调的第一个参数会为null
  - 若第一个参数为Message, 则忽略第二个参数, 解析Message对象

指令回调函数: `(msg: Message | null, args: (string | number)[])` ([Message指路](../../objects/message.md), [Command指路](../../objects/command.md))

## 持久化存储

该上下文提供了两种数据存储方式: KV存储和文件存储, 插件可以根据需要选择合适的存储方式来保存和读取数据。

### kv对象

该存储方式自动序列化/反序列化JSON对象, 因此可以当作数据Only的简易Map对象

下列方法均为同步方法

- `init()`: 初始化kv存储, 需显式调用
- `get(key: string, defaultValue?: any): any`: 获取指定键的值, 如果键不存在则返回默认值
- `set(key: string, value: any)`: 设置指定键的值
- `delete(key: string)`: 删除指定键的值
- `has(key: string)`: 检查指定键是否存在
- `clear()`: 清空所有键值对
- `keys(): string[]`: 获取所有键, 返回一个数组
- `entries(): [string, any][]`: 获取所有键值对, 返回一个二维数组, 每个元素为一个键值对数组

### fs对象

该存储方式提供了简易的文件系统读写, 以存放大数据

下列方法均为异步方法

- `read(file: string, encoding?: string): Promise<string>`: 读取文件
- `write(file: string, data: string | NodeJS.ArrayBufferView)`: 向指定文件写入数据
- `append(file: string, data: string | NodeJS.ArrayBufferView)`: 向指定文件末尾追加数据
- `exists(file: string): Promise<boolean>`: 判断指定路径上的文件是否存在
- `list(dir: string): Promise<string[]>`: 列出指定目录的所有文件/目录
- `stat(file: string): : Promise<fs.Stats>`: 获取指定文件的属性