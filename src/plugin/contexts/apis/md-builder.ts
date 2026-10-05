/** 回调式构建器签名 */
type BuilderFn = (b: MDBuilder) => void;

/**
 * Markdown AST 流式构建器。
 *
 * - 每个方法都会把节点挂到"当前父节点"上；
 * - 传 `fn` 的容器方法会自动闭合，无需手动 end()；
 * - 不传 `fn` 时节点保持打开，可通过后续 `.end()` 手动闭合；
 * - 所有方法都返回 `this`，支持链式调用。
 *
 * @example
 * const md = new MDBuilder();
 * md.heading(1, h => h.text('Hello'))
 *   .paragraph(p => p
 *     .text('Hello ')
 *     .strong(s => s.text('world'))
 *     .text('!')
 *     .ext({ flavor: 'gfm', kind: 'mention', user: 'alice' })
 *   )
 *   .list({ ordered: true }, l => l
 *     .listItem(i => i.paragraph(p => p.text('one')))
 *     .listItem(i => i.paragraph(p => p.text('two')))
 *   );
 * const root: Root = md.root;
 */
export class MDBuilder {
	private _root: Root;
	private _stack: MdParent[];

	constructor(root?: Root) {
		this._root = root ?? { type: 'root', children: [] };
		this._stack = [this._root];
	}

	/* ================= 状态访问 ================= */

	/** 获取构建完成的根节点 */
	get root(): Root {
		return this._root;
	}

	/** 当前正在编辑的父节点 */
	private get head(): MdParent {
		// 栈初始为 [root]，只要按接口调用永远非空
		return this._stack[this._stack.length - 1]!;
	}
	
	/** 已进入嵌套的深度（root 为 1） */
	get depth(): number {
		return this._stack.length;
	}

	/* ================= 内部工具 ================= */

	private append(node: MdNode): this {
		(this.head.children as MdNode[]).push(node);
		return this;
	}

	private open(node: MdParent): this {
		(this.head.children as MdNode[]).push(node);
		this._stack.push(node);
		return this;
	}

	/**
	 * 打开容器 → 可选执行回调 → 回退到打开前的栈深度。
	 * 若未传 fn，则保持打开，等待后续 end()。
	 */
	private withBlock<N extends MdParent>(node: N, fn?: BuilderFn): this {
		this.open(node);
		if (!fn) return this;

		const targetDepth = this._stack.length - 1;
		fn(this);
		if (this._stack.length > targetDepth) {
			this._stack.length = targetDepth;
		}
		return this;
	}

	/** 结束当前容器，返回上一层（根节点不会被弹出） */
	end(): this {
		if (this._stack.length > 1) this._stack.pop();
		return this;
	}

	/* ================= 块级节点 ================= */

	paragraph(fn?: BuilderFn): this {
		const node: Paragraph = { type: 'paragraph', children: [] };
		return this.withBlock(node, fn);
	}

	heading(depth: HeadingDepth, fn?: BuilderFn): this {
		const node: Heading = { type: 'heading', depth, children: [] };
		return this.withBlock(node, fn);
	}

	thematicBreak(): this {
		return this.append({ type: 'thematicBreak' });
	}

	blockquote(fn?: BuilderFn): this {
		const node: Blockquote = { type: 'blockquote', children: [] };
		return this.withBlock(node, fn);
	}

	code(value: string, lang?: string, meta?: string): this {
		const node: Code = { type: 'code', value };
		if (lang !== undefined) node.lang = lang;
		if (meta !== undefined) node.meta = meta;
		return this.append(node);
	}

	html(value: string): this {
		return this.append({ type: 'html', value });
	}

	definition(identifier: string, url: string, title?: string | null): this {
		const node: Definition = { type: 'definition', identifier, url };
		if (title !== undefined) node.title = title;
		return this.append(node);
	}

	footnoteDefinition(identifier: string, fn?: BuilderFn): this {
		const node: FootnoteDefinition = {
			type: 'footnoteDefinition',
			identifier,
			children: [],
		};
		return this.withBlock(node, fn);
	}

