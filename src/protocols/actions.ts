import type { MessageDelete } from "./action/message-delete";
import type { MessageSend, MessageSendResponse } from "./action/message-send";

export type BotActions =
	| MessageSend
	| MessageDelete

export type ActionPayloads = {
	"message.send": {
		id: string;
		token?: string;
	};
	"message.delete": {}; 
};

export interface ActionFailureResponse {
	success: false;
	error: string; // 失败时的错误描述消息
	code?: number | string; // 可选的错误码
}

export type ActionSuccessResponse<K extends BotActions["type"]> = {
	success: true;
} & ActionPayloads[K];

export type ActionResponses = {
	[K in BotActions["type"]]: ActionSuccessResponse<K> | ActionFailureResponse;
};