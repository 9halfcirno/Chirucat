/// <reference types="node" />

/* ================================================================ *
 * 类型定义
 * ================================================================ */

export type OptionType = 'boolean' | 'string' | 'number' | 'json';

export interface OptionDef {
  type?: OptionType;
  alias?: string | readonly string[];
  key?: string;
  default?: unknown;
  multiple?: boolean;
  required?: boolean;
  choices?: readonly unknown[];
  desc?: string;
  description?: string;
}

export type Schema = Record<string, OptionDef | OptionType>;

export interface UnknownArg {
  type: 'long' | 'short';
  name: string;
  value?: string | undefined;
  raw: string;
}

export interface ParseResult<V> {
  values: V;
  positionals: string[];
  unknown: UnknownArg[];
  warnings: string[];
}

export interface ParserOptions {
  /** 未知参数 / 重复参数时的回调，默认 console.warn */
  onWarn?: (message: string) => void;
}

export interface NormalizedDef {
  key: string;
  name: string;
  names: string[];
  aliases: string[];
  type: OptionType;
  multiple: boolean;
  required: boolean;
  choices?: readonly unknown[] | undefined;
  default: unknown;
  desc: string;
}

export class ArgParseError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARG_PARSE_ERROR') {
    super(message);
    this.name = 'ArgParseError';
    this.code = code;
  }
}

/* ================================================================ *
 * 类型推导：Schema -> values 类型
 * ================================================================ */

type CamelCase<S extends string> = S extends `${infer Head}-${infer Rest}`
  ? `${Head}${Capitalize<CamelCase<Rest>>}`
  : S;

type OutputKey<K extends string, D> = D extends { key: infer KK extends string }
  ? KK
  : CamelCase<K>;

type DefType<D> = D extends { type: infer T extends OptionType }
  ? T
  : D extends OptionType
  ? D
  : 'string';

type ValueOfType<T extends OptionType> = T extends 'boolean'
  ? boolean
  : T extends 'number'
  ? number
  : T extends 'json'
  ? unknown
  : string;

type ElementTypeOf<D> = ValueOfType<DefType<D>>;

type ValueOf<D> = D extends { multiple: true }
  ? ElementTypeOf<D>[]
  : ElementTypeOf<D>;

type IsAlwaysDefined<D> = D extends { required: true }
  ? true
  : D extends { type: 'boolean' }
  ? true
  : D extends 'boolean'
  ? true
  : D extends { default: unknown }
  ? true
  : false;

type OutputValue<D> = IsAlwaysDefined<D> extends true
  ? ValueOf<D>
  : ValueOf<D> | undefined;

/** 由 schema 推导出的 values 类型 */
export type ValuesOf<S extends Schema> = {
  [K in keyof S & string as OutputKey<K, S[K]>]: OutputValue<S[K]>;
};

/* ================================================================ *
 * 工具函数
 * ================================================================ */

const TYPES: readonly OptionType[] = ['boolean', 'string', 'number', 'json'];

const TRUTHY = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY = new Set(['false', '0', 'no', 'n', 'off']);

const kebabToCamel = (s: string): string =>
  s.replace(/-+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());

const camelToKebab = (s: string): string =>
  s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

function parseBool(raw: string, name: string): boolean {
  const s = String(raw).trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  throw new ArgParseError(
    `选项 --${name} 需要布尔值（true/false），收到 "${raw}"`,
    'INVALID_BOOLEAN'
  );
}

/* ================================================================ *
 * 规范化 schema
 * ================================================================ */

function normalize(schema: Schema): NormalizedDef[] {
  const defs: NormalizedDef[] = [];

  for (const [rawName, rawDef] of Object.entries(schema)) {
    const def: OptionDef =
      typeof rawDef === 'string' ? { type: rawDef } : rawDef;

    const type: OptionType = def.type ?? 'string';
    if (!TYPES.includes(type)) {
      throw new Error(
        `选项 "${rawName}" 的类型 "${type}" 不支持，可选：${TYPES.join(' / ')}`
      );
    }

    const aliasRaw = def.alias;
    const aliases: string[] =
      aliasRaw == null
        ? []
        : typeof aliasRaw === 'string'
        ? [aliasRaw]
        : [...(aliasRaw as readonly string[])].map(String);

    // 同时接受 --dry-run 和 --dryRun
    const names = new Set([rawName, kebabToCamel(rawName), camelToKebab(rawName)]);

    const key = def.key || kebabToCamel(rawName);
    const defaultValue =
      def.default !== undefined
        ? def.default
        : type === 'boolean'
        ? false
        : undefined;

    defs.push({
      key,
      name: rawName,
      names: [...names],
      aliases,
      type,
      multiple: !!def.multiple,
      required: !!def.required,
      choices: def.choices,
      default: defaultValue,
      desc: def.desc ?? def.description ?? '',
    });
  }

  return defs;
}