	/* ================= 列表 ================= */

	list(
		options?: { ordered?: boolean; start?: number; spread?: boolean },
		fn?: BuilderFn,
	): this {
		const node: List = {
			type: 'list',
			ordered: options?.ordered ?? false,
			children: [],
		};
		if (options?.start !== undefined) node.start = options.start;
		if (options?.spread !== undefined) node.spread = options.spread;
		return this.withBlock(node, fn);
	}

	listItem(
		options?: { checked?: boolean | null; spread?: boolean },
		fn?: BuilderFn,
	): this {
		const node: ListItem = { type: 'listItem', children: [] };
		if (options?.checked !== undefined) node.checked = options.checked;
		if (options?.spread !== undefined) node.spread = options.spread;
		return this.withBlock(node, fn);
	}

	/* ================= 表格 ================= */

	table(align?: AlignType[], fn?: BuilderFn): this {
		const node: Table = { type: 'table', children: [] };
		if (align !== undefined) node.align = align;
		return this.withBlock(node, fn);
	}

	tableRow(fn?: BuilderFn): this {
		const node: TableRow = { type: 'tableRow', children: [] };
		return this.withBlock(node, fn);
	}

	tableCell(fn?: BuilderFn): this {
		const node: TableCell = { type: 'tableCell', children: [] };
		return this.withBlock(node, fn);
	}

	/* ================= 行内节点 ================= */

	text(value: string): this {
		return this.append({ type: 'text', value });
	}

	emphasis(fn?: BuilderFn): this {
		const node: Emphasis = { type: 'emphasis', children: [] };
		return this.withBlock(node, fn);
	}

	strong(fn?: BuilderFn): this {
		const node: Strong = { type: 'strong', children: [] };
		return this.withBlock(node, fn);
	}

	delete(fn?: BuilderFn): this {
		const node: Delete = { type: 'delete', children: [] };
		return this.withBlock(node, fn);
	}

	inlineCode(value: string): this {
		return this.append({ type: 'inlineCode', value });
	}

	break(): this {
		return this.append({ type: 'break' });
	}

	link(url: string, title?: string | null, fn?: BuilderFn): this {
		const node: Link = { type: 'link', url, children: [] };
		if (title !== undefined) node.title = title;
		return this.withBlock(node, fn);
	}

	image(url: string, alt?: string | null, title?: string | null): this {
		const node: Image = { type: 'image', url };
		if (alt !== undefined) node.alt = alt;
		if (title !== undefined) node.title = title;
		return this.append(node);
	}

	linkReference(
		identifier: string,
		referenceType: ReferenceType = 'full',
		fn?: BuilderFn,
	): this {
		const node: LinkReference = {
			type: 'linkReference',
			identifier,
			referenceType,
			children: [],
		};
		return this.withBlock(node, fn);
	}

	imageReference(
		identifier: string,
		referenceType: ReferenceType = 'full',
		alt?: string | null,
	): this {
		const node: ImageReference = {
			type: 'imageReference',
			identifier,
			referenceType,
		};
		if (alt !== undefined) node.alt = alt;
		return this.append(node);
	}

	footnoteReference(identifier: string): this {
		return this.append({ type: 'footnoteReference', identifier });
	}

	/* ================= 扩展节点 ================= */

	/**
	 * 通用扩展行内节点。
	 * 用 `attrs` 承载具体方言的语义，宿主可据此再做二次解析/渲染。
	 *
	 * @example
	 *   md.ext({ flavor: 'gfm',  kind: 'mention', user: 'alice' })
	 *   md.ext({ flavor: 'djot', kind: 'span',    lang: 'en'   })
	 */
	ext(attrs: { [k: string]: string }): this {
		const node: Ext = { type: 'ext', attrs: { ...attrs } };
		return this.append(node);
	}
}
/* ================================================================== *
 *  0. 基础结构
 * ================================================================== */

/** 源码中的一个点；line/column 从 1 开始，offset 从 0 开始 */
export interface Point {
	line: number;
	column: number;
	offset?: number;
}

/** 节点在源码中的位置，半开区间 [start, end) */
export interface Position {
	start: Point;
	end: Point;
}

