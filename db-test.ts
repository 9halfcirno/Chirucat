import { UserManager } from "./src/user-manager"; // 替换为你的实际文件名

function runTests() {
	console.log("🐱 开始测试 UserManager...\n");

	// 使用内存数据库 :memory: 进行测试，不会留下真实数据库文件
	const um = new UserManager(":memory:");
	um.init();

	const u1 = um.get("qq", "1223456");
	console.log(u1);
	
	console.log(um.get("qq", "1223456"));

	const u2 = um.get("dc", "asd");
	console.log(u2);

	um.bind(u1, "dc", "asd");
	console.log(um.get("dc", "asd"));
}

runTests();