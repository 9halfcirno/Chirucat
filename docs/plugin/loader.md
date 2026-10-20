# Chirucat插件加载器

本文会介绍Chirucat插件的基于**esbuild**的加载机制

具体代码在: [PluginLoader](../../src/plugin/loader.ts)

> 在阅读本文前, 你应该先稍微了解一下esbuild是什么:
>
> esbuild 是一个高性能的 JavaScript / CSS 打包工具, 支持将 JS/JSX, TS/TSX 转译为可直接执行的 JS 代码, 支持模块打包和依赖解析等功能

## 特点

Chirucat的插件系统在加载插件时与常见的基于 NodeJS 的插件系统不同

- **无缓存重载**: 每次启动插件都会重新编译插件的代码, 保证每次都拿到全新的插件模块

- **插件无模块缓存**: 得益于esbuild的功劳, 插件自身代码不经过运行时模块缓存

- **导入限制**: 加载器通过esbuild plugin, 拦截模块解析, 限制的部分node模块(如fs, worker)和跨目录的直接导入, 避免写出不可控/坏味道的代码, 当然该限制的绕过手段也很简单, 因为其并非安全沙箱

> 无模块缓存指插件的静态导入的自身代码, 一下情况均无法规避
> - 导入NPM包, 无论是否是静态导入
> - 导入Node原生模块, 无论是否是静态导入
> - 动态import, 该解释请见[Q&A](#qa)

## 支持的特性

- **支持热门JS方言开发**: esbuild默认支持编译ts/tsx/jsx等方言, 因此你可以放心使用你熟悉的方言开发

- **NPM项目**: 插件可以是一个完整的npm包, 加载器会以`package.json`为基准解析包标识

## 不被支持的特性

由于esbuild的局限性, 以下特性是无法使用的:

- `import.meta`: 在当前 iife 输出格式下，`import.meta` 不能按 ESM 语义使用，访问属性会得到 `undefined`

- 顶层await: 虽然你的插件是ESM, 理论支持顶层await, 但是esbuild打包时会编译失败,并报错`ERROR: Top-level await is currently not supported with the "iife" output format'`


## 加载流程

1. 插件管理器扫描到有效插件清单, 建立Plugin对象, 拼接插件根目录

2. 插件在启动前, 如果无已加载模块, 管理器会调用`PluginLoader.load`加载模块

3. 加载器加载插件时, 会通过`createRequire`创建属于插件的`require`对象, 作为插件运行时的外部模块加载器，用于解析 npm 包、受限 Node 模块以及动态导入

4. 加载器会将插件入口传入esbuild, 异步打包为单文件IIFE代码

5. 加载器通过`new Function(require, code)(prequire)`运行插件代码拿到导出的插件模块


## Q&A

Q: 为什么动态导入无法规避缓存?为什么npm包和node模块也没法?

A: 外部代码导入会被加载器标记为external, 将导入流程放在代码执行时, 因此也是动态导入, 在打包目标是iife, 平台是node的情况下, esbuild的动态导入支持是基于`require`实现的, 但是框架使用ESM编写, 要为iife提供require只能通过`createRequire`实现, 这就涉及到cjs的模块缓存了

**追问**

> Q: 为什么不能通过`delete require.cache[...]`来删除cjs缓存呢?
> 
> A: 这是一个nodejs的已知bug...使用`createRequire`创建的`require`对象无法通过这个方法释放缓存, 该bug导致使用它导入的模块的缓存和ESM缓存一样无法被释放

Q: 为什么插件代码中使用`await import("...")`会报错?

A: 既然使用了`import()`的ESM语法, 那么大概率是你的Node版本低于23, esbuild实现模块动态导入是基于`require`的, 而Node 23时才默认允许使用`require(esm)`的特性, 如果版本略低于Node 23, 可以尝试添加特定参数来启动Node