/** 所有节点共有的字段 */
export interface MdNodeBase {
	/** 判别符（discriminant），用来做类型收窄 */
	type: string;
	/** 位置信息，解析器可选提供 */
	position?: Position;
	/** 自定义数据挂载点 */
	data?: Record<string, unknown>;
}

/* ================================================================== *
 *  1. 节点联合类型
 * ================================================================== */

export type MdNode =
	// 根
	| Root
	// 块级
	| Paragraph
	| Heading
	| ThematicBreak
	| Blockquote
	| List
	| ListItem
	| Code
	| Definition
	| FootnoteDefinition
	| Table
	| TableRow
	| TableCell
	// 行内
	| Text
	| Emphasis
	| Strong
	| Delete
	| InlineCode
	| Break
	| Link
	| Image
	| LinkReference
	| ImageReference
	| FootnoteReference
	// 两者皆可
	| Html
	| Ext;

/* ================================================================== *
 *  2. 容器 / 字面量 分类
 * ================================================================== */

/** 带 children 的节点（容器节点） */
export type MdParent =
	| Root
	| Paragraph
	| Heading
	| Blockquote
	| List
	| ListItem
	| FootnoteDefinition
	| Table
	| TableRow
	| TableCell
	| Emphasis
	| Strong
	| Delete
	| Link
	| LinkReference;
/** 带 value 的叶子节点 */
export type MdLiteral = Extract<MdNode, { value: string }>;

export function isParent(node: MdNode): node is MdParent {
	return Array.isArray((node as Partial<MdParent>).children);
}

export function isLiteral(node: MdNode): node is MdLiteral {
	return typeof (node as Partial<MdLiteral>).value === 'string';
}

/* ================================================================== *
 *  3. 内容分类（用于约束 children 的合法类型）
 * ================================================================== */

/** 行内内容 */
export type PhrasingContent =
	| Text
	| Emphasis
	| Strong
	| Delete
	| InlineCode
	| Break
	| Link
	| Image
	| LinkReference
	| ImageReference
	| FootnoteReference
	| Html
	| Ext;

/** 块级内容 */
export type BlockContent =
	| Paragraph
	| Heading
	| ThematicBreak
	| Blockquote
	| List
	| Code
	| Definition
	| FootnoteDefinition
	| Table
	| Html;

/** 根节点的直接子节点 */
export type RootContent = BlockContent;

/* ================================================================== *
 *  4. 根节点
 * ================================================================== */

export interface Root extends MdNodeBase {
	type: 'root';
	children: RootContent[];
}

/* ================================================================== *
 *  5. 块级节点
 * ================================================================== */

export interface Paragraph extends MdNodeBase {
	type: 'paragraph';
	children: PhrasingContent[];
}

export type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface Heading extends MdNodeBase {
	type: 'heading';
	/** 标题层级，对应 # ~ ###### */
	depth: HeadingDepth;
	children: PhrasingContent[];
}

/** --- / *** / ___ 分隔线 */
export interface ThematicBreak extends MdNodeBase {
	type: 'thematicBreak';
}

/** > 引用块 */
export interface Blockquote extends MdNodeBase {
	type: 'blockquote';
	children: BlockContent[];
}

/** 有序 / 无序列表 */
export interface List extends MdNodeBase {
	type: 'list';
	/** 是否有序 */
	ordered: boolean;
	/** 有序列表的起始序号，默认 1 */
	start?: number;
	/** 列表项之间是否有空行（loose list） */
	spread?: boolean;
	children: ListItem[];
}

export interface ListItem extends MdNodeBase {
	type: 'listItem';
	/** GFM 任务列表：true 已勾选 / false 未勾选 / null 或 undefined 非任务项 */
	checked?: boolean | null;
	spread?: boolean;
	children: BlockContent[];
}

/** ```lang 代码块 */
export interface Code extends MdNodeBase {
	type: 'code';
	/** 语言标识 */
	lang?: string;
	/** lang 之后的附加信息 */
	meta?: string;
	value: string;
}

