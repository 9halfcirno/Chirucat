import json5 from "json5";
import type { PluginManifest } from "../plugin/types";
import { ValidationError } from "../errors/validation-error";
import type { PluginHelper } from "./types";

const GITHUB_BASE_URL = "https://api.github.com"
const buildUrl = (owner: string, repo: string, path: string) => `${GITHUB_BASE_URL}/repos/${owner}/${repo}/contents/${path}`

/**
 * 考虑到Github的API速率限制, 等什么时候找找其他方案再写PluginHelper吧
 */


export class PluginGithubHelper implements PluginHelper {
	async download(url: string | URL) {
		typeof url === "string" && (url = new URL(url));
		// 先拉取manifest.json
		let manifest = json5.parse(await fetch(url.pathname + "manifest.json").then(r => r.json())) as PluginManifest;

		let lost = checkProp(["id", "main", "version"], manifest);
		if (lost !== true) {
			throw new ValidationError(`插件清单缺少必要字段`, lost.join(", "), `${url.pathname}/manifest.json`)
		}


	}
}

function checkProp<T>(props: (keyof T)[], obj: T) {
	let lost: (keyof T)[] = [];
	for (let prop of props) {
		if (!(obj[prop] && obj[prop] === undefined)) {
			lost.push(prop);
		}
	}
	if (lost.length > 0) return lost;
	return true;
}

async function downloadAllFiles(
	owner: string,
	repo: string,
	dirPath: string,
	token?: string
): Promise<{ content: Buffer; path: string }[]> {
	// 去除路径首尾的斜杠，防止 URL 拼接异常
	const cleanPath = dirPath.replace(/^\/+|\/+$/g, '');

	const headers: HeadersInit = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'TypeScript-Downloader',
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;

	const response = await fetch(url, { headers });

	if (!response.ok) {
		throw new Error(
			`GitHub API 请求失败 (${response.status}): ${response.statusText}\nURL: ${url}`
		);
	}

	const data = await response.json();

	// ---------- 情况 1：路径指向的是单个文件 ----------
	if (!Array.isArray(data)) {
		if (data.type === 'file' && data.content) {
			return [
				{
					content: Buffer.from(data.content, 'base64'),
					path: data.path,
				},
			];
		}
		// 如果是符号链接或子模块，忽略或可根据需求处理
		return [];
	}

	// ---------- 情况 2：路径指向的是目录（返回数组） ----------
	const allFiles: { content: Buffer; path: string }[] = [];
	const subDirPromises: Promise<{ content: Buffer; path: string }[]>[] = [];

	for (const item of data) {
		if (item.type === 'file') {
			// 大部分情况下 content 字段会存在，若缺失则尝试用 download_url 兜底（很少发生）
			if (item.content) {
				allFiles.push({
					content: Buffer.from(item.content, 'base64'),
					path: item.path,
				});
			} else if (item.download_url) {
				// 兜底方案：通过 download_url 单独下载原始内容（会增加一次网络请求）
				const fileRes = await fetch(item.download_url);
				const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
				allFiles.push({
					content: fileBuffer,
					path: item.path,
				});
			}
		} else if (item.type === 'dir') {
			// 递归获取子目录
			subDirPromises.push(downloadAllFiles(owner, repo, item.path, token));
		}
	}

	// 并行等待所有子目录的结果，提升下载效率
	const nestedResults = await Promise.all(subDirPromises);
	for (const result of nestedResults) {
		allFiles.push(...result);
	}

	return allFiles;
  }

interface GitHubContentItem {
	name: string;
	path: string;
	type: 'file' | 'dir' | 'symlink' | 'submodule';
	content?: string;        // Base64 编码的内容
	encoding?: string;       // 通常是 "base64"
	download_url?: string | null;
	size: number;
  }