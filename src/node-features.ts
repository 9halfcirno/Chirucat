import type { FeatureRequirement } from "./node-check";
import { VerChecker } from "./utils/ver-check";

const features: FeatureRequirement[] = [
	{
		// v13 的 prebuilds 按 Node-API 10 编译(binding.gyp: NAPI_VERSION=10), Node-API 10 又要
		// Node 22.14.0+/23.6.0+。实测: 22.13.0 与 20.19.0 下 require 能过, 但 new Database()
		// 直接段错误退场, 连错误都拿不到。
		// 这条不是死门槛: 要留在旧 Node 就把依赖降回 12.x(其 engines 从 20.x 起支持)。
		name: "Node-API 10",
		desc: "无法打开数据库, 进程会直接崩溃",
		level: "error",
		minVersion: ["22.14.0", "23.6.0"],
		fixes: [
			{
				minVersion: "20.0.0",
				fix: [
					"把 better-sqlite3 从 13 降级为 12.x(engines: Node 20.x+), 并携带 --no-ver-check 参数启动框架",
				],
			},
		],
	},
	{
		// App 与 WebUI 各自的入口判定(if (import.meta.main))都靠它。
		// 实测 23.11.0 为 undefined(23 线从未实现), tsx 也不补齐(其 dist 里只有 import.meta.url),
		// 所以不满足时表现为"跑 npm run app 什么都不发生、也不报错"的静默失败。
		name: "import.meta.main",
		desc: "无法正常启动 App 或 WebUI 入口",
		level: "error",
		minVersion: ["22.18.0", "24.2.0"],
		// satisfies 表达不了"23 整条线都不行", 只能自己判
		test: (current) => current.startsWith("23.")
			? false
			: VerChecker.check(
				current,
				">=",
				VerChecker.check(current, ">=", "24.0.0") ? "24.2.0" : "22.18.0",
			),
	},
	{
		// 首次运行时会写配置/建数据目录, 缺了它 root 解析成 undefined。
		// 实测 20.16.0 已可用; 文档记录为 v20.11.0 / v21.2.0 起提供。
		// 注: 更低版本会在 import utils/root.ts 时就抛 TypeError, 这条警告来不及打印,
		// 列出来是为了说明"为什么 20.11 以下连报错都看不懂"。
		name: "import.meta.dirname",
		desc: "无法定位仓库根目录, 读写配置与数据目录的路径全部失效",
		level: "error",
		minVersion: ["20.11.0", "21.2.0"],
	},
	{
		// 插件由 esbuild 打成 iife 后用 new Function 注入 require 执行(loader.ts),
		// 标记为 external 的依赖是运行时 require 的, ESM-only 包因此需要 require(esm)。
		name: "require(esm)",
		desc: "依赖 ESM 包的插件在加载时会报错 ERR_REQUIRE_ESM",
		minVersion: ["22.12.0", "20.19.0"],
		// 实测 21.7.0 既没有特性也没有参数(仍是 ERR_REQUIRE_ESM), 而 satisfies 的多版本回退
		// 会把 21.x 按 ">= 20.19.0" 判成通过, 所以这条必须自己判
		test: (current) => current.startsWith("21.")
			? false
			: VerChecker.check(current, ">=", "22.12.0")
			|| (current.startsWith("20.") && VerChecker.check(current, ">=", "20.19.0")),
		fixes: [
			// --experimental-require-module 自身是 v22.0.0 / v20.17.0 才加的:
			// 实测 20.16.0 的 allowedNodeEnvironmentFlags 不含该参数, 20.17.0 起加参数才有效。
			{ minVersion: "22.0.0", fix: "尝试添加 --experimental-require-module 参数启动" },
			// 21 线介于两个"加入参数"的版本之间, 同样没有该参数, 单独挡一条。
			// 文案与 0.0.0 不同: 这里给的是"跨线升级到最近的 LTS 门槛", 0.0.0 是最终兜底。
			{
				minVersion: "21.0.0",
				fix: [
					"在 Node 22 内升级到 Node v22.12.0 及以上",
					"在 Node 20 内升级到 Node v20.19.0 及以上",
				],
			},
			// 与 22.0.0 文案相同, 但覆盖的是 Node 20 线, 不能合并:
			// 中间隔着 21.0.0 规则, 合并会让 20.17–20.18 命中错误分支。
			{ minVersion: "20.17.0", fix: "尝试添加 --experimental-require-module 参数启动" },
		],
	},
	{
		// helpers/plugin-github-helper.ts 抓 manifest 与 release 文件用的都是全局 fetch。
		name: "全局 fetch",
		desc: "部分需要从网络获取内容的功能或插件会报错",
		minVersion: "18.0.0",
		fixes: [
			// 原 17.5.0 与 16.15.0 两条 fix 文案相同, 且 16.15.0 的 ">=" 已覆盖 17.x,
			// 17.5.0 永远命不中, 合并为一条。
			{ minVersion: "16.15.0", fix: "尝试添加 --experimental-fetch 参数启动" },
		],
	},
	{
		// utils/uuid.ts 三级回退里前两级都靠全局 crypto; 缺失时不会报错,
		// 而是安静地用 Math.random 生成 ID —— 属于"看起来正常"的降级, 值得单独提示。
		name: "全局 crypto (WebCrypto)",
		desc: "crypto不可用, 无法生成安全的随机UUID",
		minVersion: "19.0.0",
		fixes: [
			// 同 fetch: 原 17.6.0 与 16.15.0 文案相同, 16.15.0 已覆盖 17.x, 合并。
			{ minVersion: "16.15.0", fix: "尝试添加 --experimental-global-webcrypto 参数启动" },
		],
	},
];

export { features }