/* ================================================================ *
 * 解析器
 * ================================================================ */

export interface Parser<S extends Schema> {
  parse(argv?: readonly string[]): ParseResult<ValuesOf<S>>;
  help(programName?: string): string;
  readonly options: readonly NormalizedDef[];
}

export function createParser<S extends Schema>(
  schema: S,
  options: ParserOptions = {}
): Parser<S> {
  const defs = normalize(schema);

  const byName = new Map<string, NormalizedDef>();
  const byAlias = new Map<string, NormalizedDef>();

  for (const d of defs) {
    for (const n of d.names) {
      if (byName.has(n)) throw new Error(`选项名重复：--${n}`);
      byName.set(n, d);
    }
    for (const a of d.aliases) {
      if (byAlias.has(a)) throw new Error(`别名重复：-${a}`);
      byAlias.set(a, d);
    }
  }

  const onWarn =
    options.onWarn !== undefined
      ? options.onWarn
      : (msg: string) => console.warn(msg);

  function parse(argv: readonly string[] = process.argv.slice(2)): ParseResult<ValuesOf<S>> {
    const values: Record<string, unknown> = {};
    const positionals: string[] = [];
    const unknown: UnknownArg[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    // 初始值
    for (const d of defs) {
      if (d.multiple) {
        values[d.key] = Array.isArray(d.default)
          ? [...(d.default as unknown[])]
          : d.default !== undefined
          ? [d.default]
          : [];
      } else {
        values[d.key] = d.default;
      }
    }

    const warn = (msg: string): void => {
      warnings.push(msg);
      onWarn(msg);
    };

    const coerce = (d: NormalizedDef, raw: string): unknown => {
      switch (d.type) {
        case 'number': {
          const n = Number(raw);
          if (String(raw).trim() === '' || !Number.isFinite(n)) {
            throw new ArgParseError(
              `选项 --${d.name} 需要数字，收到 "${raw}"`,
              'INVALID_NUMBER'
            );
          }
          return n;
        }
        case 'json': {
          try {
            return JSON.parse(raw) as unknown;
          } catch (e) {
            throw new ArgParseError(
              `选项 --${d.name} 需要合法 JSON：${(e as Error).message}`,
              'INVALID_JSON'
            );
          }
        }
        case 'boolean':
          return parseBool(raw, d.name);
        default:
          return raw;
      }
    };

    const apply = (d: NormalizedDef, value: unknown): void => {
      if (d.choices && !d.choices.some((c) => c === value)) {
        throw new ArgParseError(
          `选项 --${d.name} 的值 "${String(value)}" 无效，可选值：${d.choices.join(', ')}`,
          'INVALID_CHOICE'
        );
      }
      if (seen.has(d.key) && !d.multiple) {
        warn(`选项 --${d.name} 被重复指定，使用最后一次的值`);
      }
      seen.add(d.key);

      if (d.multiple) {
        const arr = values[d.key];
        if (Array.isArray(arr)) arr.push(value);
        else values[d.key] = [value];
      } else {
        values[d.key] = value;
      }
    };

    let i = 0;

    const takeNext = (d: NormalizedDef, token: string): string => {
      const next = argv[i + 1];
      const negativeNumber =
        d.type === 'number' && next !== undefined && /^-\d/.test(next);
      if (next === undefined || (next.startsWith('-') && next !== '-' && !negativeNumber)) {
        throw new ArgParseError(`选项 ${token} 缺少值`, 'MISSING_VALUE');
      }
      i++;
      return next;
    };

    let onlyPositionals = false;

    while (i < argv.length) {
      const arg = argv[i];
      if (arg === undefined) break;

      if (onlyPositionals) {
        positionals.push(arg);
        i++;
        continue;
      }

      if (arg === '--') {
        onlyPositionals = true;
        i++;
        continue;
      }

      if (arg === '-' || !arg.startsWith('-')) {
        positionals.push(arg);
        i++;
        continue;
      }

      /* ---------- 长选项 ---------- */
      if (arg.startsWith('--')) {
        let body = arg.slice(2);
        let inline: string | undefined;
        let hasInline = false;

        const eq = body.indexOf('=');
        if (eq !== -1) {
          inline = body.slice(eq + 1);
          body = body.slice(0, eq);
          hasInline = true;
        }

        // --no-xxx 取反
        if (!hasInline && body.startsWith('no-')) {
          const restName = body.slice(3);
          const target = byName.get(restName) ?? byName.get(kebabToCamel(restName));
          if (target && target.type === 'boolean') {
            apply(target, false);
            i++;
            continue;
          }
        }

        const d = byName.get(body);
        if (!d) {
          unknown.push({
            type: 'long',
            name: body,
            value: hasInline ? inline : undefined,
            raw: arg,
          });
          warn(`未知选项：--${body}`);
          i++;
          continue;
        }

        let value: unknown;
        if (d.type === 'boolean') {
          value = hasInline ? parseBool(inline as string, d.name) : true;
        } else {
          value = coerce(d, hasInline ? (inline as string) : takeNext(d, arg));
        }
        apply(d, value);
        i++;
        continue;
      }

      /* ---------- 短选项（可合并） ---------- */
      const body = arg.slice(1);
      let j = 0;

      while (j < body.length) {
        const ch = body.charAt(j);
        const d = byAlias.get(ch);

        if (!d) {
          unknown.push({ type: 'short', name: ch, raw: '-' + ch });
          // warn(`未知选项：-${ch}`);
          j++;
          continue;
        }

        if (d.type === 'boolean') {
          apply(d, true);
          j++;
          continue;
        }

        // 需要值：吃掉剩余字符，或取下一个 token
        const rest = body.slice(j + 1);
        const raw = rest
          ? rest.startsWith('=')
            ? rest.slice(1)
            : rest
          : takeNext(d, '-' + ch);

        apply(d, coerce(d, raw));
        j = body.length; // 剩余字符已作为值消费
      }

      i++;
    }

    // 必填校验
    for (const d of defs) {
      if (d.required && !seen.has(d.key)) {
        throw new ArgParseError(`缺少必填选项：--${d.name}`, 'MISSING_REQUIRED');
      }
    }

    return {
      values: values as unknown as ValuesOf<S>,
      positionals,
      unknown,
      warnings,
    };
  }

  function help(programName = 'program'): string {
    const lines = [`Usage: ${programName} [options] [--] [args...]`];

    if (defs.length) {
      const rows = defs.map((d) => {
        const left = [
          d.aliases.length ? d.aliases.map((a) => `-${a}`).join(', ') : '    ',
          `--${d.name}` +
            (d.type === 'boolean' ? '' : ` <${d.type}>`) +
            (d.multiple ? '...' : ''),
        ].join(' ');

        const meta: string[] = [];
        if (d.required) meta.push('必填');
        if (d.choices) meta.push(`可选：${d.choices.join('|')}`);
        if (d.type === 'boolean') {
          if (d.default === true) meta.push('默认：true');
        } else if (d.default !== undefined && !d.multiple) {
          meta.push(`默认：${JSON.stringify(d.default)}`);
        }

        let desc = d.desc;
        if (meta.length) desc += (desc ? ' ' : '') + `(${meta.join('; ')})`;

        return { left, desc };
      });

      const width = Math.max(...rows.map((r) => r.left.length), 0);

      lines.push('', 'Options:');
      for (const r of rows) {
        lines.push(`  ${r.left.padEnd(width)}  ${r.desc}`.trimEnd());
      }
    }

    return lines.join('\n');
  }

  return { parse, help, options: defs };
}

/** 便捷函数：一次性解析 */
export function parseArgs<S extends Schema>(
  schema: S,
  argv: readonly string[] = process.argv.slice(2),
  options?: ParserOptions
): ParseResult<ValuesOf<S>> {
  return createParser(schema, options).parse(argv);
}