/** 链接引用定义：[label]: https://example.com "title" */
export interface Definition extends MdNodeBase {
	type: 'definition';
	/** 归一化后的标识符 */
	identifier: string;
	/** 原始 label 文本 */
	label?: string;
	url: string;
	title?: string | null;
}

/** 脚注定义：[^1]: 内容 */
export interface FootnoteDefinition extends MdNodeBase {
	type: 'footnoteDefinition';
	identifier: string;
	label?: string;
	children: BlockContent[];
}

/** 裸 HTML（块级或行内） */
export interface Html extends MdNodeBase {
	type: 'html';
	value: string;
}

/* ================================================================== *
 *  6. 行内节点
 * ================================================================== */

export interface Text extends MdNodeBase {
	type: 'text';
	value: string;
}

/** *斜体* */
export interface Emphasis extends MdNodeBase {
	type: 'emphasis';
	children: PhrasingContent[];
}

/** **加粗** */
export interface Strong extends MdNodeBase {
	type: 'strong';
	children: PhrasingContent[];
}

/** ~~删除线~~ (GFM) */
export interface Delete extends MdNodeBase {
	type: 'delete';
	children: PhrasingContent[];
}

/** `code` */
export interface InlineCode extends MdNodeBase {
	type: 'inlineCode';
	value: string;
}

/** 硬换行（行尾两个空格或反斜杠） */
export interface Break extends MdNodeBase {
	type: 'break';
}

/** [文本](url "title") */
export interface Link extends MdNodeBase {
	type: 'link';
	url: string;
	title?: string | null;
	children: PhrasingContent[];
}

/** ![alt](url "title") */
export interface Image extends MdNodeBase {
	type: 'image';
	url: string;
	alt?: string | null;
	title?: string | null;
}

/** 引用式链接的三种写法 */
export type ReferenceType = 'shortcut' | 'collapsed' | 'full';

/** [文本][ref] */
export interface LinkReference extends MdNodeBase {
	type: 'linkReference';
	identifier: string;
	label?: string;
	referenceType: ReferenceType;
	children: PhrasingContent[];
}

/** ![alt][ref] */
export interface ImageReference extends MdNodeBase {
	type: 'imageReference';
	identifier: string;
	label?: string;
	referenceType: ReferenceType;
	alt?: string | null;
}

/** 脚注引用：[^1] */
export interface FootnoteReference extends MdNodeBase {
	type: 'footnoteReference';
	identifier: string;
	label?: string;
}

/** 通用扩展行内节点，携带任意字符串键值对，用于承载不同 md 方言/语法 */
export interface Ext extends MdNodeBase {
	type: 'ext';
	/**
	 * 扩展参数，例如：
	 *   { flavor: 'gfm', kind: 'mention', user: 'alice' }
	 *   { flavor: 'commonmark+djot', kind: 'callout', level: 'info' }
	 */
	attrs: { [k: string]: string };
}

/* ================================================================== *
 *  7. GFM 表格
 * ================================================================== */

export type AlignType = 'left' | 'right' | 'center' | null;

export interface Table extends MdNodeBase {
	type: 'table';
	/** 每一列的对齐方式 */
	align?: AlignType[];
	children: TableRow[];
}

export interface TableRow extends MdNodeBase {
	type: 'tableRow';
	children: TableCell[];
}

export interface TableCell extends MdNodeBase {
	type: 'tableCell';
	children: PhrasingContent[];
}

/* ================================================================== *
 *  8. 工具类型 & 辅助函数
 * ================================================================== */

/** 按 type 取出具体节点类型：NodeOfType<'heading'> === Heading */
export type NodeOfType<T extends MdNode['type']> = Extract<MdNode, { type: T }>;

/** 访问器：可以只处理某几种节点 */
export type Visitor<T extends MdNode['type']> = (
	node: NodeOfType<T>,
	parent: MdParent | undefined,
	index: number | undefined,
) => void;

/** 便于在 switch 里做穷尽性检查 */
export function assertNever(value: never): never {
	throw new Error(`Unexpected node: ${JSON.stringify(value)}`);
}
