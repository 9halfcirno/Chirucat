// 发送端：url 与 buffer 互斥
type MediaSend =
	| { url: string; buffer?: never }
	| { buffer: NodeJS.ArrayBufferView; url?: never };

type ReceiveVariants = {
	text: { text: string };
	mention: { id: string; name?: string };
	image: { url: string };
	audio: { url: string };
	video: { url: string };
};

type SendVariants = {
	text: { text: string };
	mention: { id: string };
	image: MediaSend;
	audio: MediaSend;
	video: MediaSend;
};

type ToBlocks<V> = {
	[K in keyof V]: { type: K } & V[K];
}[keyof V];

export type MessageBlockReceive = ToBlocks<ReceiveVariants>;
export type MessageBlockSend = ToBlocks<SendVariants>;