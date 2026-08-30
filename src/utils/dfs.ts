/**
 * 查找节点树/图是否有循环引用
 * @param root 根节点
 * @param getId 可以获取到当前节点 id 的函数，应返回 id 字符串
 * @param getChildren 获取子节点数组的函数，返回节点数组或空
 * 
 * @returns 如果存在循环引用，返回形成环的节点数组（从父到子顺序，且首尾相同构成闭环）；如果没有循环引用，返回 null
 */
export function dfs<T>(
	root: T,
	getId: (node: T) => string,
	getChildren: (node: T) => T[] | void
): T[] | null {
	// 记录彻底搜索完毕且安全的节点 ID
	const visited = new Set<string>();

	// 记录当前 DFS 递归栈上的节点列表（用于追踪环的路径）
	const stack: T[] = [];
	// 记录当前 DFS 栈上节点的 ID -> 在 stack 中的索引, 方便 O(1) 
	const stackIndexMap = new Map<string, number>();

	function traverse(node: T): T[] | null {
		const id = getId(node);

		// 如果当前节点已经在当前的递归路径中，说明检测到了环
		if (stackIndexMap.has(id)) {
			const startIndex = stackIndexMap.get(id)!;
			// 截取从环入口节点开始到当前的路径，并将当前节点 Push 进尾部，形成完整的 A -> B -> C -> A 闭环
			const cyclePath = stack.slice(startIndex);
			cyclePath.push(node);
			return cyclePath;
		}

		// 如果该节点之前已经完整搜索过且无环，直接跳过
		if (visited.has(id)) {
			return null;
		}

		// 入栈：将当前节点压入递归路径
		stack.push(node);
		stackIndexMap.set(id, stack.length - 1);

		// 递归遍历所有子节点
		const children = getChildren(node) || [];
		for (const child of children) {
			const cycle = traverse(child);
			if (cycle) {
				return cycle; // 一旦在深层发现环，立即层层向上返回
			}
		}

		// 出栈与标记：当前节点及其子树搜索完毕，没有环
		stack.pop();
		stackIndexMap.delete(id);
		visited.add(id);

		return null;
	}

	return traverse(root);
}